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
    }) => Promise<DocumentSaveResult>
  }
}

declare global {
  interface Window {
    electron?: ElectronAPI
    api?: HostApi
  }
}
