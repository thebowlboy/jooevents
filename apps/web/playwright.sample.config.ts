import { defineConfig } from '@playwright/test';

const port = process.env.PLAYWRIGHT_SAMPLE_PORT ?? '4173';
const portNumber = Number(port);
if (!Number.isInteger(portNumber) || portNumber < 1024 || portNumber > 65_535) {
	throw new TypeError('PLAYWRIGHT_SAMPLE_PORT must be an unprivileged TCP port.');
}
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
	testDir: './tests',
	testMatch: '**/*.sample-proof.ts',
	fullyParallel: false,
	workers: 1,
	forbidOnly: true,
	reporter: 'line',
	use: {
		baseURL,
		viewport: { width: 1024, height: 768 },
		screenshot: 'only-on-failure',
		trace: 'retain-on-failure'
	},
	webServer: {
		command: `bun run build && bun run preview -- --host 127.0.0.1 --port ${port}`,
		url: `${baseURL}/app/settings`,
		reuseExistingServer: false,
		timeout: 60_000
	}
});
