import { readMeta } from './document'
import { SyncHub } from './hub'
import { bindLink, type FrameLink, type LinkLogger } from './link'
import { listHistory } from './history'
import { allBlocks, blockAgentText } from './tree'

export type RegistryEntry = {
  docId: string
  hub: SyncHub
  subscribers: Set<string>
  closeTimer: ReturnType<typeof setTimeout> | null
}

export type RegistryDebugEntry = {
  docId: string
  title: string
  subscribers: string[]
  changes: number
  text: string
}

export type RegistryOptions = {
  /**
   * How long a hub with no subscribers is kept before it is disposed. A
   * renderer reload closes its port and re-attaches a moment later; the
   * grace period keeps unsaved edits alive across that gap.
   */
  closeDelayMs?: number
  warn?: LinkLogger
  onDispose?: (docId: string) => void
}

/**
 * Every open document in this process: one `SyncHub` each, reference-counted
 * by subscriber (renderer ports, agents, peers). A hub lives while someone is
 * attached, plus a grace period.
 */
export class DocumentRegistry {
  private readonly entries = new Map<string, RegistryEntry>()
  private readonly closeDelayMs: number
  private readonly warn?: LinkLogger
  private readonly onDispose?: (docId: string) => void

  constructor(options: RegistryOptions = {}) {
    this.closeDelayMs = options.closeDelayMs ?? 5000
    this.warn = options.warn
    this.onDispose = options.onDispose
  }

  create(options: { docId?: string; title?: string } = {}): RegistryEntry {
    const hub = SyncHub.create(options)
    return this.register(hub)
  }

  /** Adopt a hub built elsewhere (04 loads one from disk). */
  register(hub: SyncHub): RegistryEntry {
    const docId = readMeta(hub.doc).docId
    if (!docId) throw new Error('A document needs a docId in its meta map.')
    if (this.entries.has(docId)) throw new Error(`Document ${docId} is already open.`)
    const entry: RegistryEntry = { docId, hub, subscribers: new Set(), closeTimer: null }
    this.entries.set(docId, entry)
    this.scheduleClose(entry)
    return entry
  }

  get(docId: string): RegistryEntry | undefined {
    return this.entries.get(docId)
  }

  has(docId: string): boolean {
    return this.entries.has(docId)
  }

  list(): string[] {
    return [...this.entries.keys()]
  }

  /** Bind a frame link to a document; returns a detach function. */
  attach(docId: string, subscriberId: string, link: FrameLink): () => void {
    const entry = this.entries.get(docId)
    if (!entry) throw new Error(`Document ${docId} is not open.`)
    if (entry.subscribers.has(subscriberId)) {
      throw new Error(`${subscriberId} is already attached to ${docId}.`)
    }
    this.hold(entry, subscriberId)
    const unbind = bindLink(entry.hub, subscriberId, link, {
      warn: this.warn,
      onClose: () => this.release(entry, subscriberId)
    })
    return () => {
      unbind()
      this.release(entry, subscriberId)
    }
  }

  /** Count a subscriber that does not go through a link (an agent session). */
  hold(entry: RegistryEntry, subscriberId: string): void {
    entry.subscribers.add(subscriberId)
    if (entry.closeTimer) {
      clearTimeout(entry.closeTimer)
      entry.closeTimer = null
    }
  }

  release(entry: RegistryEntry, subscriberId: string): void {
    if (!entry.subscribers.delete(subscriberId)) return
    if (entry.subscribers.size === 0) this.scheduleClose(entry)
  }

  /** Dispose now regardless of subscribers (explicit close from the UI). */
  close(docId: string): boolean {
    const entry = this.entries.get(docId)
    if (!entry) return false
    if (entry.closeTimer) clearTimeout(entry.closeTimer)
    this.entries.delete(docId)
    entry.hub.dispose()
    this.onDispose?.(docId)
    return true
  }

  closeAll(): void {
    for (const docId of this.list()) this.close(docId)
  }

  debug(): RegistryDebugEntry[] {
    return [...this.entries.values()].map((entry) => ({
      docId: entry.docId,
      title: readMeta(entry.hub.doc).title,
      subscribers: [...entry.subscribers],
      changes: listHistory(entry.hub.doc).length,
      text: allBlocks(entry.hub.doc)
        .map(({ node }) => blockAgentText(node))
        .join('\n')
    }))
  }

  private scheduleClose(entry: RegistryEntry): void {
    if (entry.closeTimer) clearTimeout(entry.closeTimer)
    if (!Number.isFinite(this.closeDelayMs)) return
    entry.closeTimer = setTimeout(() => {
      entry.closeTimer = null
      if (entry.subscribers.size === 0 && this.entries.get(entry.docId) === entry) {
        this.close(entry.docId)
      }
    }, this.closeDelayMs)
    // Node only: a pending grace timer must not keep the process alive.
    ;(entry.closeTimer as { unref?: () => void }).unref?.()
  }
}
