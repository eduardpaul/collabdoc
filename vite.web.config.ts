import { resolve } from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  root: resolve('src/renderer'),
  plugins: [react()],
  // Left out of dependency pre-bundling so `import.meta.url` inside loro-crdt
  // still points at the real package directory, where its `.wasm` lives.
  optimizeDeps: { exclude: ['loro-crdt', 'loro-crdt/web'] },
  resolve: {
    alias: [
      { find: '@renderer', replacement: resolve('src/renderer/src') },
      { find: '@shared', replacement: resolve('src/shared') },
      { find: '@core', replacement: resolve('src/core') },
      // The web build: wasm fetched as an asset (see sync/loro-init.ts).
      { find: /^loro-crdt$/, replacement: 'loro-crdt/web' }
    ]
  },
  server: {
    host: '127.0.0.1',
    port: 5174,
    strictPort: true
  }
})
