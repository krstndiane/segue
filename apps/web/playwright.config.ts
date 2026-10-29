import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end checks of the main flows on a phone-sized screen.
 * The app runs against no API (planning happens on the device), with a fixed
 * clock and time zone, so results don't depend on the network or the hour.
 * First time: `pnpm --filter @segue/web exec playwright install chromium`
 * (or set PW_CHROMIUM_PATH to a Chromium you already have).
 */
const PORT = 5180;

export default defineConfig({
  testDir: './e2e',
  testMatch: '*.e2e.ts',
  fullyParallel: true,
  reporter: [['list']],
  use: {
    ...devices['Pixel 7'],
    baseURL: `http://localhost:${PORT}`,
    timezoneId: 'Asia/Manila',
    geolocation: { latitude: 14.5547, longitude: 121.0244 },
    permissions: ['geolocation'],
    launchOptions: process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {},
  },
  webServer: {
    command: `vite --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    // The assistant is built in for the browser tests (it stays out of production builds).
    env: { VITE_API_URL: 'http://127.0.0.1:9', VITE_GOOGLE_CLIENT_ID: 'e2e-client.apps.googleusercontent.com', VITE_ASSISTANT: 'on' },
  },
});
