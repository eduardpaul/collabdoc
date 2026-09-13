import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

const isWsl = Boolean(process.env.WSL_DISTRO_NAME)

const sharedAliases = {
  '@shared': resolve('src/shared'),
  '@core': resolve('src/core')
}

export default defineConfig({
  main: {
    resolve: {
      alias: sharedAliases
    },
    build: {
      target: 'node24',
      bytecode: true,
      minify: true,
      rollupOptions: {
        // loro-crdt's Node build reads its .wasm next to its own file via
        // __dirname, so it has to stay a real package, not bundled code.
        external: ['loro-crdt', 'hyperswarm']
      }
    }
  },
  preload: {
    build: {
      target: 'node24',
      minify: true
    }
  },
  renderer: {
    // Left out of dependency pre-bundling so `import.meta.url` inside loro-crdt
    // still points at the real package directory, where its `.wasm` lives.
    optimizeDeps: { exclude: ['loro-crdt', 'loro-crdt/web'] },
    server: {
      host: '127.0.0.1',
      watch: isWsl ? { usePolling: true, interval: 300 } : undefined
    },
    build: {
      target: 'chrome152',
      minify: 'esbuild',
      cssCodeSplit: true,
      // The packaged renderer is a file:// page and cannot fetch() a file;
      // inline the wasm as a data: URL instead (see sync/loro-init.ts).
      assetsInlineLimit: (filePath) => (filePath.endsWith('.wasm') ? true : undefined),
      rollupOptions: {
        output: {
          manualChunks: {
            'react-vendor': ['react', 'react-dom'],
            'tiptap-vendor': [
              '@tiptap/core',
              '@tiptap/react',
              '@tiptap/starter-kit',
              '@tiptap/markdown'
            ]
          }
        }
      }
    },
    resolve: {
      alias: [
        { find: '@renderer', replacement: resolve('src/renderer/src') },
        { find: '@shared', replacement: resolve('src/shared') },
        { find: '@core', replacement: resolve('src/core') },
        // The web build: wasm fetched as an asset (see sync/loro-init.ts).
        { find: /^loro-crdt$/, replacement: 'loro-crdt/web' }
      ]
    },
    plugins: [react()]
  }
})
