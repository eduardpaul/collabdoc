import { ElectronAPI } from '@electron-toolkit/preload'

type HostApi = {
  platform: NodeJS.Platform
  isWsl: boolean
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: HostApi
  }
}
