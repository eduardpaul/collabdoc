import type { LoroDoc } from 'loro-crdt'
import { commitTimestamp } from './document'
import { AUTHOR_ORIGIN, AUTHORS_KEY } from '../shared/constants'
import type { AuthorRecord, ParticipantRole } from '../shared/types'

/** An author as history sees it: `role` is absent for peers that never identified. */
export type HistoryAuthor = { actorId: string; name: string; color: string; role?: ParticipantRole }

export function writeAuthor(doc: LoroDoc, author: AuthorRecord): void {
  doc.getMap(AUTHORS_KEY).set(doc.peerIdStr, {
    actorId: author.actorId,
    name: author.name,
    color: author.color,
    role: author.role,
    ...(author.handle ? { handle: author.handle } : {})
  })
}

export function isAuthorRegistered(doc: LoroDoc): boolean {
  return doc.getMap(AUTHORS_KEY).get(doc.peerIdStr) !== undefined
}

/**
 * Make sure this peer is in the `authors` map before its first real commit.
 *
 * Written as its own `sys:author` commit (so undo never removes it) with no
 * message, which history skips. `subscribeFirstCommitFromPeer` looks like the
 * tool for this, but ops written in its callback land in the *next* pending
 * transaction, so the first exported update would carry no attribution.
 */
export function ensureAuthor(doc: LoroDoc, author: AuthorRecord): boolean {
  if (isAuthorRegistered(doc)) return false
  writeAuthor(doc, author)
  doc.commit({ origin: AUTHOR_ORIGIN, timestamp: commitTimestamp() })
  return true
}

export function readAuthors(doc: LoroDoc): Record<string, AuthorRecord> {
  const out: Record<string, AuthorRecord> = {}
  const map = doc.getMap(AUTHORS_KEY)
  for (const key of map.keys()) {
    const author = asAuthor(map.get(key), key)
    if (author) out[key] = author
  }
  return out
}

export function authorForPeer(doc: LoroDoc, peer: string): HistoryAuthor {
  return asAuthor(doc.getMap(AUTHORS_KEY).get(peer), peer) ?? unknownAuthor(peer)
}

/** Never guess "human" for a peer that did not identify itself. */
export function unknownAuthor(peer: string): HistoryAuthor {
  return { actorId: peer, name: `Unknown peer ${peer.slice(0, 6)}`, color: '#8a7d6d' }
}

function asAuthor(value: unknown, peer: string): AuthorRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const rec = value as Record<string, unknown>
  if (typeof rec.name !== 'string') return null
  const handle = typeof rec.handle === 'string' ? rec.handle : undefined
  return {
    actorId: typeof rec.actorId === 'string' ? rec.actorId : peer,
    name: rec.name,
    color: typeof rec.color === 'string' ? rec.color : '#8a7d6d',
    role: rec.role === 'agent' ? 'agent' : 'human',
    ...(handle ? { handle } : {})
  }
}
