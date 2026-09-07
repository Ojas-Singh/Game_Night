import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './e2e', timeout: 45000, fullyParallel: false,
  use: { baseURL: 'http://127.0.0.1:5173', trace: 'retain-on-failure' },
  projects: [{ name: 'desktop', use: { ...devices['Desktop Chrome'] } }, { name: 'mobile', use: { ...devices['Pixel 7'], viewport: { width: 360, height: 780 } } }],
  webServer: [
    { command: 'node ../server/dist/index.js', port: 3000, reuseExistingServer: !process.env.CI, cwd: '../web', env: { PORT: '3000', NODE_ENV: 'development' } },
    { command: 'corepack pnpm dev --host 127.0.0.1', port: 5173, reuseExistingServer: !process.env.CI, cwd: '.' },
  ],
});
