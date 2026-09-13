import type { JSONContent } from '@tiptap/core'
import { extForMime, restoreAssets, setAssetDocument } from '../editor/assets'
import { DocumentClient } from './DocumentClient'
import { documentHost } from './host'
import { localProfile } from './identity'

/**
 * The documents this window has open, by id. The reducer keeps only ids and
 * chrome state; anything that needs the content asks here.
 */
const clients = new Map<string, DocumentClient>()

const CURRENT_KEY = 'collabdoc.currentDoc'

export function getClient(docId: string): DocumentClient | undefined {
  return clients.get(docId)
}

/**
 * Attach to a document in the host and wait for its snapshot. `seed` writes
 * file content into a freshly created document before anyone edits it.
 */
export async function openClient(
  docId: string,
  options: { seed?: JSONContent } = {}
): Promise<DocumentClient> {
  const existing = clients.get(docId)
  if (existing && existing.status !== 'detached') return existing
  const client = new DocumentClient(docId, localProfile())
  clients.set(docId, client)
  setAssetDocument(docId)
  const port = await documentHost().attach(docId)
  client.bind(port)
  const live = await client.whenLive()
  if (!live) {
    clients.delete(docId)
    throw new Error('The document detached before it was ready.')
  }
  if (!options.seed) await hydrateHostAssets(docId)
  if (options.seed) client.seed(options.seed)
  rememberCurrent(docId)
  return client
}

async function hydrateHostAssets(docId: string): Promise<void> {
  const result = await window.api?.documents.getAssets?.(docId)
  if (!result || !('ok' in result) || !result.ok) return
  const records: Record<string, { sha256: string; mime: string; ext: string; data: string }> = {}
  for (const asset of result.assets) {
    records[asset.hash] = {
      sha256: asset.hash,
      mime: asset.mime,
      ext: extForMime(asset.mime),
      data: asset.base64
    }
  }
  restoreAssets(records)
}

export async function createAndOpen(options: {
  title?: string
  seed?: JSONContent
}): Promise<DocumentClient> {
  const created = await documentHost().create({ title: options.title })
  return openClient(created.docId, { seed: options.seed })
}

export async function closeClient(docId: string): Promise<void> {
  const client = clients.get(docId)
  clients.delete(docId)
  client?.detach()
  if (currentDocId() === docId) rememberCurrent(null)
  await documentHost().release(docId)
}

/** The document this window had open, so a reload can re-attach (AC-03.7). */
export function currentDocId(): string | null {
  try {
    return sessionStorage.getItem(CURRENT_KEY)
  } catch {
    return null
  }
}

function rememberCurrent(docId: string | null): void {
  try {
    if (docId) sessionStorage.setItem(CURRENT_KEY, docId)
    else sessionStorage.removeItem(CURRENT_KEY)
  } catch {
    /* session storage unavailable: reload recovery is best-effort */
  }
}

export function resetClientsForTests(): void {
  for (const client of clients.values()) client.detach()
  clients.clear()
  rememberCurrent(null)
}
