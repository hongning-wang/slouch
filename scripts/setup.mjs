import { access, mkdir, rename, writeFile } from 'node:fs/promises';
const destination = new URL('../public/model.task', import.meta.url);
try { await access(destination); console.log('Pose model already downloaded.'); }
catch {
  console.log('Downloading MediaPipe Pose Landmarker Lite…');
  const response = await fetch('https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task');
  if (!response.ok) throw new Error(`Model download failed: ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length < 1_000_000) throw new Error('Model download is incomplete.');
  await mkdir(new URL('../public/', import.meta.url), { recursive: true });
  const temporary = new URL('../public/model.task.tmp', import.meta.url);
  await writeFile(temporary, bytes);
  await rename(temporary, destination);
  console.log('Model ready. Camera processing runs locally.');
}
