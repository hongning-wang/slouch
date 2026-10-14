import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
const fixture = (await readFile(new URL('./pose.jpg', import.meta.url))).toString('base64');

async function cameraFixture(page) {
  await page.addInitScript(image => {
    window.audioStarts = 0;
    window.activeAudio = new Set();
    window.maxActiveAudio = 0;
    window.poseSamples = [];
    const NativeWorker = Worker;
    window.Worker = class extends NativeWorker {
      constructor(...args) {
        super(...args);
        this.addEventListener('message', ({ data }) => {
          if (data.type === 'pose') window.poseSamples.push(data);
        });
      }
    };
    const originalStart = AudioBufferSourceNode.prototype.start;
    const originalStop = AudioBufferSourceNode.prototype.stop;
    AudioBufferSourceNode.prototype.start = function(...args) {
      window.audioStarts++;
      window.lastAudioSource = this;
      window.audioStartedAt = this.context.currentTime;
      const analyser = this.context.createAnalyser();
      this.connect(analyser);
      const samples = new Float32Array(analyser.fftSize);
      const amplitudes = [];
      window.audioAmplitudes = amplitudes;
      const sampleTimer = setInterval(() => {
        analyser.getFloatTimeDomainData(samples);
        amplitudes.push({ elapsed: this.context.currentTime - window.audioStartedAt,
          peak: Math.max(...samples.map(Math.abs)) });
      }, 25);
      this.addEventListener('ended', () => clearInterval(sampleTimer));
      window.activeAudio.add(this);
      window.maxActiveAudio = Math.max(window.maxActiveAudio, window.activeAudio.size);
      this.addEventListener('ended', () => window.activeAudio.delete(this));
      return originalStart.apply(this, args);
    };
    AudioBufferSourceNode.prototype.stop = function(...args) {
      window.activeAudio.delete(this);
      return originalStop.apply(this, args);
    };
    navigator.mediaDevices.getUserMedia = async () => {
      const photo = new Image(); photo.src = `data:image/jpeg;base64,${image}`;
      await photo.decode();
      const canvas = document.createElement('canvas');
      canvas.width = 640; canvas.height = 480;
      const ctx = canvas.getContext('2d');
      window.fixtureMode = 'upright';
      setInterval(() => {
        ctx.fillStyle = '#e9eef2'; ctx.fillRect(0, 0, 640, 480);
        if (window.fixtureMode !== 'absent') ctx.drawImage(photo, 180, 120, 620, 500, 0, 0, 640, 480);
        // Move the head down relative to unchanged shoulders. This synthetic
        // fixture tests the measurement path, not classification accuracy.
        if (window.fixtureMode === 'slouch') {
          ctx.drawImage(photo, 330, 230, 100, 105, 264, 105, 103, 101);
          ctx.drawImage(photo, 435, 230, 110, 105, 263, 160, 114, 101);
        }
      }, 60);
      window.fixtureStream = canvas.captureStream(15);
      return window.fixtureStream;
    };
  }, fixture);
}

async function expectContinuousAudio(page) {
  // The same source must remain playing beyond two complete clip durations.
  // Frame-by-frame restarts or a one-shot source cannot satisfy this check.
  await expect.poll(() => page.evaluate(() => {
    const source = window.lastAudioSource;
    return source && source.context.currentTime - window.audioStartedAt > source.buffer.duration * 2;
  }), { timeout: 12000 }).toBe(true);
  expect(await page.evaluate(() => ({
    starts: window.audioStarts, active: window.activeAudio.size,
    looping: window.lastAudioSource.loop, state: window.lastAudioSource.context.state
  }))).toEqual({ starts: 1, active: 1, looping: true, state: 'running' });
  // Verify real non-silent PCM after the first clip has finished, not just a
  // loop flag or a source-start counter. This also works with the supplied MP4.
  expect(await page.evaluate(() => window.audioAmplitudes.some(sample =>
    sample.elapsed > window.lastAudioSource.buffer.duration && sample.peak > 0.001))).toBe(true);
}

