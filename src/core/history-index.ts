import type { LoroDoc, PeerID } from 'loro-crdt'
import { readAuthors, type HistoryAuthor } from './authors'
import {
  commentContainerIds,
  compareHistory,
  containerToBlockId,
  entryFromChange,
  type HistoryEntry
} from './history'

/**
 * Incremental history: describes only changes whose counter is new for that
 * peer. `listHistory` still walks everything; the History tab uses this.
 */
export class HistoryIndex {
  private readonly seen = new Map<string, number>()
  private entries: HistoryEntry[] = []
  private readonly authorsByBlock = new Map<string, HistoryAuthor>()

  constructor(private readonly doc: LoroDoc) {
    this.refresh()
  }

  list(): HistoryEntry[] {
    return this.entries
  }

  lastAuthor(blockId: string): HistoryAuthor | undefined {
    return this.authorsByBlock.get(blockId)
  }

  lastAuthors(): Map<string, HistoryAuthor> {
    return this.authorsByBlock
  }

  refresh(): HistoryEntry[] {
    const authors = readAuthors(this.doc)
    const comments = commentContainerIds(this.doc)
    const containers = containerToBlockId(this.doc)
    const fresh: HistoryEntry[] = []
    const replaced = new Set<string>()
    // The version vector names every peer's latest counter. Frontiers would
    // not: they are DAG heads only, so a peer whose last change is already an
    // ancestor of someone else's change drops out of them.
    for (const [peer, next] of this.doc.oplogVersion().toJSON()) {
      const last = next - 1
      const lastEnd = this.seen.get(peer) ?? Number.NEGATIVE_INFINITY
      if (last <= lastEnd) continue
      let cursor = lastEnd < 0 ? 0 : lastEnd + 1
      while (cursor <= last) {
        let change
        try {
          change = this.doc.getChangeAt({ peer: peer as PeerID, counter: cursor })
        } catch {
          break
        }
        const end = change.counter + Math.max(change.length, 1) - 1
        const entry = entryFromChange(this.doc, peer, change, authors, comments, containers)
        if (entry) {
          if (change.counter <= lastEnd) replaced.add(entry.id)
          fresh.push(entry)
        }
        this.seen.set(peer, end)
        cursor = end + 1
      }
    }
    if (fresh.length === 0) return this.entries
    const kept = replaced.size
      ? this.entries.filter((entry) => !replaced.has(entry.id))
      : this.entries
    fresh.sort(compareHistory)
    for (const entry of fresh) {
      for (const blockId of entry.blockIds) {
        this.authorsByBlock.set(blockId, entry.author)
      }
    }
    this.entries = [...kept, ...fresh].sort(compareHistory)
    return this.entries
  }
}
