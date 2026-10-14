import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './test', testMatch: '*.spec.js', timeout: 45000, workers: 1,
  use: { baseURL: 'http://localhost:5174', headless: true, viewport: { width: 1000, height: 800 } },
  webServer: [
    { command: 'node server.mjs --video test/alert.wav --port 5174', url: 'http://localhost:5174', reuseExistingServer: false },
    { command: 'node server.mjs --video test/alert.mp4 --port 5175', url: 'http://localhost:5175', reuseExistingServer: false }
  ]
});
