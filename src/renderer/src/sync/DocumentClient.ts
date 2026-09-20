import type { JSONContent } from '@tiptap/core'
import { LoroDoc, type UndoManager, type VersionVector } from 'loro-crdt'
import { ensureAuthor, writeAuthor } from '@core/authors'
import { commitTimestamp, configureDocument, readMeta, setDocxConfig as writeDocxConfig } from '@core/document'
import type { DocxExportConfig } from '@shared/docx-config'
import { createUndoManager } from '@core/undo'
import { PresenceStore } from './presence-store'
import { AUTHOR_ORIGIN, META_KEY, UNDO_STEP_MAX_MS } from '@shared/constants'
import { decodeDocFrame, encodeDocFrame, FrameError } from '@shared/protocol'
import type { ActorProfile } from '@shared/types'
import type { Frontier } from '@core/history'
import { docJsonFromLoro, writeJsonToLoro } from './doc-json'

export type ClientStatus = 'connecting' | 'live' | 'detached'

export type ClientEvent =
  | { type: 'status'; status: ClientStatus }
  | { type: 'title'; title: string }
  | { type: 'dirty'; dirty: boolean }
  | { type: 'change'; by: 'local' | 'import' | 'checkout' }
  | { type: 'presence' }

type Listener = (event: ClientEvent) => void

/**
 * The renderer's copy of one document.
 *
 * Owns a `LoroDoc` mirrored from the hub over a `MessagePort`, the presence
 * store the cursor plugin writes into, and the undo manager scoped to this
 * person's own commits. Tiptap binds to `doc` through `LoroCollab`; nothing
 * else in the renderer holds document content.
 *
 *   connecting ── snapshot frame ──▶ live ── port closes / detach() ──▶ detached
 */
export class DocumentClient {
  readonly docId: string
  readonly doc: LoroDoc
  readonly presence: PresenceStore
  readonly undoManager: UndoManager
  private profileValue: ActorProfile
  private port: MessagePort | null = null
  private statusValue: ClientStatus = 'connecting'
  private titleValue = ''
  private savedVersion: VersionVector | null = null
  private dirtyValue = false
  private readonly listeners = new Set<Listener>()
  private readonly unsubscribe: Array<() => void> = []
  private snapshotWaiters: Array<(ok: boolean) => void> = []

  get profile(): ActorProfile {
    return this.profileValue
  }

  constructor(docId: string, profile: ActorProfile) {
    this.docId = docId
    this.profileValue = profile
    this.doc = new LoroDoc()
    configureDocument(this.doc)
    this.presence = new PresenceStore(this.doc.peerIdStr)
    this.presence.setUser(profile)
    // Undo steps are cut where history entries are — 1 s idle or a block
    // switch — by the editor (see `humanCommitCutter`), not by Loro's clock.
    this.undoManager = createUndoManager(this.doc, { mergeInterval: UNDO_STEP_MAX_MS })

    this.unsubscribe.push(
      this.doc.subscribeLocalUpdates((bytes) => this.send('update', bytes)),
      this.presence.subscribeLocalUpdates((bytes) => this.send('ephemeral', bytes)),
      this.presence.subscribeBy(() => this.emit({ type: 'presence' })),
      this.doc.subscribe((event) => {
        const meta = this.doc.getMap(META_KEY)
        const title = meta.get('title')
        if (typeof title === 'string' && title !== this.titleValue) {
          this.titleValue = title
          this.emit({ type: 'title', title })
        }
        this.refreshDirty()
        this.emit({ type: 'change', by: event.by })
      })
    )
  }

  get status(): ClientStatus {
    return this.statusValue
  }

  get title(): string {
    return this.titleValue
  }

  get dirty(): boolean {
    return this.dirtyValue
  }

  /** Resolves once the first snapshot has been imported. */
  whenLive(): Promise<boolean> {
    if (this.statusValue === 'live') return Promise.resolve(true)
    if (this.statusValue === 'detached') return Promise.resolve(false)
    return new Promise((resolve) => this.snapshotWaiters.push(resolve))
  }

