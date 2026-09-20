import {
  BrowserWindow,
  dialog,
  ipcMain,
  MessageChannelMain,
  type IpcMainInvokeEvent,
  type MessagePortMain
} from 'electron'
import { is } from '@electron-toolkit/utils'
import { mkdir, readFile, writeFile } from 'fs/promises'
import { basename, dirname, extname, join } from 'path'
import { homedir } from 'os'
import type { FrameLink } from '@core/link'
import { CollabdocError, isCollabdocPath } from '@core/collabdoc-file'
import { buildDocx } from '@core/docx'
import { normalizeDocxConfig } from '../../shared/docx-config'
import { atomicWriteFile } from '../persist/atomic'
import { DocumentRegistry, type RegistryDebugEntry } from '@core/registry'
import { base64ToBytes, bytesToBase64 } from '../../shared/base64'
import { PersistAssetError } from '../persist/assets'
import { defaultCollabdocPath } from '../persist/paths'
import type { DocumentStore, PersistListing, PersistState } from '../persist/store'

export const PORT_CHANNEL = 'documents:port'
export const PORT_MESSAGE_TYPE = 'collabdoc:port'
export const STATE_CHANNEL = 'documents:state'
export const LISTING_CHANNEL = 'documents:listing'
export const COMMAND_CHANNEL = 'app:command'

export type CreateResult = { ok: true; docId: string; title: string } | { ok: false; error: string }
export type AttachResult = { ok: true; docId: string } | { ok: false; error: string }
export type ReleaseResult = { ok: true } | { ok: false; error: string }
export type DebugResult =
  { ok: true; documents: RegistryDebugEntry[] } | { ok: false; error: string }

export type OpenDocResult =
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

export type SaveDocResult =
  | { ok: true; path: string; name: string }
  | { ok: true; exportTo: { format: 'markdown' | 'docx'; path: string } }
  | { ok: false; error: string; canceled?: boolean }

export type ExportDocxResult =
  | { ok: true; path: string; name: string; warnings: import('@core/docx').DocxExportWarning[] }
  | { ok: false; error: string; canceled?: boolean }

const MAX_TITLE_CHARS = 200

const collabFilters = [
  { name: 'CollabDoc', extensions: ['collabdoc'] },
  { name: 'Markdown', extensions: ['md', 'markdown'] },
  { name: 'All files', extensions: ['*'] }
]

const markdownFilters = [
  { name: 'Markdown', extensions: ['md', 'markdown'] },
  { name: 'All files', extensions: ['*'] }
]

function portLink(port: MessagePortMain): FrameLink {
  return {
    send: (frame) => port.postMessage(frame),
    onMessage: (listener) => port.on('message', (event) => listener(event.data)),
    onClose: (listener) => port.on('close', listener),
    close: () => port.close()
  }
}

function subscriberId(event: IpcMainInvokeEvent, docId: string): string {
  return `renderer:${event.sender.id}:${docId}`
}

function windowOf(event: IpcMainInvokeEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(event.sender)
}

function fail(error: unknown): { ok: false; error: string } {
  if (error instanceof CollabdocError || error instanceof PersistAssetError) {
    return { ok: false, error: error.message }
  }
  return { ok: false, error: error instanceof Error ? error.message : 'Something went wrong' }
}

function titleFromFileName(filePath: string): string {
  return basename(filePath).replace(/\.(md|markdown|txt|collabdoc)$/i, '') || 'Untitled'
}

