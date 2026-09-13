#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function isWsl() {
  if (process.env.WSL_DISTRO_NAME) {
    return true
  }
  if (process.platform !== 'linux') {
    return false
  }
  try {
    return readFileSync('/proc/version', 'utf8').toLowerCase().includes('microsoft')
  } catch {
    return false
  }
}

function warnIfElectronPlatformMismatch() {
  const pathTxt = join(root, 'node_modules/electron/path.txt')
  if (!existsSync(pathTxt)) {
    return
  }

  const rel = readFileSync(pathTxt, 'utf8').trim()
  const isWinBinary = /\.exe$/i.test(rel) || /electron\.exe/i.test(rel)
  const onWindows = process.platform === 'win32'

  if (isWinBinary === onWindows) {
    return
  }

  console.warn('\n[collabdoc] Electron binary does not match this OS.')
  console.warn(`  Installed: ${rel}`)
  console.warn(`  Current platform: ${process.platform}`)
  console.warn('  node_modules cannot be shared between WSL and Windows.')
  console.warn('  Fix: rm -rf node_modules && npm install\n')
}

function warnIfWindowsMount() {
  const cwd = process.cwd().replaceAll('\\', '/')
  if (!cwd.startsWith('/mnt/')) {
    return
  }

  console.warn('\n[collabdoc] Project is on a Windows mount (/mnt/...).')
  console.warn('  Keep the repo on the Linux filesystem (e.g. ~/repos) for WSL work.')
  console.warn('  Windows-drive paths make file watching and native modules unreliable.\n')
}

warnIfElectronPlatformMismatch()
warnIfWindowsMount()

const env = { ...process.env }

// VS Code / Claude terminals export ELECTRON_RUN_AS_NODE=1 (and WSLENV forwards it
// from Windows). Electron would then start as plain Node and `app` is undefined.
delete env.ELECTRON_RUN_AS_NODE

if (isWsl()) {
  env.NO_SANDBOX = '1'
  env.ELECTRON_OZONE_PLATFORM_HINT ??= 'x11'
  env.GDK_BACKEND ??= 'x11'
  env.CHOKIDAR_USEPOLLING ??= '1'
  env.CHOKIDAR_INTERVAL ??= '300'
  if (!env.DISPLAY && !env.WAYLAND_DISPLAY) {
    env.DISPLAY = ':0'
  }
}

const binName = process.platform === 'win32' ? 'electron-vite.cmd' : 'electron-vite'
const cli = join(root, 'node_modules', '.bin', binName)

const child = spawn(cli, process.argv.slice(2), {
  stdio: 'inherit',
  env,
  cwd: root,
  shell: process.platform === 'win32',
  windowsHide: false
})

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? 1)
})
