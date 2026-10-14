import { PostureMonitor, measurePose } from './posture.js';

const $ = id => document.getElementById(id);
const camera = $('camera'), canvas = $('overlay'), alertVideo = $('alert-video');
const start = $('start'), calibrate = $('calibrate');
const context = canvas.getContext('2d');
let monitor, worker, stream, audioContext, alertAudio, audioSource;
let running = false, busy = false, generation = 0, lastFrame = -1, frameTime = 0;
let timer, watchdog, loadingWorker;
let playbackGeneration = 0, playbackPending = false;

function status(label, message, state = '') {
  $('state').textContent = label;
  $('state').dataset.state = state;
  if ($('message').textContent !== message) $('message').textContent = message;
}

function stopAlert() {
  playbackGeneration++;
  playbackPending = false;
  if (audioSource) { audioSource.stop(); audioSource = null; }
  alertVideo.pause();
  alertVideo.currentTime = 0;
  alertVideo.hidden = true;
}

async function playAlert() {
  if (playbackPending || audioSource || !alertVideo.paused) return;
  const request = playbackGeneration;
  playbackPending = true;
  try {
    await audioContext.resume();
    if (!running || request !== playbackGeneration) return;
    if (alertAudio) {
      const source = audioContext.createBufferSource();
      source.buffer = alertAudio;
      // Loop on the audio clock, without waiting for the next camera frame.
      source.loop = true;
      source.connect(audioContext.destination);
      source.onended = () => { if (audioSource === source) audioSource = null; };
      audioSource = source;
      source.start();
    }
    if (alertVideo.videoWidth > 0) {
      alertVideo.loop = true;
      alertVideo.currentTime = 0;
      alertVideo.hidden = false;
      await alertVideo.play();
    }
  } catch (error) {
    if (request === playbackGeneration) fail(`Could not play the alert. ${error.message}`);
  } finally {
    if (request === playbackGeneration) playbackPending = false;
  }
}
alertVideo.onended = () => { alertVideo.hidden = true; };

function stop() {
  running = false;
  generation++;
  clearInterval(timer);
  clearInterval(watchdog);
  stream?.getTracks().forEach(track => track.stop());
  stream = null;
  camera.srcObject = null;
  context.clearRect(0, 0, canvas.width, canvas.height);
  $('placeholder').hidden = false;
  calibrate.hidden = true;
  start.textContent = 'Start';
  start.disabled = false;
  monitor?.resetTracking();
  stopAlert();
}

function fail(message) {
  stop();
  status('Error', message, 'error');
}

function loadWorker() {
  if (loadingWorker) return loadingWorker;
  loadingWorker = new Promise((resolve, reject) => {
    worker = new Worker('/pose-worker.js', { type: 'module' });
    const timeout = setTimeout(() => {
      worker.terminate(); loadingWorker = null;
      reject(new Error('Model loading timed out. Reload this page to try again.'));
    }, 45000);
    worker.onerror = event => {
      clearTimeout(timeout); loadingWorker = null; worker.terminate();
      reject(new Error(event.message || 'Could not load the pose model.'));
      if (running) fail('Pose tracking stopped. Reload this page to try again.');
    };
    worker.onmessage = ({ data }) => {
      if (data.type === 'ready') { clearTimeout(timeout); resolve(); }
      else if (data.type === 'error') {
        clearTimeout(timeout); worker.terminate(); loadingWorker = null;
        reject(new Error(data.message));
        if (running) fail(`Pose tracking failed: ${data.message}`);
      } else if (data.type === 'pose') {
        if (!running || data.generation !== generation) return;
        busy = false;
        frameTime = performance.now();
        const pose = measurePose(data.landmarks, camera.videoWidth / camera.videoHeight);
        const update = monitor.update(pose, data.time / 1000);
        draw(pose ? data.landmarks : null, update.state);
        renderUpdate(update);
        if (update.alert) playAlert();
        else stopAlert();
      }
    };
    worker.postMessage({ type: 'init' });
  });
  return loadingWorker;
}

function renderUpdate(update) {
  switch (update.state) {
    case 'not-visible': status('Find posture', 'Keep your head and both shoulders in view.'); break;
    case 'calibrating': status('Calibrating', `Sit upright and hold still · ${update.seconds}`); break;
    case 'upright': status('Upright', 'Monitoring your posture.', 'upright'); break;
    case 'slouching': status('Slouching', 'Sit straight.', 'slouching'); break;
    default: status('Ready', 'Sit upright, then recalibrate.');
  }
}

