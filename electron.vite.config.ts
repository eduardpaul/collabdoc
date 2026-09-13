import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

const isWsl = Boolean(process.env.WSL_DISTRO_NAME)

export default defineConfig({
  main: {
    build: {
      target: 'node24',
      bytecode: true,
      minify: true
    }
  },
  preload: {
    build: {
      target: 'node24',
      minify: true
    }
  },
  renderer: {
    server: {
      host: '127.0.0.1',
      watch: isWsl ? { usePolling: true, interval: 300 } : undefined
    },
    build: {
      target: 'chrome152',
      minify: 'esbuild',
      cssCodeSplit: true,
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
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [react()]
  }
})
