import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

const isWsl = Boolean(process.env.WSL_DISTRO_NAME)

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    server: {
      host: '127.0.0.1',
      watch: isWsl ? { usePolling: true, interval: 300 } : undefined
    },
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [react()]
  }
})
