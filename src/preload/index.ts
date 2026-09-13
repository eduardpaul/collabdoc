import { contextBridge, ipcRenderer } from 'electron'

/**
 * Main hands the renderer one end of a MessageChannel per attached document.
 * A port cannot cross the context bridge, but `window.postMessage` can
 * transfer it into the page — the documented way to keep `sandbox: true`.
 *
 * Sandboxed preloads can `require('electron')` only. Do not import npm
 * packages here (`@electron-toolkit/preload` included): packaged Windows
 * builds then fail to expose `window.api`, and Share looks like a browser.
 */
ipcRenderer.on('documents:port', (event, payload: { type: string; docId: string }) => {
  window.postMessage(payload, '*', event.ports)
})

const isWsl = process.argv.includes('--is-wsl=true') || Boolean(process.env.WSL_DISTRO_NAME)

const invoke = (channel: string, ...args: unknown[]): Promise<unknown> =>
  ipcRenderer.invoke(channel, ...args)

const onChannel = (
  channel: string,
  listener: (payload: unknown) => void
): (() => void) => {
  const wrapped = (_event: unknown, payload: unknown): void => listener(payload)
  ipcRenderer.on(channel, wrapped)
  return () => {
    ipcRenderer.removeListener(channel, wrapped)
  }
}

const api = {
  platform: process.platform,
  isWsl,
  documents: {
    open: (): Promise<unknown> => invoke('documents:open'),
    openPath: (filePath: string): Promise<unknown> => invoke('documents:openPath', filePath),
    importMarkdown: (): Promise<unknown> => invoke('documents:importMarkdown'),
    exportMarkdown: (payload: {
      content: string
      suggestedName?: string
      extras?: { relativePath: string; base64: string }[]
    }): Promise<unknown> => invoke('documents:exportMarkdown', payload),
    saveNow: (docId: string): Promise<unknown> => invoke('documents:saveNow', docId),
    saveAs: (docId: string): Promise<unknown> => invoke('documents:saveAs', docId),
    flush: (docId: string): Promise<unknown> => invoke('documents:flush', docId),
    saveBytes: (payload: {
      suggestedName: string
      mime?: string
      base64: string
    }): Promise<unknown> => invoke('documents:saveBytes', payload),
    readBytes: (filePath: string): Promise<unknown> => invoke('documents:readBytes', filePath),
    create: (payload: { title?: string }): Promise<unknown> => invoke('documents:create', payload),
    attach: (docId: string): Promise<unknown> => invoke('documents:attach', docId),
    release: (docId: string): Promise<unknown> => invoke('documents:release', docId),
    debug: (): Promise<unknown> => invoke('documents:debug'),
    putAsset: (payload: {
      docId: string
      hash: string
      mime: string
      base64: string
    }): Promise<unknown> => invoke('documents:putAsset', payload),
    getAssets: (docId: string): Promise<unknown> => invoke('documents:getAssets', docId),
    listing: (): Promise<unknown> => invoke('documents:listing'),
    removeRecent: (docId: string): Promise<unknown> => invoke('documents:removeRecent', docId),
    locateRecent: (docId: string): Promise<unknown> => invoke('documents:locateRecent', docId),
    recover: (docId: string): Promise<unknown> => invoke('documents:recover', docId),
    discardDraft: (docId: string): Promise<unknown> => invoke('documents:discardDraft', docId),
    rememberRecent: (payload: {
      docId: string
      title: string
      path: string | null
      updatedAt: string
      preview: string
    }): Promise<unknown> => invoke('documents:rememberRecent', payload),
    onState: (listener: (state: unknown) => void): (() => void) =>
      onChannel('documents:state', listener),
    onListing: (listener: (listing: unknown) => void): (() => void) =>
      onChannel('documents:listing', listener)
  },
  share: {
    start: (payload: { docId: string; hostName: string }): Promise<unknown> =>
      invoke('share:start', payload),
    stop: (): Promise<unknown> => invoke('share:stop'),
    removeGuest: (id: string): Promise<unknown> => invoke('share:removeGuest', id),
    join: (payload: {
      code: string
      profile: {
        userId: string
        name: string
        handle: string
        color: string
        installPublicKey: string
      }
      expectedDocId?: string
    }): Promise<unknown> => invoke('share:join', payload),
    leave: (): Promise<unknown> => invoke('share:leave'),
    onState: (listener: (state: unknown) => void): (() => void) =>
      onChannel('share:state', listener),
    onActivity: (listener: (summary: string) => void): (() => void) =>
      onChannel('share:activity', (summary) => {
        if (typeof summary === 'string') listener(summary)
      })
  },
  profile: {
    get: (): Promise<unknown> => invoke('profile:get'),
    save: (profile: {
      userId: string
      name: string
      handle: string
      color: string
      setupComplete: boolean
    }): Promise<unknown> => invoke('profile:save', profile)
  },
  app: {
    onCommand: (listener: (command: string) => void): (() => void) =>
      onChannel('app:command', (command) => {
        if (typeof command === 'string') listener(command)
      })
  },
  shell: {
    openExternal: (url: string): Promise<unknown> => invoke('shell:openExternal', url)
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-expect-error isolated world is the packaged path; this is tests/dev only
  window.api = api
}
