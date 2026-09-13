import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  timeout: 60_000,
  webServer: {
    command: 'npx vite --config vite.web.config.ts',
    url: 'http://127.0.0.1:5174',
    reuseExistingServer: true,
    timeout: 120_000
  },
  use: {
    baseURL: 'http://127.0.0.1:5174',
    headless: true
  }
})
