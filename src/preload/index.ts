import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

/**
 * Main hands the renderer one end of a MessageChannel per attached document.
 * A port cannot cross the context bridge, but `window.postMessage` can
 * transfer it into the page — the documented way to keep `sandbox: true`.
 */
ipcRenderer.on('documents:port', (event, payload: { type: string; docId: string }) => {
  window.postMessage(payload, '*', event.ports)
})

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
      extras?: { relativePath: string; base64: string }[]
    }): Promise<unknown> => electronAPI.ipcRenderer.invoke('documents:save', payload),
    saveBytes: (payload: {
      suggestedName: string
      mime?: string
      base64: string
    }): Promise<unknown> => electronAPI.ipcRenderer.invoke('documents:saveBytes', payload),
    readBytes: (filePath: string): Promise<unknown> =>
      electronAPI.ipcRenderer.invoke('documents:readBytes', filePath),
    create: (payload: { title?: string }): Promise<unknown> =>
      electronAPI.ipcRenderer.invoke('documents:create', payload),
    attach: (docId: string): Promise<unknown> =>
      electronAPI.ipcRenderer.invoke('documents:attach', docId),
    release: (docId: string): Promise<unknown> =>
      electronAPI.ipcRenderer.invoke('documents:release', docId),
    debug: (): Promise<unknown> => electronAPI.ipcRenderer.invoke('documents:debug')
  },
  shell: {
    openExternal: (url: string): Promise<unknown> =>
      electronAPI.ipcRenderer.invoke('shell:openExternal', url)
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