export function registerDocumentIpc(registry: DocumentRegistry, store: DocumentStore): void {
  const detachers = new Map<string, () => void>()

  ipcMain.handle('documents:create', (_event, payload: unknown): CreateResult => {
    const options = payload && typeof payload === 'object' ? (payload as { title?: unknown }) : {}
    const title =
      typeof options.title === 'string' ? options.title.slice(0, MAX_TITLE_CHARS) : undefined
    try {
      return { ok: true, ...store.create({ title }) }
    } catch (error) {
      return fail(error)
    }
  })

  ipcMain.handle('documents:attach', (event, docId: unknown): AttachResult => {
    if (typeof docId !== 'string' || !docId) return { ok: false, error: 'Invalid docId' }
    if (!registry.has(docId)) return { ok: false, error: 'Document is not open' }
    const id = subscriberId(event, docId)
    detachers.get(id)?.()
    const channel = new MessageChannelMain()
    try {
      const detach = registry.attach(docId, id, portLink(channel.port1))
      detachers.set(id, () => {
        detachers.delete(id)
        detach()
      })
      channel.port1.on('close', () => detachers.delete(id))
      channel.port1.start()
      event.sender.postMessage(PORT_CHANNEL, { type: PORT_MESSAGE_TYPE, docId }, [channel.port2])
      return { ok: true, docId }
    } catch (error) {
      channel.port1.close()
      channel.port2.close()
      return fail(error)
    }
  })

  ipcMain.handle('documents:release', async (event, docId: unknown): Promise<ReleaseResult> => {
    if (typeof docId !== 'string' || !docId) return { ok: false, error: 'Invalid docId' }
    detachers.get(subscriberId(event, docId))?.()
    try {
      await store.release(docId)
    } catch (error) {
      return fail(error)
    }
    const entry = registry.get(docId)
    if (entry && entry.subscribers.size === 0) registry.close(docId)
    return { ok: true }
  })

  ipcMain.handle('documents:debug', (): DebugResult => {
    if (!is.dev) return { ok: false, error: 'Only available in development' }
    return { ok: true, documents: registry.debug() }
  })

  ipcMain.handle('documents:open', async (event): Promise<OpenDocResult> => {
    const win = windowOf(event)
    if (!win) return { ok: false, error: 'No window' }
    const picked = await dialog.showOpenDialog(win, {
      title: 'Open document',
      properties: ['openFile'],
      filters: collabFilters
    })
    if (picked.canceled || !picked.filePaths[0]) return { ok: false, error: 'canceled' }
    return openPath(store, picked.filePaths[0])
  })

  ipcMain.handle(
    'documents:openPath',
    async (_event, filePath: unknown): Promise<OpenDocResult> => {
      if (typeof filePath !== 'string' || !filePath) return { ok: false, error: 'Invalid path' }
      return openPath(store, filePath)
    }
  )

  ipcMain.handle('documents:importMarkdown', async (event): Promise<OpenDocResult> => {
    const win = windowOf(event)
    if (!win) return { ok: false, error: 'No window' }
    const picked = await dialog.showOpenDialog(win, {
      title: 'Import Markdown',
      properties: ['openFile'],
      filters: markdownFilters
    })
    if (picked.canceled || !picked.filePaths[0]) return { ok: false, error: 'canceled' }
    return importMarkdown(store, picked.filePaths[0])
  })

  ipcMain.handle('documents:saveNow', async (event, docId: unknown): Promise<SaveDocResult> => {
    if (typeof docId !== 'string' || !docId) return { ok: false, error: 'Invalid docId' }
    try {
      const result = await store.save(docId)
      if ('needsSaveAs' in result) return saveAs(event, store, docId)
      return { ok: true, ...result }
    } catch (error) {
      return fail(error)
    }
  })

  ipcMain.handle('documents:saveAs', async (event, docId: unknown): Promise<SaveDocResult> => {
    if (typeof docId !== 'string' || !docId) return { ok: false, error: 'Invalid docId' }
    return saveAs(event, store, docId)
  })

  ipcMain.handle('documents:flush', async (_event, docId: unknown): Promise<SaveDocResult> => {
    if (typeof docId !== 'string' || !docId) return { ok: false, error: 'Invalid docId' }
    try {
      await store.flush(docId)
      const state = store.stateOf(docId)
      return { ok: true, path: state?.path ?? '', name: state?.title ?? '' }
    } catch (error) {
      return fail(error)
    }
  })

  ipcMain.handle(
    'documents:putAsset',
    (_event, payload: unknown): { ok: true } | { ok: false; error: string } => {
      const rec = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
      if (
        typeof rec.docId !== 'string' ||
        typeof rec.hash !== 'string' ||
        typeof rec.base64 !== 'string'
      ) {
        return { ok: false, error: 'Invalid asset' }
      }
      try {
        store.putAsset(
          rec.docId,
          rec.hash,
          typeof rec.mime === 'string' ? rec.mime : 'application/octet-stream',
          base64ToBytes(rec.base64)
        )
        return { ok: true }
      } catch (error) {
        return fail(error)
      }
    }
  )

  ipcMain.handle('documents:getAssets', (_event, docId: unknown) => {
    if (typeof docId !== 'string' || !docId) return { ok: false, error: 'Invalid docId' }
    return {
      ok: true as const,
      assets: store.getAssets(docId).map((asset) => ({
        hash: asset.hash,
        mime: asset.mime,
        base64: bytesToBase64(asset.bytes)
      }))
    }
  })

  ipcMain.handle('documents:listing', async (): Promise<{ ok: true } & PersistListing> => {
    const listing = await store.listing()
    return { ok: true, ...listing }
  })

  ipcMain.handle('documents:removeRecent', async (_event, docId: unknown) => {
    if (typeof docId !== 'string' || !docId) return { ok: false, error: 'Invalid docId' }
    await store.removeRecent(docId)
    return { ok: true }
  })

  ipcMain.handle(
    'documents:locateRecent',
    async (event, docId: unknown): Promise<OpenDocResult> => {
      if (typeof docId !== 'string' || !docId) return { ok: false, error: 'Invalid docId' }
      const win = windowOf(event)
      if (!win) return { ok: false, error: 'No window' }
      const picked = await dialog.showOpenDialog(win, {
        title: 'Locate document',
        properties: ['openFile'],
        filters: collabFilters
      })
      if (picked.canceled || !picked.filePaths[0]) return { ok: false, error: 'canceled' }
      try {
        await store.removeRecent(docId)
        return await openPath(store, picked.filePaths[0])
      } catch (error) {
        return fail(error)
      }
    }
  )

  ipcMain.handle('documents:recover', async (_event, docId: unknown): Promise<OpenDocResult> => {
    if (typeof docId !== 'string' || !docId) return { ok: false, error: 'Invalid docId' }
    try {
      const opened = await store.recover(docId)
      return {
        ok: true,
        kind: 'collabdoc',
        docId: opened.docId,
        title: opened.title,
        path: '',
        warnings: opened.warnings
      }
    } catch (error) {
      return fail(error)
    }
  })

  ipcMain.handle('documents:discardDraft', async (_event, docId: unknown) => {
    if (typeof docId !== 'string' || !docId) return { ok: false, error: 'Invalid docId' }
    await store.discardDraft(docId)
    return { ok: true }
  })

  ipcMain.handle(
    'documents:rememberRecent',
    async (_event, payload: unknown): Promise<{ ok: true } | { ok: false; error: string }> => {
      const rec = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
      if (typeof rec.docId !== 'string' || typeof rec.title !== 'string') {
        return { ok: false, error: 'Invalid recent' }
      }
      await store.rememberRecent({
        docId: rec.docId,
        title: rec.title,
        path: typeof rec.path === 'string' ? rec.path : null,
        updatedAt: typeof rec.updatedAt === 'string' ? rec.updatedAt : new Date().toISOString(),
        preview: typeof rec.preview === 'string' ? rec.preview : ''
      })
      return { ok: true }
    }
  )

  ipcMain.handle(
    'documents:exportMarkdown',
    async (event, payload: unknown): Promise<SaveDocResult> => {
      const win = windowOf(event)
      if (!win) return { ok: false, error: 'No window' }
      const rec = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
      if (typeof rec.content !== 'string') return { ok: false, error: 'Invalid export' }
      const suggested = typeof rec.suggestedName === 'string' ? rec.suggestedName : 'Untitled.md'
      let filePath = typeof rec.path === 'string' && rec.path ? rec.path : ''
      if (!filePath) {
        const picked = await dialog.showSaveDialog(win, {
          title: 'Export Markdown',
          defaultPath: suggested,
          filters: markdownFilters
        })
        if (picked.canceled || !picked.filePath)
          return { ok: false, error: 'canceled', canceled: true }
        filePath = picked.filePath
      }
      try {
        await writeFile(filePath, rec.content, 'utf8')
        const extras = Array.isArray(rec.extras) ? rec.extras : []
        for (const extra of extras) {
          if (!extra || typeof extra !== 'object') continue
          const item = extra as { relativePath?: unknown; base64?: unknown }
          if (typeof item.relativePath !== 'string' || typeof item.base64 !== 'string') continue
          const extraPath = join(dirname(filePath), item.relativePath)
          await mkdir(dirname(extraPath), { recursive: true })
          await writeFile(extraPath, Buffer.from(item.base64, 'base64'))
        }
        return { ok: true, path: filePath, name: basename(filePath) }
      } catch (error) {
        return fail(error)
      }
    }
  )

  ipcMain.handle(
    'documents:exportDocx',
    async (event, payload: unknown): Promise<ExportDocxResult> => {
      const rec = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
      if (typeof rec.docId !== 'string' || !rec.docId) return { ok: false, error: 'Invalid docId' }
      const entry = registry.get(rec.docId)
      if (!entry) return { ok: false, error: 'Document is not open' }
      const config = normalizeDocxConfig(rec.config)
      const figures = Array.isArray(rec.figures) ? rec.figures : []
      let total = 0
      const MAX_ONE = 8 * 1024 * 1024
      const MAX_ALL = 64 * 1024 * 1024
      for (const figure of figures) {
        if (!figure || typeof figure !== 'object') continue
        const b64 = (figure as { pngBase64?: unknown }).pngBase64
        if (typeof b64 !== 'string' || !b64) continue
        const size = Math.floor((b64.length * 3) / 4)
        if (size > MAX_ONE) return { ok: false, error: 'A figure PNG is larger than 8 MB.' }
        total += size
        if (total > MAX_ALL) return { ok: false, error: 'Exported figures exceed 64 MB.' }
      }
      const win = windowOf(event)
      let filePath = typeof rec.path === 'string' && rec.path ? rec.path : ''
      if (!filePath) {
        if (!win) return { ok: false, error: 'No window' }
        const title = typeof rec.suggestedName === 'string' ? rec.suggestedName : 'Untitled.docx'
        const picked = await dialog.showSaveDialog(win, {
          title: 'Export Word document',
          defaultPath: title,
          filters: [{ name: 'Word document', extensions: ['docx'] }]
        })
        if (picked.canceled || !picked.filePath)
          return { ok: false, error: 'canceled', canceled: true }
        filePath = picked.filePath.endsWith('.docx') ? picked.filePath : `${picked.filePath}.docx`
      }
      try {
        const built = await buildDocx({
          doc: entry.hub.doc,
          config,
          figures: figures as import('@core/docx').RenderedFigure[],
          assets: store.getAssets(rec.docId).map((asset) => ({
            hash: asset.hash,
            mime: asset.mime,
            bytes: asset.bytes
          })),
          author: typeof rec.author === 'string' ? rec.author : ''
        })
        await atomicWriteFile(filePath, built.bytes)
        return {
          ok: true,
          path: filePath,
          name: basename(filePath),
          warnings: built.warnings
        }
      } catch (error) {
        return fail(error)
      }
    }
  )
}

