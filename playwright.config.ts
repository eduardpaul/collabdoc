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
    headless: true,
    storageState: {
      cookies: [],
      origins: [
        {
          origin: 'http://127.0.0.1:5174',
          localStorage: [
            {
              name: 'collabdoc.profile',
              value: JSON.stringify({
                userId: '00000000-0000-4000-8000-000000000001',
                name: 'You',
                handle: 'you',
                color: '#c45c26',
                setupComplete: true
              })
            }
          ]
        }
      ]
    }
  }
})
