import {
  ipcMain,
  MessageChannelMain,
  type IpcMainInvokeEvent,
  type MessagePortMain
} from 'electron'
import { is } from '@electron-toolkit/utils'
import type { FrameLink } from '@core/link'
import { DocumentRegistry, type RegistryDebugEntry } from '@core/registry'

/** The message the preload forwards to the page along with the port. */
export const PORT_CHANNEL = 'documents:port'
export const PORT_MESSAGE_TYPE = 'collabdoc:port'

export type CreateResult = { ok: true; docId: string; title: string } | { ok: false; error: string }
export type AttachResult = { ok: true; docId: string } | { ok: false; error: string }
export type ReleaseResult = { ok: true } | { ok: false; error: string }
export type DebugResult =
  { ok: true; documents: RegistryDebugEntry[] } | { ok: false; error: string }

const MAX_TITLE_CHARS = 200

function portLink(port: MessagePortMain): FrameLink {
  return {
    send: (frame) => port.postMessage(frame),
    onMessage: (listener) => port.on('message', (event) => listener(event.data)),
    onClose: (listener) => port.on('close', listener),
    close: () => port.close()
  }
}

/**
 * One subscriber id per (webContents, document): a renderer that reloads
 * comes back as the same subscriber, which is what makes "already attached"
 * a real error rather than a race we paper over.
 */
function subscriberId(event: IpcMainInvokeEvent, docId: string): string {
  return `renderer:${event.sender.id}:${docId}`
}

export function registerDocumentIpc(registry: DocumentRegistry): void {
  const detachers = new Map<string, () => void>()

  ipcMain.handle('documents:create', (_event, payload: unknown): CreateResult => {
    const options = payload && typeof payload === 'object' ? (payload as { title?: unknown }) : {}
    const title =
      typeof options.title === 'string' ? options.title.slice(0, MAX_TITLE_CHARS) : undefined
    try {
      const entry = registry.create({ title })
      return { ok: true, docId: entry.docId, title: title ?? 'Untitled' }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Could not create' }
    }
  })

  ipcMain.handle('documents:attach', (event, docId: unknown): AttachResult => {
    if (typeof docId !== 'string' || !docId) return { ok: false, error: 'Invalid docId' }
    if (!registry.has(docId)) return { ok: false, error: 'Document is not open' }
    const id = subscriberId(event, docId)
    // A reload closes the old port; if its close event has not landed yet,
    // drop the stale binding rather than refusing the fresh one.
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
      return { ok: false, error: error instanceof Error ? error.message : 'Could not attach' }
    }
  })

  ipcMain.handle('documents:release', (event, docId: unknown): ReleaseResult => {
    if (typeof docId !== 'string' || !docId) return { ok: false, error: 'Invalid docId' }
    detachers.get(subscriberId(event, docId))?.()
    // An explicit close from the UI: no grace period.
    const entry = registry.get(docId)
    if (entry && entry.subscribers.size === 0) registry.close(docId)
    return { ok: true }
  })

  ipcMain.handle('documents:debug', (): DebugResult => {
    if (!is.dev) return { ok: false, error: 'Only available in development' }
    return { ok: true, documents: registry.debug() }
  })
}
