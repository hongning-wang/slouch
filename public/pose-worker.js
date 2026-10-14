import { FilesetResolver, PoseLandmarker } from '/vendor/vision_bundle.mjs';
let model;
self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'init') {
      const files = await FilesetResolver.forVisionTasks('/vendor/wasm', true);
      model = await PoseLandmarker.createFromOptions(files, {
        baseOptions: { modelAssetPath: '/model.task', delegate: 'CPU' },
        runningMode: 'VIDEO', numPoses: 1,
        minPoseDetectionConfidence: 0.6, minPosePresenceConfidence: 0.6, minTrackingConfidence: 0.6
      });
      self.postMessage({ type: 'ready' });
    } else if (data.type === 'frame') {
      const result = model.detectForVideo(data.frame, data.time);
      self.postMessage({ type: 'pose', landmarks: result.landmarks[0], time: data.time, generation: data.generation });
    }
  } catch (error) {
    self.postMessage({ type: 'error', message: error.message });
  } finally { data.frame?.close(); }
};
