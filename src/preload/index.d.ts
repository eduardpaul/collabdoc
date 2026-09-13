import { ElectronAPI } from '@electron-toolkit/preload'

type DocumentReadResult =
  { ok: true; path: string; name: string; content: string } | { ok: false; error: string }

type DocumentSaveResult = { ok: true; path: string; name: string } | { ok: false; error: string }

type DocumentCreateResult =
  { ok: true; docId: string; title: string } | { ok: false; error: string }
type DocumentAttachResult = { ok: true; docId: string } | { ok: false; error: string }
type DocumentReleaseResult = { ok: true } | { ok: false; error: string }
type DocumentDebugEntry = {
  docId: string
  title: string
  subscribers: string[]
  changes: number
  text: string
}
type DocumentDebugResult =
  { ok: true; documents: DocumentDebugEntry[] } | { ok: false; error: string }

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
    /** Create an empty document in main; attach to it to receive its port. */
    create: (payload: { title?: string }) => Promise<DocumentCreateResult>
    /** Ask main for a MessagePort; it arrives as a `collabdoc:port` window message. */
    attach: (docId: string) => Promise<DocumentAttachResult>
    /** Detach and, when nobody else holds the document, dispose it now. */
    release: (docId: string) => Promise<DocumentReleaseResult>
    /** Development only: every open hub in main. */
    debug: () => Promise<DocumentDebugResult>
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