async function openPath(store: DocumentStore, filePath: string): Promise<OpenDocResult> {
  try {
    if (isCollabdocPath(filePath)) {
      const opened = await store.openCollabdoc(filePath)
      return {
        ok: true,
        kind: 'collabdoc',
        docId: opened.docId,
        title: opened.title,
        path: opened.path,
        warnings: opened.warnings
      }
    }
    return importMarkdown(store, filePath)
  } catch (error) {
    return fail(error)
  }
}

async function importMarkdown(store: DocumentStore, filePath: string): Promise<OpenDocResult> {
  try {
    const markdown = await readFile(filePath, 'utf8')
    const title = titleFromMarkdown(markdown) || titleFromFileName(filePath)
    const created = store.create({ title })
    store.markImportedFrom(created.docId, filePath)
    return {
      ok: true,
      kind: 'markdown',
      docId: created.docId,
      title: created.title,
      markdown,
      sourcePath: filePath
    }
  } catch (error) {
    return fail(error)
  }
}

function titleFromMarkdown(raw: string): string {
  const match = raw.match(/^#\s+(.+)\r?\n?/)
  return match?.[1]?.trim() ?? ''
}

async function saveAs(
  event: IpcMainInvokeEvent,
  store: DocumentStore,
  docId: string
): Promise<SaveDocResult> {
  const win = windowOf(event)
  if (!win) return { ok: false, error: 'No window' }
  const state = store.stateOf(docId)
  const fallback = defaultCollabdocPath(
    store.documentsDir || join(homedir(), 'Documents', 'CollabDoc'),
    state?.title || 'Untitled'
  )
  const picked = await dialog.showSaveDialog(win, {
    title: 'Save document',
    defaultPath: store.suggestedSavePath(docId, state?.title || 'Untitled') || fallback,
    filters: [
      { name: 'CollabDoc', extensions: ['collabdoc'] },
      { name: 'Markdown', extensions: ['md'] },
      { name: 'Word document', extensions: ['docx'] }
    ]
  })
  if (picked.canceled || !picked.filePath) return { ok: false, error: 'canceled', canceled: true }
  const ext = extname(picked.filePath).toLowerCase()
  if (ext === '.md' || ext === '.markdown') {
    return { ok: true, exportTo: { format: 'markdown', path: picked.filePath } }
  }
  if (ext === '.docx') {
    return { ok: true, exportTo: { format: 'docx', path: picked.filePath } }
  }
  try {
    const saved = await store.saveTo(docId, picked.filePath)
    return { ok: true, ...saved }
  } catch (error) {
    return fail(error)
  }
}

export function broadcastState(state: PersistState): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(STATE_CHANNEL, state)
  }
}

export function broadcastListing(listing: PersistListing): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(LISTING_CHANNEL, listing)
  }
}

export function sendCommand(win: BrowserWindow, command: string): void {
  win.webContents.send(COMMAND_CHANNEL, command)
}
