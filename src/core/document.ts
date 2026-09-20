import { LoroDoc, LoroList, LoroMap, LoroText } from 'loro-crdt'
import {
  ATTRIBUTES_KEY,
  BLOCK_ID_ATTR,
  CHILDREN_KEY,
  CHANGE_MERGE_INTERVAL,
  INIT_ORIGIN,
  META_KEY,
  NODE_NAME_KEY,
  ROOT_DOC_KEY,
  SCHEMA_VERSION,
  TEXT_STYLE_CONFIG
} from '../shared/constants'
import { newBlockId, newDocId } from '../shared/ids'
import { normalizeDocxConfig, type DocxExportConfig } from '../shared/docx-config'

export type DocumentMeta = {
  docId: string
  title: string
  schemaVersion: number
  createdAt: number
}

/**
 * Every `LoroDoc` we hold — hub, session forks, guests — goes through here so
 * timestamps are recorded and marks expand the same way everywhere.
 */
export function configureDocument(doc: LoroDoc): void {
  doc.setRecordTimestamp(true)
  doc.configTextStyle(TEXT_STYLE_CONFIG)
  doc.setChangeMergeInterval(CHANGE_MERGE_INTERVAL)
}

/**
 * The timestamp for every commit this app makes.
 *
 * Loro documents its timestamps as seconds; ours are milliseconds, and that
 * is deliberate, not an oversight to fix: Loro forces timestamps to ascend,
 * so a seconds value committed after any millisecond one is clamped up to it
 * and every later change reports the same frozen time. Existing documents
 * (and `loro-prosemirror`'s own init commit) already hold milliseconds, so
 * the whole app stamps in milliseconds through this one function and
 * `normalizeTimestamp` in history accepts either unit when reading.
 */
export function commitTimestamp(): number {
  return Date.now()
}

/**
 * A new, empty document: metadata plus one empty paragraph. The peer id is
 * whatever Loro picked at random — never a fixed one, so documents that later
 * meet (a guest re-hosting) cannot collide.
 */
export function createDocument(options: { docId?: string; title?: string } = {}): LoroDoc {
  const doc = new LoroDoc()
  configureDocument(doc)

  const meta = doc.getMap(META_KEY)
  meta.set('docId', options.docId ?? newDocId())
  meta.set('title', options.title ?? 'Untitled')
  meta.set('schemaVersion', SCHEMA_VERSION)
  meta.set('createdAt', Date.now())

  const root = doc.getMap(ROOT_DOC_KEY)
  root.set(NODE_NAME_KEY, 'doc')
  root.getOrCreateContainer(ATTRIBUTES_KEY, new LoroMap())
  const children = root.getOrCreateContainer(CHILDREN_KEY, new LoroList())
  const paragraph = children.insertContainer(0, new LoroMap())
  paragraph.set(NODE_NAME_KEY, 'paragraph')
  paragraph.getOrCreateContainer(ATTRIBUTES_KEY, new LoroMap()).set(BLOCK_ID_ATTR, newBlockId())
  // An empty text child from the start. `loro-prosemirror` would create the
  // container with the first keystroke, and undoing that keystroke would then
  // remove the container — and any text a collaborator typed into it.
  paragraph.getOrCreateContainer(CHILDREN_KEY, new LoroList()).insertContainer(0, new LoroText())

  doc.commit({ origin: INIT_ORIGIN, message: 'create document', timestamp: commitTimestamp() })
  return doc
}

/** A configured doc loaded from a snapshot or update bytes. */
export function openDocument(bytes: Uint8Array): LoroDoc {
  const doc = new LoroDoc()
  configureDocument(doc)
  doc.import(bytes)
  return doc
}

export function readMeta(doc: LoroDoc): DocumentMeta {
  const meta = doc.getMap(META_KEY)
  const docId = meta.get('docId')
  const title = meta.get('title')
  const schemaVersion = meta.get('schemaVersion')
  const createdAt = meta.get('createdAt')
  return {
    docId: typeof docId === 'string' ? docId : '',
    title: typeof title === 'string' ? title : '',
    schemaVersion: typeof schemaVersion === 'number' ? schemaVersion : 0,
    createdAt: typeof createdAt === 'number' ? createdAt : 0
  }
}

/** Titles are short and conflicts rare, so a plain last-writer-wins value. */
export function setTitle(doc: LoroDoc, title: string, origin: string): void {
  doc.getMap(META_KEY).set('title', title)
  commitBoundary(doc, { origin, message: `rename to “${title}”` })
}

const DOCX_EXPORT_KEY = 'docxExport'

/** Stored export settings, or `null` when the document has never set them. */
export function readDocxConfig(doc: LoroDoc): DocxExportConfig | null {
  const raw = doc.getMap(META_KEY).get(DOCX_EXPORT_KEY)
  if (raw == null) return null
  if (typeof raw === 'string') {
    try {
      return normalizeDocxConfig(JSON.parse(raw) as unknown)
    } catch {
      return normalizeDocxConfig(undefined)
    }
  }
  return normalizeDocxConfig(raw)
}

export function setDocxConfig(doc: LoroDoc, config: DocxExportConfig, origin: string): void {
  const normalized = normalizeDocxConfig(config)
  doc.getMap(META_KEY).set(DOCX_EXPORT_KEY, JSON.stringify(normalized))
  commitBoundary(doc, { origin, message: 'docx export settings' })
}

/**
 * A commit that is its own history entry (agent tools, checkpoints, renames).
 * Loro never merges changes whose messages differ, and the fresh stamp keeps
 * it apart from a same-message neighbour. Human typing is cut differently —
 * see `humanCommitCutter` in the editor.
 */
export function commitBoundary(doc: LoroDoc, options: { origin: string; message: string }): void {
  doc.commit({ ...options, timestamp: commitTimestamp() })
}
