import { ElectronAPI } from '@electron-toolkit/preload'

type DocumentReadResult =
  { ok: true; path: string; name: string; content: string } | { ok: false; error: string }

type DocumentSaveResult = { ok: true; path: string; name: string } | { ok: false; error: string }

type HostApi = {
  platform: NodeJS.Platform
  isWsl: boolean
  documents: {
    open: () => Promise<DocumentReadResult>
    read: (filePath: string) => Promise<DocumentReadResult>
    save: (payload: {
      path: string | null
      content: string
      suggestedName?: string
      extras?: { relativePath: string; base64: string }[]
    }) => Promise<DocumentSaveResult>
    saveBytes: (payload: {
      suggestedName: string
      mime?: string
      base64: string
    }) => Promise<DocumentSaveResult>
    readBytes: (
      filePath: string
    ) => Promise<{ ok: true; base64: string } | { ok: false; error: string }>
  }
  shell: {
    openExternal: (url: string) => Promise<{ ok: boolean }>
  }
}

declare global {
  interface Window {
    electron?: ElectronAPI
    api?: HostApi
  }
}
