import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.e2e.ts',
  fullyParallel: true,
  workers: 1,
  forbidOnly: true,
  reporter: 'line',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure'
  },
  webServer: {
    command: 'bun run dev -- --host 127.0.0.1 --port 4173',
    url: 'http://127.0.0.1:4173/design-system',
    reuseExistingServer: true,
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
