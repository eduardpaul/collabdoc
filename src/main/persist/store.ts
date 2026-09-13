import { access, readdir, readFile, stat, unlink } from 'fs/promises'
import { join } from 'path'
import { VersionVector } from 'loro-crdt'
import {
  CollabdocError,
  decodeCollabdoc,
  encodeCollabdoc,
  readCollabdocHeader,
  type PackedAsset
} from '../../core/collabdoc-file'
import { readMeta } from '../../core/document'
import { SyncHub } from '../../core/hub'
import { DocumentRegistry } from '../../core/registry'
import { documentPreview, listAssets } from '../../core/tree'
import { SCHEMA_VERSION } from '../../shared/constants'
import { atomicWriteFile } from './atomic'
import { AutosaveScheduler } from './autosave'
import { DocumentAssets, type StoredAsset } from './assets'
import { defaultCollabdocPath, draftPath, draftsDir, recentsPath } from './paths'
import {
  loadRecentsFile,
  saveRecentsFile,
  upsertRecent,
  type RecentListing,
  type RecentRecord
} from './recents'

export type PersistState = {
  docId: string
  title: string
  path: string | null
  isDraft: boolean
  dirty: boolean
  hasDraft: boolean
}

export type OpenedCollabdoc = {
  docId: string
  title: string
  path: string
  warnings: string[]
}

export type RecoveryOffer = {
  docId: string
  title: string
  updatedAt: string
}

export type PersistListing = {
  recents: RecentListing[]
  recoveries: RecoveryOffer[]
}

export type DocumentStoreOptions = {
  registry: DocumentRegistry
  userData: string
  documentsDir: string
  sendState?: (state: PersistState) => void
  sendListing?: (listing: PersistListing) => void
  idleMs?: number
  maxMs?: number
  now?: () => number
}

type Tracked = {
  docId: string
  path: string | null
  isDraft: boolean
  dirty: boolean
  hasDraft: boolean
  savedVersion: VersionVector
  unsub: () => void
  suggestedPath: string | null
  written: boolean
}

