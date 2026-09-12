import { readFileSync } from 'fs'
import { app } from 'electron'

export function isWsl(): boolean {
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

/**
 * Chromium's setuid sandbox and /dev/shm defaults break under WSL2.
 * Apply these before app.whenReady(). Production Linux outside WSL is unchanged.
 */
export function applyWslChromiumFlags(): void {
  if (!isWsl()) {
    return
  }

  app.commandLine.appendSwitch('no-sandbox')
  app.commandLine.appendSwitch('disable-gpu-sandbox')
  app.commandLine.appendSwitch('disable-setuid-sandbox')
  app.commandLine.appendSwitch('disable-dev-shm-usage')
  app.commandLine.appendSwitch('ozone-platform', 'x11')

  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    process.env.DISPLAY = ':0'
  }

  if (process.env.COLLABDOC_DISABLE_GPU === '1') {
    app.disableHardwareAcceleration()
  }
}
