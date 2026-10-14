`pose.jpg` is Google's MediaPipe example image, downloaded from
https://storage.googleapis.com/mediapipe-assets/pose.jpg.

Browser tests use this public fixture as a simulated camera. They run the actual
local model and move the fixture's head relative to its shoulders to create an exaggerated
posture change. This tests the inference-to-alert pipeline, not real-world
classification accuracy. No personal camera frames are captured for tests.

`alert.wav` is a generated 0.3-second tone. `alert.mp4` is a generated two-second
color frame and tone, used to verify alternate media arguments and video playback.
