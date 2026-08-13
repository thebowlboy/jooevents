import { defineConfig, devices } from '@playwright/test';

const port = process.env.JOOEVENTS_BROWSER_TEST_PORT ?? '4184';
const portNumber = Number(port);
if (!Number.isInteger(portNumber) || portNumber < 1024 || portNumber > 65_535) {
	throw new TypeError('JOOEVENTS_BROWSER_TEST_PORT must be an unprivileged TCP port.');
}
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.joined-live.ts',
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  reporter: 'line',
  use: {
    baseURL,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure'
  },
  webServer: {
    command: `JOOEVENTS_BROWSER_TEST_PORT=${port} bun --cwd ../server src/testing/ephemeral-live-browser-server.ts`,
    url: `${baseURL}/health`,
    reuseExistingServer: false,
    timeout: 60_000
  },
	projects: [
		{ name: 'desktop', use: { viewport: { width: 1440, height: 1000 } } },
		{ name: 'compact-desktop', use: { viewport: { width: 1024, height: 768 } } },
		{ name: 'mobile', use: { ...devices['Pixel 5'] } }
	]
});
