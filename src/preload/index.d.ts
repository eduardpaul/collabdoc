import { ElectronAPI } from '@electron-toolkit/preload'
import type { InboxEntry } from '../shared/types'

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

type OpenDocResult =
  | {
      ok: true
      kind: 'collabdoc'
      docId: string
      title: string
      path: string
      warnings: string[]
    }
  | {
      ok: true
      kind: 'markdown'
      docId: string
      title: string
      markdown: string
      sourcePath: string
    }
  | { ok: false; error: string }

type SaveDocResult =
  { ok: true; path: string; name: string } | { ok: false; error: string; canceled?: boolean }

type PersistState = {
  docId: string
  title: string
  path: string | null
  isDraft: boolean
  dirty: boolean
  hasDraft: boolean
}

type RecentListing = {
  docId: string
  title: string
  path: string | null
  updatedAt: string
  preview: string
  missing?: boolean
}

type RecoveryOffer = { docId: string; title: string; updatedAt: string }

type PersistListing = { recents: RecentListing[]; recoveries: RecoveryOffer[] }

type HostApi = {
  platform: NodeJS.Platform
  isWsl: boolean
  documents: {
    open: () => Promise<OpenDocResult>
    openPath: (filePath: string) => Promise<OpenDocResult>
    importMarkdown: () => Promise<OpenDocResult>
    exportMarkdown: (payload: {
      content: string
      suggestedName?: string
      extras?: { relativePath: string; base64: string }[]
    }) => Promise<SaveDocResult>
    saveNow: (docId: string) => Promise<SaveDocResult>
    saveAs: (docId: string) => Promise<SaveDocResult>
    flush: (docId: string) => Promise<SaveDocResult>
    saveBytes: (payload: {
      suggestedName: string
      mime?: string
      base64: string
    }) => Promise<DocumentSaveResult>
    readBytes: (
      filePath: string
    ) => Promise<{ ok: true; base64: string } | { ok: false; error: string }>
    create: (payload: { title?: string }) => Promise<DocumentCreateResult>
    attach: (docId: string) => Promise<DocumentAttachResult>
    release: (docId: string) => Promise<DocumentReleaseResult>
    debug: () => Promise<DocumentDebugResult>
    putAsset: (payload: {
      docId: string
      hash: string
      mime: string
      base64: string
    }) => Promise<{ ok: true } | { ok: false; error: string }>
    getAssets: (
      docId: string
    ) => Promise<
      | { ok: true; assets: { hash: string; mime: string; base64: string }[] }
      | { ok: false; error: string }
    >
    listing: () => Promise<{ ok: true } & PersistListing>
    removeRecent: (docId: string) => Promise<{ ok: true } | { ok: false; error: string }>
    locateRecent: (docId: string) => Promise<OpenDocResult>
    recover: (docId: string) => Promise<OpenDocResult>
    discardDraft: (docId: string) => Promise<{ ok: true } | { ok: false; error: string }>
    rememberRecent: (payload: {
      docId: string
      title: string
      path: string | null
      updatedAt: string
      preview: string
    }) => Promise<{ ok: true } | { ok: false; error: string }>
    onState: (listener: (state: PersistState) => void) => () => void
    onListing: (listener: (listing: PersistListing) => void) => () => void
  }
  share: {
    start: (payload: { docId: string; hostName: string }) => Promise<
      | {
          ok: true
          state: {
            active: boolean
            announcing: boolean
            code: string | null
            link: string | null
            role: 'host' | 'guest' | null
            guests: Array<{
              id: string
              name: string
              color: string
              handle: string
              connection: 'direct' | 'holepunched' | 'relay' | 'local'
            }>
            status: string
            lockedUntil: number
            hostEnded: boolean
            readOnly: boolean
          }
        }
      | { ok: false; error: string }
    >
    stop: () => Promise<{ ok: true }>
    removeGuest: (id: string) => Promise<{ ok: true } | { ok: false; error: string }>
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
    }) => Promise<{ ok: true; docId: string; title: string } | { ok: false; error: string }>
    leave: () => Promise<{ ok: true }>
    onState: (
      listener: (state: {
        active: boolean
        announcing: boolean
        code: string | null
        link: string | null
        role: 'host' | 'guest' | null
        guests: Array<{
          id: string
          name: string
          color: string
          handle: string
          connection: 'direct' | 'holepunched' | 'relay' | 'local'
        }>
        status: string
        lockedUntil: number
        hostEnded: boolean
        readOnly: boolean
      }) => void
    ) => () => void
    onActivity: (listener: (summary: string) => void) => () => void
  }
  inbox: {
    list: (
      userId: string
    ) => Promise<{ ok: true; entries: InboxEntry[] } | { ok: false; error: string }>
    add: (payload: {
      userId: string
      entries: InboxEntry[]
    }) => Promise<{ ok: true; entries: InboxEntry[]; added: number } | { ok: false; error: string }>
    markRead: (payload: {
      userId: string
      ids: string[] | 'all'
    }) => Promise<{ ok: true; entries: InboxEntry[] } | { ok: false; error: string }>
  }
  profile: {
    get: () => Promise<{
      ok: true
      profile: {
        userId: string
        name: string
        handle: string
        color: string
        setupComplete: boolean
      }
    }>
    save: (profile: {
      userId: string
      name: string
      handle: string
      color: string
      setupComplete: boolean
    }) => Promise<{
      ok: true
      profile: {
        userId: string
        name: string
        handle: string
        color: string
        setupComplete: boolean
      }
    }>
  }
  app: {
    onCommand: (listener: (command: string) => void) => () => void
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

export {}