  bind(port: MessagePort): void {
    if (this.port) throw new Error('DocumentClient is already bound to a port.')
    this.port = port
    port.onmessage = (event) => this.receive(event.data)
    port.addEventListener('close', () => this.detach())
    port.start()
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * A discrete, attributed, undoable change (a comment action): its own
   * history entry and its own undo step. The undo interval is left at 0 so
   * the next keystroke starts a new step too; the editor's commit cutter
   * restores the ceiling after that commit (see `humanCommitCutter`).
   */
  commitStep(message: string, write: () => void): void {
    this.undoManager.setMergeInterval(0)
    write()
    this.doc.commit({
      origin: `actor:${this.profile.actorId}`,
      message,
      timestamp: commitTimestamp()
    })
  }

  /** Bookkeeping the app does on its own behalf: synced, never an undo step. */
  commitSystem(origin: string, write: () => void): void {
    write()
    this.doc.commit({ origin, timestamp: commitTimestamp() })
  }

  setTitle(title: string): void {
    if (this.statusValue !== 'live') return
    if (readMeta(this.doc).title === title) return
    this.doc.getMap(META_KEY).set('title', title)
    this.doc.commit({
      origin: `actor:${this.profile.actorId}`,
      message: 'rename',
      timestamp: commitTimestamp()
    })
  }

  setDocxConfig(config: DocxExportConfig): void {
    if (this.statusValue !== 'live') return
    writeDocxConfig(this.doc, config, `actor:${this.profile.actorId}`)
  }

  /** Replace an empty document's body with parsed file content, as one commit. */
  seed(content: JSONContent): void {
    writeJsonToLoro(this.doc, content)
    this.markClean()
  }

  /** JSON of the document at `frontiers`, on a throwaway fork. */
  previewJson(frontiers: Frontier[]): JSONContent | null {
    if (frontiers.length === 0) return null
    try {
      return docJsonFromLoro(this.doc.forkAt(frontiers))
    } catch {
      return null
    }
  }

  toJSON(): JSONContent {
    return docJsonFromLoro(this.doc)
  }

  markClean(): void {
    this.savedVersion = this.doc.version()
    this.refreshDirty()
  }

  setProfile(profile: ActorProfile): void {
    this.profileValue = profile
    this.presence.setUser(profile)
    writeAuthor(this.doc, {
      actorId: profile.actorId,
      name: profile.name,
      color: profile.color,
      role: profile.role,
      handle: profile.handle
    })
    this.doc.commit({ origin: AUTHOR_ORIGIN, timestamp: commitTimestamp() })
  }

  detach(): void {
    if (this.statusValue === 'detached') return
    this.setStatus('detached')
    for (const waiter of this.snapshotWaiters.splice(0)) waiter(false)
    for (const stop of this.unsubscribe.splice(0)) stop()
    this.presence.clear()
    this.port?.close()
    this.port = null
  }

  private receive(data: unknown): void {
    let frame
    try {
      frame = decodeDocFrame(data)
    } catch (error) {
      console.warn(
        `[collabdoc] dropped a malformed frame from the hub: ${error instanceof FrameError ? error.reason : 'error'}`
      )
      return
    }
    try {
      if (frame.kind === 'ephemeral') {
        this.presence.inner.apply(frame.bytes)
        return
      }
      this.doc.import(frame.bytes)
    } catch (error) {
      console.warn(`[collabdoc] could not apply a ${frame.kind} frame`, error)
      return
    }
    if (frame.kind === 'snapshot' && this.statusValue === 'connecting') {
      this.titleValue = readMeta(this.doc).title
      // Attribution: this peer is in the document's authors map from now on.
      ensureAuthor(this.doc, {
        actorId: this.profile.actorId,
        name: this.profile.name,
        color: this.profile.color,
        role: this.profile.role,
        handle: this.profile.handle
      })
      this.presence.startHeartbeat()
      this.markClean()
      this.setStatus('live')
      for (const waiter of this.snapshotWaiters.splice(0)) waiter(true)
      this.emit({ type: 'title', title: this.titleValue })
    }
  }

  private send(kind: 'update' | 'ephemeral', bytes: Uint8Array): void {
    if (!this.port || this.statusValue === 'detached') return
    try {
      this.port.postMessage(encodeDocFrame(kind, bytes))
    } catch (error) {
      console.warn(`[collabdoc] could not send ${kind} frame`, error)
    }
  }

  private refreshDirty(): void {
    const dirty = this.savedVersion ? this.doc.version().compare(this.savedVersion) !== 0 : false
    if (dirty !== this.dirtyValue) {
      this.dirtyValue = dirty
      this.emit({ type: 'dirty', dirty })
    }
  }

  private setStatus(status: ClientStatus): void {
    if (this.statusValue === status) return
    this.statusValue = status
    this.emit({ type: 'status', status })
  }

  private emit(event: ClientEvent): void {
    for (const listener of this.listeners) listener(event)
  }
}
