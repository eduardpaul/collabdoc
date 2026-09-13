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
    openPath: (filePath: string): Promise<unknown> =>
      electronAPI.ipcRenderer.invoke('documents:openPath', filePath),
    importMarkdown: (): Promise<unknown> =>
      electronAPI.ipcRenderer.invoke('documents:importMarkdown'),
    exportMarkdown: (payload: {
      content: string
      suggestedName?: string
      extras?: { relativePath: string; base64: string }[]
    }): Promise<unknown> => electronAPI.ipcRenderer.invoke('documents:exportMarkdown', payload),
    saveNow: (docId: string): Promise<unknown> =>
      electronAPI.ipcRenderer.invoke('documents:saveNow', docId),
    saveAs: (docId: string): Promise<unknown> =>
      electronAPI.ipcRenderer.invoke('documents:saveAs', docId),
    flush: (docId: string): Promise<unknown> =>
      electronAPI.ipcRenderer.invoke('documents:flush', docId),
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
    debug: (): Promise<unknown> => electronAPI.ipcRenderer.invoke('documents:debug'),
    putAsset: (payload: {
      docId: string
      hash: string
      mime: string
      base64: string
    }): Promise<unknown> => electronAPI.ipcRenderer.invoke('documents:putAsset', payload),
    getAssets: (docId: string): Promise<unknown> =>
      electronAPI.ipcRenderer.invoke('documents:getAssets', docId),
    listing: (): Promise<unknown> => electronAPI.ipcRenderer.invoke('documents:listing'),
    removeRecent: (docId: string): Promise<unknown> =>
      electronAPI.ipcRenderer.invoke('documents:removeRecent', docId),
    locateRecent: (docId: string): Promise<unknown> =>
      electronAPI.ipcRenderer.invoke('documents:locateRecent', docId),
    recover: (docId: string): Promise<unknown> =>
      electronAPI.ipcRenderer.invoke('documents:recover', docId),
    discardDraft: (docId: string): Promise<unknown> =>
      electronAPI.ipcRenderer.invoke('documents:discardDraft', docId),
    rememberRecent: (payload: {
      docId: string
      title: string
      path: string | null
      updatedAt: string
      preview: string
    }): Promise<unknown> => electronAPI.ipcRenderer.invoke('documents:rememberRecent', payload),
    onState: (listener: (state: unknown) => void): (() => void) => {
      const wrapped = (_event: unknown, state: unknown): void => listener(state)
      ipcRenderer.on('documents:state', wrapped)
      return () => {
        ipcRenderer.removeListener('documents:state', wrapped)
      }
    },
    onListing: (listener: (listing: unknown) => void): (() => void) => {
      const wrapped = (_event: unknown, listing: unknown): void => listener(listing)
      ipcRenderer.on('documents:listing', wrapped)
      return () => {
        ipcRenderer.removeListener('documents:listing', wrapped)
      }
    }
  },
  profile: {
    get: (): Promise<unknown> => electronAPI.ipcRenderer.invoke('profile:get'),
    save: (profile: {
      userId: string
      name: string
      handle: string
      color: string
      setupComplete: boolean
    }): Promise<unknown> => electronAPI.ipcRenderer.invoke('profile:save', profile)
  },
  app: {
    onCommand: (listener: (command: string) => void): (() => void) => {
      const wrapped = (_event: unknown, command: unknown): void => {
        if (typeof command === 'string') listener(command)
      }
      ipcRenderer.on('app:command', wrapped)
      return () => {
        ipcRenderer.removeListener('app:command', wrapped)
      }
    }
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
