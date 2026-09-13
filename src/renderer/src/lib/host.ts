export function hasNativeDocuments(): boolean {
  return Boolean(window.api?.documents)
}

export function hostLabel(): string {
  const api = window.api
  if (!api) {
    return 'Browser'
  }
  if (api.isWsl) {
    return 'WSL'
  }
  if (api.platform === 'win32') {
    return 'Windows'
  }
  if (api.platform === 'darwin') {
    return 'macOS'
  }
  return 'Linux'
}

export function isApple(): boolean {
  return window.api?.platform === 'darwin'
}

export function modLabel(): string {
  return isApple() ? '⌘' : 'Ctrl'
}
