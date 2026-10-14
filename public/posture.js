// Distances are normalized by shoulder width, so moving closer to the camera
// does not itself trigger a reminder. Image coordinates have y pointing down.
export function measurePose(landmarks, aspect = 4 / 3) {
  if (!landmarks) return null;
  const [nose, left, right] = [landmarks[0], landmarks[11], landmarks[12]];
  if (![nose, left, right].every(p => p && (p.visibility ?? 0) >= 0.65
      && [p.x, p.y, p.z].every(Number.isFinite) && p.x > 0 && p.x < 1 && p.y > 0 && p.y < 1)) return null;
  const width = Math.hypot((left.x - right.x) * aspect, left.y - right.y);
  if (width < 0.12 || Math.abs(left.y - right.y) > width * 0.45) return null;
  return {
    height: ((left.y + right.y) / 2 - nose.y) / width,
    forward: ((left.z + right.z) / 2 - nose.z) * aspect / width
  };
}

const median = values => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
export class PostureMonitor {
  constructor({ threshold = 0.18, hold = 3 } = {}) {
    Object.assign(this, { threshold, hold });
    this.baseline = null;
    this.resetTracking();
  }
  calibrate() {
    this.baseline = null;
    this.samples = [];
    this.resetTracking();
  }
  resetTracking() {
    if (this.samples) this.samples = [];
    this.filtered = null;
    this.lastTime = null;
    this.lastValidTime = null;
    this.badSince = null;
    this.goodSince = null;
    this.bad = false;
    this.alerting = false;
  }
  update(pose, time) {
    const result = (state, extra = {}) => ({ state, alert: false, ...extra });
    if (!pose || !Number.isFinite(pose.height) || !Number.isFinite(pose.forward)) {
      // Once triggered, an uncertain frame is not evidence of recovery.
      // Allow short occlusions; stop after two seconds without a valid pose.
      if (this.alerting && time - this.lastValidTime <= 2) {
        this.goodSince = null;
        return result('slouching', { alert: true });
      }
      this.resetTracking();
      if (this.samples) this.samples = [];
      return result('not-visible');
    }
    if (this.lastTime !== null && time - this.lastTime > (this.alerting ? 2 : 1.5)) {
      this.resetTracking();
      if (this.samples) this.samples = [];
    }
    const delta = this.lastTime === null ? 0.2 : Math.max(0, time - this.lastTime);
    this.lastTime = time;
    this.lastValidTime = time;
    if (this.samples) {
      this.samples.push({ pose, time });
      const elapsed = time - this.samples[0].time;
      if (elapsed >= 3 && this.samples.length >= 12) {
        const heights = this.samples.map(s => s.pose.height).sort((a,b) => a-b);
        const depths = this.samples.map(s => s.pose.forward).sort((a,b) => a-b);
        const low = Math.floor(heights.length * 0.1), high = heights.length - 1 - low;
        if (heights[high] - heights[low] > 0.12 || depths[high] - depths[low] > 0.2) {
          this.samples = [];
          return result('calibrating', { seconds: 3, unstable: true });
        }
        this.baseline = { height: median(heights), forward: median(depths) };
        this.samples = null;
        this.filtered = pose;
        return result('upright');
      }
      return result('calibrating', { seconds: Math.max(1, Math.ceil(3 - elapsed)) });
    }
    if (!this.baseline) return result('uncalibrated');
    const alpha = 1 - Math.exp(-delta / 0.4);
    const previous = this.filtered ?? pose;
    this.filtered = Object.fromEntries(['height', 'forward'].map(key => [key, previous[key] + alpha * (pose[key] - previous[key])]));
    // Depth is noisier than image-plane height: require twice the displacement.
    const deviation = Math.max(this.baseline.height - this.filtered.height,
      (this.filtered.forward - this.baseline.forward) * 0.5);
    this.bad = deviation > this.threshold * (this.bad ? 0.65 : 1);
    if (!this.bad) {
      if (this.alerting) {
        this.goodSince ??= time;
        // Brief landmark jitter must not silence an already-active reminder.
        if (time - this.goodSince < 0.8) return result('slouching', { alert: true });
        this.alerting = false;
      }
      this.badSince = null;
      return result('upright');
    }
    this.goodSince = null;
    this.badSince ??= time;
    // Keep the reminder active for the entire slouch. Playback handles clip
    // duration, so reminders repeat without overlapping or a global cooldown.
    this.alerting ||= time - this.badSince >= this.hold;
    return result('slouching', { alert: this.alerting });
  }
}
