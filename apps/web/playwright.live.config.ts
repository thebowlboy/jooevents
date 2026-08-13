import { defineConfig, devices } from '@playwright/test';

const port = process.env.PLAYWRIGHT_LIVE_PORT ?? '4174';
const portNumber = Number(port);
if (!Number.isInteger(portNumber) || portNumber < 1024 || portNumber > 65_535) {
	throw new TypeError('PLAYWRIGHT_LIVE_PORT must be an unprivileged TCP port.');
}
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.live.ts',
  fullyParallel: true,
  workers: 1,
  forbidOnly: true,
  reporter: 'line',
  use: {
    baseURL,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure'
  },
  webServer: {
    command: `bun run dev:live -- --host 127.0.0.1 --port ${port}`,
		url: `${baseURL}/app`,
    reuseExistingServer: false,
    timeout: 60_000
  },
  projects: [
    {
      name: 'desktop',
      use: { viewport: { width: 1440, height: 1000 } }
    },
    {
      name: 'mobile',
      use: { ...devices['Pixel 5'] }
    }
  ]
});