function draw(points, state) {
  canvas.width = camera.videoWidth;
  canvas.height = camera.videoHeight;
  context.clearRect(0, 0, canvas.width, canvas.height);
  if (!points) return;
  const [nose, left, right] = [points[0], points[11], points[12]];
  const neck = { x: (left.x + right.x) / 2, y: (left.y + right.y) / 2 };
  context.strokeStyle = state === 'slouching' ? '#e3a16f' : '#d2eee4';
  context.fillStyle = context.strokeStyle;
  context.lineWidth = 2;
  for (const [a, b] of [[left, right], [neck, nose]]) {
    context.beginPath(); context.moveTo(a.x * canvas.width, a.y * canvas.height);
    context.lineTo(b.x * canvas.width, b.y * canvas.height); context.stroke();
  }
  for (const p of [left, right, nose]) {
    context.beginPath(); context.arc(p.x * canvas.width, p.y * canvas.height, 4, 0, Math.PI * 2); context.fill();
  }
}

async function tick() {
  if (!running) return;
  const currentGeneration = generation;
  try {
    if (!busy && camera.readyState >= 2 && camera.currentTime !== lastFrame) {
      busy = true;
      lastFrame = camera.currentTime;
      const frame = await createImageBitmap(camera);
      if (!running || currentGeneration !== generation) { frame.close(); return; }
      worker.postMessage({ type: 'frame', frame, time: performance.now(), generation }, [frame]);
    }
  } catch (error) { busy = false; fail(`Camera processing failed: ${error.message}`); return; }
}

start.onclick = async () => {
  if (running) { stop(); status('Off', 'Sit upright with your head and shoulders in view.'); return; }
  start.disabled = true;
  status('Starting', 'Allow camera access, then sit upright.');
  try {
    // Resume on the actual click, before awaiting camera permission or the model.
    audioContext ??= new AudioContext();
    await audioContext.resume();
    await loadWorker();
    if (!alertAudio) {
      const response = await fetch('/alert');
      if (!response.ok) throw new Error('Could not load your alert file.');
      try { alertAudio = await audioContext.decodeAudioData(await response.arrayBuffer()); }
      catch {
        if (!alertVideo.videoWidth) throw new Error('This browser cannot decode the alert. Try an MP4, MP3, or WAV file.');
      }
    }
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false, video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user', frameRate: { ideal: 15, max: 24 } }
    });
    camera.srcObject = stream;
    await camera.play();
    stream.getVideoTracks()[0].onended = () => fail('Camera disconnected. Reconnect it and press Start.');
    running = true;
    generation++;
    busy = false;
    lastFrame = -1;
    frameTime = performance.now();
    monitor.calibrate();
    $('placeholder').hidden = true;
    start.textContent = 'Stop';
    start.disabled = false;
    calibrate.hidden = false;
    status('Calibrating', 'Sit upright and hold still · 3');
    timer = setInterval(tick, 125);
    tick();
    watchdog = setInterval(() => {
      const stalled = performance.now() - frameTime;
      if (stalled > 15000) {
        worker.terminate(); loadingWorker = null; busy = false;
        fail('Camera or model stopped responding. Press Start to try again.'); return;
      }
      if (stalled > 2000) { monitor.update(null, performance.now() / 1000); stopAlert(); status('Waiting', 'Waiting for your camera…'); }
    }, 1000);
  } catch (error) {
    const message = error.name === 'NotAllowedError' ? 'Camera access is blocked. Allow it in your browser, then press Start.'
      : error.name === 'NotFoundError' ? 'No camera found. Connect one and press Start.'
      : error.name === 'NotReadableError' ? 'Camera is busy. Close other camera apps and press Start.' : error.message;
    fail(message);
  }
};

calibrate.onclick = () => {
  generation++;
  busy = false;
  monitor.calibrate();
  stopAlert();
  status('Calibrating', 'Sit upright and hold still · 3');
};
window.addEventListener('pagehide', stop);

try {
  const response = await fetch('/config');
  if (!response.ok) throw new Error('Could not load settings.');
  monitor = new PostureMonitor(await response.json());
  alertVideo.src = '/alert';
  alertVideo.preload = 'auto';
  await loadWorker();
  start.disabled = false;
  status('Off', 'Sit upright with your head and shoulders in view.');
} catch (error) {
  start.disabled = true;
  status('Error', `${error.message} Run npm run setup, then reload.`, 'error');
}