function versionsDiffer(current: VersionVector, saved: VersionVector): boolean {
  return current.compare(saved) !== 0
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

export class DocumentStore {
  readonly registry: DocumentRegistry
  readonly userData: string
  readonly documentsDir: string
  readonly assets = new DocumentAssets()
  private readonly tracked = new Map<string, Tracked>()
  private recents: RecentRecord[] = []
  private readonly sendState?: (state: PersistState) => void
  private readonly sendListing?: (listing: PersistListing) => void
  private readonly now: () => number
  private readonly scheduler: AutosaveScheduler
  private loaded = false

  constructor(options: DocumentStoreOptions) {
    this.registry = options.registry
    this.userData = options.userData
    this.documentsDir = options.documentsDir
    this.sendState = options.sendState
    this.sendListing = options.sendListing
    this.now = options.now ?? Date.now
    this.scheduler = new AutosaveScheduler({
      save: (docId) => this.write(docId),
      idleMs: options.idleMs,
      maxMs: options.maxMs
    })
  }

  async init(): Promise<void> {
    if (this.loaded) return
    this.recents = await loadRecentsFile(recentsPath(this.userData))
    this.loaded = true
  }

  create(options: { title?: string } = {}): { docId: string; title: string } {
    const entry = this.registry.create(options)
    this.watch(entry.docId, { path: null, isDraft: true })
    return { docId: entry.docId, title: readMeta(entry.hub.doc).title }
  }

  async openCollabdoc(filePath: string): Promise<OpenedCollabdoc> {
    const raw = await readFile(filePath)
    const decoded = decodeCollabdoc(raw)
    const existing = this.registry.get(decoded.header.docId)
    if (existing) {
      this.watch(existing.docId, { path: filePath, isDraft: false })
      this.loadDecodedAssets(existing.docId, decoded.assets)
      return {
        docId: existing.docId,
        title: readMeta(existing.hub.doc).title,
        path: filePath,
        warnings: decoded.warnings
      }
    }
    const hub = SyncHub.fromSnapshot(decoded.snapshot)
    const meta = readMeta(hub.doc)
    this.registry.register(hub)
    this.watch(meta.docId, { path: filePath, isDraft: false, clean: true })
    this.loadDecodedAssets(meta.docId, decoded.assets)
    await this.touchRecent(meta.docId, {
      title: meta.title,
      path: filePath,
      preview: documentPreview(hub.doc)
    })
    const session = this.tracked.get(meta.docId)
    if (session) session.written = true
    return {
      docId: meta.docId,
      title: meta.title,
      path: filePath,
      warnings: decoded.warnings
    }
  }

  suggestedSavePath(docId: string, title: string): string {
    const session = this.tracked.get(docId)
    if (session?.suggestedPath) return session.suggestedPath
    if (session?.path) return session.path
    return defaultCollabdocPath(this.documentsDir, title)
  }

  markImportedFrom(docId: string, markdownPath: string): void {
    const session = this.tracked.get(docId)
    if (!session) return
    session.suggestedPath = markdownPath.replace(/\.(md|markdown|txt)$/i, '.collabdoc')
  }

  stateOf(docId: string): PersistState | null {
    const session = this.tracked.get(docId)
    if (!session) return null
    return this.toState(session)
  }

  putAsset(docId: string, hash: string, mime: string, bytes: Uint8Array): void {
    this.assets.put(docId, hash, mime, bytes)
  }

  getAssets(docId: string): StoredAsset[] {
    return this.assets.list(docId)
  }

  async save(docId: string): Promise<{ path: string; name: string } | { needsSaveAs: true }> {
    const session = this.tracked.get(docId)
    if (!session) throw new Error('Document is not open')
    if (session.isDraft || !session.path) return { needsSaveAs: true }
    await this.write(docId)
    return { path: session.path, name: fileName(session.path) }
  }

  async saveTo(docId: string, filePath: string): Promise<{ path: string; name: string }> {
    const session = this.tracked.get(docId)
    if (!session) throw new Error('Document is not open')
    const previousDraft = session.isDraft ? draftPath(this.userData, docId) : null
    session.path = filePath
    session.isDraft = false
    session.suggestedPath = null
    await this.write(docId)
    if (previousDraft && previousDraft !== filePath) {
      await unlink(previousDraft).catch(() => undefined)
      session.hasDraft = false
    }
    this.emitState(session)
    return { path: filePath, name: fileName(filePath) }
  }

  async flush(docId: string): Promise<void> {
    await this.scheduler.flush(docId)
  }

  async flushAll(): Promise<void> {
    await this.scheduler.flushAll()
  }

  async discardDraft(docId: string): Promise<void> {
    this.scheduler.clear(docId)
    const file = draftPath(this.userData, docId)
    await unlink(file).catch(() => undefined)
    const session = this.tracked.get(docId)
    if (session) {
      session.hasDraft = false
      session.written = false
    }
    this.recents = this.recents.filter((item) => item.docId !== docId)
    await this.persistRecents()
  }

  async recover(docId: string): Promise<OpenedCollabdoc> {
    const file = draftPath(this.userData, docId)
    const raw = await readFile(file)
    const decoded = decodeCollabdoc(raw)
    const existing = this.registry.get(decoded.header.docId)
    if (existing) {
      this.watch(existing.docId, { path: null, isDraft: true })
      this.loadDecodedAssets(existing.docId, decoded.assets)
      const session = this.tracked.get(existing.docId)
      if (session) session.hasDraft = true
      return {
        docId: existing.docId,
        title: readMeta(existing.hub.doc).title,
        path: file,
        warnings: decoded.warnings
      }
    }
    const hub = SyncHub.fromSnapshot(decoded.snapshot)
    const meta = readMeta(hub.doc)
    this.registry.register(hub)
    this.watch(meta.docId, { path: null, isDraft: true, clean: true })
    this.loadDecodedAssets(meta.docId, decoded.assets)
    const session = this.tracked.get(meta.docId)
    if (session) {
      session.hasDraft = true
      session.written = true
    }
    return {
      docId: meta.docId,
      title: meta.title,
      path: file,
      warnings: decoded.warnings
    }
  }

  async listing(): Promise<PersistListing> {
    await this.init()
    const recents: RecentListing[] = []
    for (const item of this.recents) {
      const missing = item.path ? !(await fileExists(item.path)) : false
      recents.push(missing ? { ...item, missing: true } : item)
    }
    recents.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
    return { recents, recoveries: await this.recoveries() }
  }

  async removeRecent(docId: string): Promise<void> {
    this.recents = this.recents.filter((item) => item.docId !== docId)
    await this.persistRecents()
  }

  async relocate(docId: string, filePath: string): Promise<OpenedCollabdoc> {
    await this.removeRecent(docId)
    return this.openCollabdoc(filePath)
  }

  async rememberRecent(entry: RecentRecord): Promise<void> {
    await this.init()
    this.recents = upsertRecent(this.recents, entry)
    await this.persistRecents()
  }

  async release(docId: string): Promise<void> {
    const session = this.tracked.get(docId)
    if (session?.dirty) await this.write(docId)
    this.scheduler.clear(docId)
    session?.unsub()
    this.tracked.delete(docId)
    this.assets.drop(docId)
  }

  dispose(): void {
    this.scheduler.dispose()
    for (const session of this.tracked.values()) session.unsub()
    this.tracked.clear()
  }

  private watch(
    docId: string,
    options: { path: string | null; isDraft: boolean; clean?: boolean }
  ): void {
    const existing = this.tracked.get(docId)
    if (existing) {
      existing.path = options.path
      existing.isDraft = options.isDraft
      if (options.clean) {
        const entry = this.registry.get(docId)
        if (entry) existing.savedVersion = cloneVersion(entry.hub.doc.version())
        existing.dirty = false
      }
      this.emitState(existing)
      return
    }
    const entry = this.registry.get(docId)
    if (!entry) return
    const savedVersion = cloneVersion(entry.hub.doc.version())
    const session: Tracked = {
      docId,
      path: options.path,
      isDraft: options.isDraft,
      dirty: false,
      hasDraft: false,
      savedVersion,
      unsub: () => undefined,
      suggestedPath: null,
      written: Boolean(options.clean && !options.isDraft)
    }
    const onChange = (): void => {
      const live = this.registry.get(docId)
      if (!live) return
      const dirty = versionsDiffer(live.hub.doc.version(), session.savedVersion)
      if (dirty !== session.dirty) {
        session.dirty = dirty
        this.emitState(session)
      }
      if (dirty) this.scheduler.touch(docId)
    }
    const unsubDoc = entry.hub.doc.subscribe(onChange)
    const unsubHub = entry.hub.subscribe(`persist:${docId}`, (event) => {
      if (event.type === 'update') onChange()
    })
    session.unsub = () => {
      unsubDoc()
      unsubHub()
    }
    this.tracked.set(docId, session)
    this.emitState(session)
  }

  private async write(docId: string): Promise<void> {
    const session = this.tracked.get(docId)
    const entry = this.registry.get(docId)
    if (!session || !entry) return
    const meta = readMeta(entry.hub.doc)
    const target = session.isDraft || !session.path ? draftPath(this.userData, docId) : session.path
    const referenced = listAssets(entry.hub.doc)
    const packed: PackedAsset[] = this.assets.referenced(docId, referenced).map((asset) => ({
      hash: asset.hash,
      type: asset.mime,
      bytes: asset.bytes
    }))
    const bytes = encodeCollabdoc({
      docId: meta.docId,
      title: meta.title,
      schemaVersion: meta.schemaVersion || SCHEMA_VERSION,
      savedAt: this.now(),
      snapshot: entry.hub.snapshot(),
      assets: packed
    })
    await atomicWriteFile(target, bytes)
    session.savedVersion = cloneVersion(entry.hub.doc.version())
    session.dirty = false
    session.written = true
    if (session.isDraft) session.hasDraft = true
    await this.touchRecent(docId, {
      title: meta.title,
      path: session.isDraft ? null : target,
      preview: documentPreview(entry.hub.doc)
    })
    this.emitState(session)
  }

  private loadDecodedAssets(docId: string, assets: PackedAsset[]): void {
    for (const asset of assets) {
      this.assets.put(docId, asset.hash, asset.type, asset.bytes)
    }
  }

  private async recoveries(): Promise<RecoveryOffer[]> {
    let names: string[] = []
    try {
      names = await readdir(draftsDir(this.userData))
    } catch {
      return []
    }
    const offers: RecoveryOffer[] = []
    for (const name of names) {
      if (!name.endsWith('.collabdoc')) continue
      const file = join(draftsDir(this.userData), name)
      try {
        const raw = await readFile(file)
        const header = readCollabdocHeader(raw)
        const recent = this.recents.find((item) => item.docId === header.docId)
        const info = await stat(file)
        const draftAt = info.mtimeMs
        const recentAt = recent ? Date.parse(recent.updatedAt) : 0
        if (recent && !Number.isNaN(recentAt) && draftAt <= recentAt + 500) continue
        offers.push({
          docId: header.docId,
          title: header.title || 'Untitled',
          updatedAt: new Date(draftAt).toISOString()
        })
      } catch (error) {
        if (error instanceof CollabdocError) continue
      }
    }
    return offers
  }

  private async touchRecent(
    docId: string,
    fields: { title: string; path: string | null; preview: string }
  ): Promise<void> {
    await this.init()
    this.recents = upsertRecent(this.recents, {
      docId,
      title: fields.title,
      path: fields.path,
      updatedAt: new Date(this.now()).toISOString(),
      preview: fields.preview
    })
    await this.persistRecents()
  }

  private async persistRecents(): Promise<void> {
    await saveRecentsFile(recentsPath(this.userData), this.recents)
    const listing = await this.listing()
    this.sendListing?.(listing)
  }

  private emitState(session: Tracked): void {
    this.sendState?.(this.toState(session))
  }

  private toState(session: Tracked): PersistState {
    const entry = this.registry.get(session.docId)
    return {
      docId: session.docId,
      title: entry ? readMeta(entry.hub.doc).title : '',
      path: session.isDraft ? null : session.path,
      isDraft: session.isDraft,
      dirty: session.dirty,
      hasDraft: session.hasDraft
    }
  }
}

function fileName(filePath: string): string {
  return filePath.split(/[/\\]/).pop() ?? filePath
}

function cloneVersion(version: VersionVector): VersionVector {
  return VersionVector.decode(version.encode())
}