test('real model loops audio continuously, stops upright, and alerts for a new slouch', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await cameraFixture(page);
  await page.goto(process.env.SLOUCH_TEST_URL || '/');
  await expect(page.getByRole('button', { name: 'Start', exact: true })).toBeEnabled({ timeout: 30000 });
  await page.screenshot({ path: 'test-results/idle.png' });
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(page.locator('#state')).toHaveText('Upright', { timeout: 15000 });
  expect(await page.evaluate(() => window.audioStarts)).toBe(0);
  await page.screenshot({ path: 'test-results/tracking.png' });
  await page.evaluate(() => { window.fixtureMode = 'slouch'; });
  try { await expect.poll(() => page.evaluate(() => window.audioStarts), { timeout: 15000 }).toBe(1); }
  catch (error) {
    console.log(await page.evaluate(async () => {
      const { measurePose } = await import('/posture.js');
      return window.poseSamples.slice(-10).map(p => ({ time: p.time, pose: measurePose(p.landmarks) }));
    }));
    throw error;
  }
  await expectContinuousAudio(page);
  await page.screenshot({ path: 'test-results/slouch.png' });
  await expect(page.locator('#message')).toHaveText('Sit straight.');
  await page.evaluate(() => { window.fixtureMode = 'upright'; });
  await expect(page.locator('#state')).toHaveText('Upright', { timeout: 10000 });
  expect(await page.evaluate(() => window.activeAudio.size)).toBe(0);
  const previousStarts = await page.evaluate(() => window.audioStarts);
  await page.waitForTimeout(700);
  expect(await page.evaluate(() => window.audioStarts)).toBe(previousStarts);
  await page.evaluate(() => { window.fixtureMode = 'slouch'; });
  await expect.poll(() => page.evaluate(() => window.audioStarts), { timeout: 15000 }).toBeGreaterThan(previousStarts);
  await page.evaluate(() => { window.fixtureMode = 'absent'; });
  await expect(page.locator('#state')).toHaveText('Find posture');
  expect(await page.evaluate(() => window.activeAudio.size)).toBe(0);
  expect(await page.evaluate(() => window.maxActiveAudio)).toBe(1);
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  expect(await page.evaluate(() => window.fixtureStream.getTracks()[0].readyState)).toBe('ended');
  await expect(page.locator('#state')).toHaveText('Off');
  expect(errors).toEqual([]);
});

test('camera denial explains how to retry, and narrow screens fit', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('Denied', 'NotAllowedError'); };
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Start', exact: true }).click({ timeout: 30000 });
  await expect(page.locator('#message')).toContainText('Camera access is blocked');
  await expect(page.getByRole('button', { name: 'Start', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/denied-mobile.png' });
});

test('video reminders repeat without overlap and stop when upright', async ({ page }) => {
  await cameraFixture(page);
  await page.goto('http://localhost:5175');
  await page.getByRole('button', { name: 'Start', exact: true }).click({ timeout: 30000 });
  await expect(page.locator('#state')).toHaveText('Upright', { timeout: 15000 });
  await page.evaluate(() => { window.fixtureMode = 'slouch'; });
  await expect(page.locator('#alert-video')).toBeVisible({ timeout: 15000 });
  expect(await page.evaluate(() => window.audioStarts)).toBeGreaterThanOrEqual(1);
  expect(await page.locator('#alert-video').evaluate(video => video.videoWidth)).toBe(160);
  await expectContinuousAudio(page);
  expect(await page.locator('#alert-video').evaluate(video => video.loop && !video.paused)).toBe(true);
  await page.evaluate(() => { window.fixtureMode = 'upright'; });
  await expect(page.locator('#state')).toHaveText('Upright', { timeout: 10000 });
  await expect(page.locator('#alert-video')).toBeHidden();
  expect(await page.locator('#alert-video').evaluate(video => video.paused)).toBe(true);
  expect(await page.evaluate(() => window.activeAudio.size)).toBe(0);
  expect(await page.evaluate(() => window.maxActiveAudio)).toBe(1);
  await page.getByRole('button', { name: 'Recalibrate' }).click();
  await expect(page.locator('#state')).toHaveText('Calibrating');
  await expect(page.locator('#state')).toHaveText('Upright', { timeout: 10000 });
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
});

test('active audio survives intermittent tracking loss and a hidden tab', async ({ page }) => {
  await cameraFixture(page);
  // Deterministic landmarks exercise dropouts without changing the audio path.
  await page.route('**/pose-worker.js', route => route.fulfill({ contentType: 'text/javascript', body: `
    self.onmessage = ({ data }) => {
      if (data.type === 'init') { self.postMessage({ type: 'ready' }); return; }
      const points = Array.from({ length: 33 }, () => ({ x: .5, y: .55, z: 0, visibility: 1 }));
      points[11].x = .3; points[12].x = .7;
      points[0].y = data.time < 4500 ? .2 : .5;
      const missing = data.time > 8500 && Math.floor(data.time / 125) % 3 === 0;
      self.postMessage({ type: 'pose', landmarks: missing ? undefined : points, time: data.time, generation: data.generation });
      data.frame.close();
    };` }));
  await page.goto('/');
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.audioStarts), { timeout: 15000 }).toBe(1);
  // Reproduce visibilitychange without relying on headless-window focus rules.
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(3000);
  await expectContinuousAudio(page);
  await expect(page.locator('#state')).toHaveText('Slouching');
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  expect(await page.evaluate(() => window.activeAudio.size)).toBe(0);
});

test('alert endpoint supports ranges and does not expose other local files', async ({ request }) => {
  const range = await request.get('/alert', { headers: { Range: 'bytes=0-15' } });
  expect(range.status()).toBe(206);
  expect((await range.body()).length).toBe(16);
  expect((await request.get('/alert', { headers: { Range: 'bytes=999999999-' } })).status()).toBe(416);
  expect((await request.get('/server.mjs')).status()).toBe(404);
  expect((await request.get('/alert', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status()).toBe(403);
});
