import { resolve } from 'path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@renderer': resolve('src/renderer/src'),
      '@shared': resolve('src/shared'),
      '@core': resolve('src/core')
    }
  },
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    exclude: ['e2e/**', 'node_modules/**'],
    // `--expose-gc` lets the registry memory test (AC-03.5) measure a settled heap.
    poolOptions: { forks: { execArgv: ['--expose-gc'] } },
    coverage: {
      provider: 'v8',
      include: ['src/core/**/*.ts', 'src/shared/**/*.ts'],
      exclude: ['**/*.test.ts', '**/index.ts'],
      thresholds: { lines: 85 }
    }
  }
})
