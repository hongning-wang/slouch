import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat, access } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = fileURLToPath(new URL('.', import.meta.url));
const help = 'Usage: npm start -- --video /path/to/alert.mp4 [--port 5173] [--threshold 0.18] [--hold 3]';
let values;
try {
  ({ values } = parseArgs({ options: {
    video: { type: 'string' }, port: { type: 'string', default: '5173' },
    threshold: { type: 'string', default: '0.18' }, hold: { type: 'string', default: '3' },
    help: { type: 'boolean' }
  }}));
  if (values.help) { console.log(help); process.exit(0); }
  if (!values.video) throw new Error('--video is required.');
  values.video = resolve(values.video);
  if (!(await stat(values.video)).isFile()) throw new Error('--video must point to a file.');
  await access(resolve(root, 'public/model.task'));
  for (const key of ['port', 'threshold', 'hold']) {
    values[key] = Number(values[key]);
    if (!Number.isFinite(values[key]) || values[key] <= 0) throw new Error(`--${key} must be a positive number.`);
  }
  if (!Number.isInteger(values.port) || values.port > 65535) throw new Error('Invalid port.');
} catch (error) {
  console.error(`${error.message}\n${help}\nRun npm install && npm run setup before starting.`);
  process.exit(1);
}

const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.wasm': 'application/wasm', '.mp4': 'video/mp4', '.m4a': 'audio/mp4', '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav', '.webm': 'video/webm', '.ogg': 'audio/ogg', '.mov': 'video/quicktime' };
const publicFiles = new Set(['index.html', 'style.css', 'app.js', 'posture.js', 'pose-worker.js', 'model.task']);
const server = http.createServer(async (req, res) => {
  try {
    // Only the local app can read the selected file. Never expose arbitrary paths.
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405).end(); return; }
    if (![`127.0.0.1:${values.port}`, `localhost:${values.port}`].includes(req.headers.host)
        || req.headers['sec-fetch-site'] === 'cross-site') { res.writeHead(403).end(); return; }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Cache-Control', 'no-cache');
    const path = new URL(req.url, 'http://localhost').pathname;
    if (path === '/config') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
        threshold: values.threshold, hold: values.hold
      })); return;
    }
    let file;
    if (path === '/alert') file = values.video;
    else if (path === '/vendor/vision_bundle.mjs') file = resolve(root, 'node_modules/@mediapipe/tasks-vision/vision_bundle.mjs');
    else if (/^\/vendor\/wasm\/[a-z0-9_]+\.(js|wasm)$/.test(path)) file = resolve(root, 'node_modules/@mediapipe/tasks-vision', path.slice('/vendor/'.length));
    else {
      const name = path === '/' ? 'index.html' : path.slice(1);
      if (!publicFiles.has(name)) { res.writeHead(404).end('Not found'); return; }
      file = resolve(root, 'public', name);
    }
    const { size } = await stat(file);
    let start = 0, end = size - 1, status = 200;
    if (req.headers.range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
      if (!match || (!match[1] && !match[2])) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end(); return; }
      start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
      end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
      if (start > end || start >= size) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end(); return; }
      status = 206;
      res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
    }
    res.writeHead(status, { 'Content-Type': types[extname(file)] || 'application/octet-stream',
      'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 });
    if (req.method === 'HEAD') { res.end(); return; }
    const stream = createReadStream(file, { start, end });
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  } catch (error) {
    if (!res.headersSent) res.writeHead(error.code === 'ENOENT' ? 404 : 500);
    res.end('Unable to load file.');
  }
});
server.on('error', error => { console.error(error.message); process.exitCode = 1; });
server.listen(values.port, '127.0.0.1', () => console.log(`Slouch → http://localhost:${values.port}\nAlert: ${values.video}\nCtrl+C to stop.`));
