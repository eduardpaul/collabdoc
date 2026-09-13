import { contextBridge } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

// Support both process.argv flag passed by main process and environment variable
const isWsl = process.argv.includes('--is-wsl=true') || Boolean(process.env.WSL_DISTRO_NAME)

const api = {
  platform: process.platform,
  isWsl,
  documents: {
    open: (): Promise<unknown> => electronAPI.ipcRenderer.invoke('documents:open'),
    read: (filePath: string): Promise<unknown> =>
      electronAPI.ipcRenderer.invoke('documents:read', filePath),
    save: (payload: {
      path: string | null
      content: string
      suggestedName?: string
    }): Promise<unknown> => electronAPI.ipcRenderer.invoke('documents:save', payload)
  }
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
