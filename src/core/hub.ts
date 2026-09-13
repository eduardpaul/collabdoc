import { EphemeralStore, LoroDoc, VersionVector } from 'loro-crdt'
import { HUB_ORIGIN, PRESENCE_TIMEOUT_MS } from '../shared/constants'
import { commitTimestamp, createDocument, openDocument } from './document'

export type HubEvent =
  | { type: 'update'; from: string; bytes: Uint8Array }
  | { type: 'ephemeral'; from: string; bytes: Uint8Array }

type Listener = (event: HubEvent) => void

/** How long a peer's presence survives without a refresh. */
export const EPHEMERAL_TIMEOUT_MS = PRESENCE_TIMEOUT_MS

/**
 * The authoritative copy of one document plus the ephemeral (presence) store.
 *
 * Sessions and transports attach as listeners; an update coming in from one
 * of them is applied here and fanned out to everyone else. Transport (03/08)
 * and persistence (04) sit on top of this class and never touch Loro directly.
 */
export class SyncHub {
  readonly doc: LoroDoc
  readonly ephemeral: EphemeralStore
  private listeners = new Map<string, Listener>()
  private unsubDoc: () => void

  constructor(doc: LoroDoc = createDocument()) {
    this.doc = doc
    this.ephemeral = new EphemeralStore(EPHEMERAL_TIMEOUT_MS)
    this.unsubDoc = this.doc.subscribeLocalUpdates((bytes) => {
      this.emit({ type: 'update', from: 'hub', bytes })
    })
  }

  static create(options: { docId?: string; title?: string } = {}): SyncHub {
    return new SyncHub(createDocument(options))
  }

  static fromSnapshot(bytes: Uint8Array): SyncHub {
    return new SyncHub(openDocument(bytes))
  }

  commitLocal(message: string, origin: string = HUB_ORIGIN): void {
    this.doc.commit({ origin, message, timestamp: commitTimestamp() })
  }

  snapshot(): Uint8Array {
    return this.doc.export({ mode: 'snapshot' })
  }

  exportFrom(encodedVersion: Uint8Array | null): Uint8Array {
    if (!encodedVersion || encodedVersion.byteLength === 0) return this.snapshot()
    try {
      return this.doc.export({ mode: 'update', from: VersionVector.decode(encodedVersion) })
    } catch {
      return this.snapshot()
    }
  }

  ephemeralSnapshot(): Uint8Array {
    return this.ephemeral.encodeAll()
  }

  subscribe(id: string, listener: Listener): () => void {
    this.listeners.set(id, listener)
    return () => {
      this.listeners.delete(id)
    }
  }

  applyUpdate(from: string, bytes: Uint8Array): void {
    this.doc.import(bytes)
    this.emit({ type: 'update', from, bytes })
  }

  applyEphemeral(from: string, bytes: Uint8Array): void {
    this.ephemeral.apply(bytes)
    this.emit({ type: 'ephemeral', from, bytes })
  }

  dispose(): void {
    this.unsubDoc()
    this.listeners.clear()
  }

  private emit(event: HubEvent): void {
    for (const [id, listener] of this.listeners) {
      if (id === event.from) continue
      listener(event)
    }
  }
}
