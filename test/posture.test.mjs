import test from 'node:test';
import assert from 'node:assert/strict';
import { PostureMonitor, measurePose } from '../public/posture.js';

const good = { height: 0.6, forward: 0.3 };
const bad = { height: 0.25, forward: 0.3 };
function calibrated() {
  const monitor = new PostureMonitor();
  monitor.calibrate();
  for (let t = 0; t <= 3.2; t += 0.1) monitor.update(good, t);
  assert.ok(monitor.baseline);
  return monitor;
}
test('calibration needs continuous, stable visible posture', () => {
  const monitor = new PostureMonitor();
  monitor.calibrate();
  for (let t = 0; t < 2; t += 0.1) monitor.update(good, t);
  monitor.update(null, 2);
  assert.equal(monitor.update(good, 2.1).state, 'calibrating');
  assert.equal(monitor.baseline, null);
  for (let i = 0; i < 40; i++) monitor.update(i % 2 ? good : bad, 2.2 + i * 0.1);
  assert.equal(monitor.baseline, null);
});
test('upright posture and brief slouches do not alert', () => {
  const monitor = calibrated();
  for (let t = 4; t < 10; t += 0.1) assert.equal(monitor.update(good, t).alert, false);
  for (let t = 10; t < 12; t += 0.1) assert.equal(monitor.update(bad, t).alert, false);
  for (let t = 12; t < 15; t += 0.1) assert.equal(monitor.update(good, t).alert, false);
});
test('sustained slouch keeps requesting playback until posture recovers', () => {
  const monitor = calibrated();
  const alerts = [];
  for (let t = 4; t < 30; t += 0.1) if (monitor.update(bad, t).alert) alerts.push(t);
  assert.ok(alerts.length > 200);
  assert.ok(alerts[0] >= 7);
  assert.ok(alerts.at(-1) > 29.8);
  for (let t = 30; t < 32; t += 0.1) monitor.update(good, t);
  assert.equal(monitor.update(good, 32).alert, false);
  // A second slouch starts a fresh hold, with no leftover cooldown.
  assert.equal(monitor.update(bad, 32.1).alert, false);
  for (let t = 32.2; t < 37; t += 0.1) monitor.update(bad, t);
  assert.equal(monitor.update(bad, 37).alert, true);
  assert.equal(monitor.update(null, 37.1).alert, true);
  assert.equal(monitor.update(null, 39.1).alert, false);
});
test('active reminders survive intermittent missing or upright readings', () => {
  const monitor = calibrated();
  for (let t = 4; t <= 8; t += 0.1) monitor.update(bad, t);
  assert.equal(monitor.update(bad, 8.1).alert, true);
  // A dropped frame used to stop audio and restart the entire hold period.
  for (let i = 0; i < 60; i++) {
    const pose = i % 3 === 0 ? null : i % 7 === 0 ? good : bad;
    assert.equal(monitor.update(pose, 8.2 + i * 0.1).alert, true);
  }
  for (let t = 14.2; t <= 17; t += 0.1) monitor.update(good, t);
  assert.equal(monitor.update(good, 17.1).alert, false);
});
test('lost tracking and stalled frames reset the slouch timer', () => {
  for (const lost of [true, false]) {
    const monitor = calibrated();
    for (let t = 4; t < 6; t += 0.1) monitor.update(bad, t);
    if (lost) monitor.update(null, 6);
    assert.equal(monitor.update(bad, 20).alert, false);
    assert.equal(monitor.update(bad, 20.1).alert, false);
  }
});
test('forward head displacement also triggers', () => {
  const monitor = calibrated();
  let alerted = false;
  for (let t = 4; t < 10; t += 0.1) alerted ||= monitor.update({ height: 0.6, forward: 0.9 }, t).alert;
  assert.ok(alerted);
});
test('landmark measurement rejects low confidence and is scale invariant', () => {
  const points = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.4, z: 0, visibility: 1 }));
  points[0] = { x: 0.5, y: 0.2, z: -0.1, visibility: 1 };
  points[11].x = 0.3; points[12].x = 0.7;
  const original = measurePose(points);
  const scaled = points.map(p => ({ ...p, x: (p.x - 0.5) * 1.2 + 0.5, y: p.y * 1.2, z: p.z * 1.2 }));
  assert.ok(Math.abs(original.height - measurePose(scaled).height) < 1e-10);
  assert.ok(Math.abs(original.forward - measurePose(scaled).forward) < 1e-10);
  points[0].visibility = 0.1;
  assert.equal(measurePose(points), null);
});
