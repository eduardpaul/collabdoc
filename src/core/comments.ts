import { LoroDoc, LoroList, LoroMap } from 'loro-crdt'
import { COMMENTS_KEY } from '../shared/constants'
import { mentionedHandles } from '../shared/handles'
import { newReplyId, newThreadId } from '../shared/ids'
import type {
  CommentAuthor,
  CommentReply,
  CommentThread,
  Suggestion,
  ThreadStatus
} from '../shared/types'

/**
 * Comment threads live in the `comments` root map, one `LoroMap` per thread,
 * with replies in a `LoroList` so two people replying at once both land.
 *
 * Permissions are the same for people and agents: anyone opens, replies,
 * resolves or reopens; only the author edits or deletes their own body.
 */

export type ThreadFilter = {
  blockId?: string
  status?: ThreadStatus | 'all'
  /** Lower-case handle; matches threads whose body or replies mention it. */
  mentioning?: string
}

export type CommentPermissionError = 'not_found' | 'forbidden'

export function commentsMap(doc: LoroDoc): LoroMap {
  return doc.getMap(COMMENTS_KEY)
}

export function getThreadMap(doc: LoroDoc, threadId: string): LoroMap | null {
  const value = commentsMap(doc).get(threadId)
  return value instanceof LoroMap ? value : null
}

export function getThread(doc: LoroDoc, threadId: string): CommentThread | null {
  const map = getThreadMap(doc, threadId)
  return map ? threadFromMap(threadId, map) : null
}

/** A thread we just wrote to; a malformed one here is a bug, not a state. */
function readThread(id: string, map: LoroMap): CommentThread {
  const thread = threadFromMap(id, map)
  if (!thread) throw new Error(`Thread ${id} is malformed.`)
  return thread
}

export function openThread(
  doc: LoroDoc,
  input: {
    blockId: string
    quote: string
    start: number
    end: number
    anchorStart: string
    anchorEnd: string
    author: CommentAuthor
    body: string
    createdAt?: number
  }
): CommentThread {
  const id = newThreadId()
  const map = commentsMap(doc).setContainer(id, new LoroMap())
  map.set('blockId', input.blockId)
  map.set('quote', input.quote)
  map.set('start', input.start)
  map.set('end', input.end)
  map.set('anchorStart', input.anchorStart)
  map.set('anchorEnd', input.anchorEnd)
  map.set('author', { ...input.author })
  map.set('body', input.body)
  map.set('createdAt', input.createdAt ?? Date.now())
  map.set('status', 'open')
  map.setContainer('replies', new LoroList())
  return readThread(id, map)
}

export function replyToThread(
  doc: LoroDoc,
  threadId: string,
  author: CommentAuthor,
  body: string,
  at: number = Date.now()
): CommentReply | CommentPermissionError {
  const map = getThreadMap(doc, threadId)
  if (!map) return 'not_found'
  const replies = map.getOrCreateContainer('replies', new LoroList())
  const reply: CommentReply = { id: newReplyId(), author: { ...author }, body, at }
  replies.push(reply)
  return reply
}

export function resolveThread(
  doc: LoroDoc,
  threadId: string,
  by: CommentAuthor,
  at: number = Date.now()
): CommentThread | CommentPermissionError {
  const map = getThreadMap(doc, threadId)
  if (!map) return 'not_found'
  map.set('status', 'resolved')
  map.set('resolvedBy', by.id)
  map.set('resolvedAt', at)
  // Resolving a thread with a pending suggestion declines it.
  const suggestion = suggestionFrom(map.get('suggestion'))
  if (suggestion && suggestion.status === 'pending') {
    map.set('suggestion', { ...suggestion, status: 'declined', by: by.id })
  }
  return readThread(threadId, map)
}

export function reopenThread(
  doc: LoroDoc,
  threadId: string
): CommentThread | CommentPermissionError {
  const map = getThreadMap(doc, threadId)
  if (!map) return 'not_found'
  map.set('status', 'open')
  map.delete('resolvedBy')
  map.delete('resolvedAt')
  return readThread(threadId, map)
}

/** Only the author may change their body. */
export function editThreadBody(
  doc: LoroDoc,
  threadId: string,
  actorId: string,
  body: string
): CommentThread | CommentPermissionError {
  const map = getThreadMap(doc, threadId)
  if (!map) return 'not_found'
  if (authorFrom(map.get('author'))?.id !== actorId) return 'forbidden'
  map.set('body', body)
  return readThread(threadId, map)
}

/** Soft delete: the thread keeps its shape so replies still make sense. */
export function deleteThreadBody(
  doc: LoroDoc,
  threadId: string,
  actorId: string
): CommentThread | CommentPermissionError {
  const map = getThreadMap(doc, threadId)
  if (!map) return 'not_found'
  if (authorFrom(map.get('author'))?.id !== actorId) return 'forbidden'
  map.set('deleted', true)
  map.set('body', '')
  return readThread(threadId, map)
}

export function editReply(
  doc: LoroDoc,
  threadId: string,
  replyId: string,
  actorId: string,
  patch: { body?: string; deleted?: boolean }
): CommentReply | CommentPermissionError {
  const map = getThreadMap(doc, threadId)
  if (!map) return 'not_found'
  const replies = map.get('replies')
  if (!(replies instanceof LoroList)) return 'not_found'
  for (let i = 0; i < replies.length; i += 1) {
    const reply = replyFrom(replies.get(i))
    if (!reply || reply.id !== replyId) continue
    if (reply.author.id !== actorId) return 'forbidden'
    const next: CommentReply = {
      ...reply,
      body: patch.deleted ? '' : (patch.body ?? reply.body),
      deleted: patch.deleted ? true : reply.deleted
    }
    if (!next.deleted) delete next.deleted
    replies.delete(i, 1)
    replies.insert(i, next)
    return next
  }
  return 'not_found'
}

export function setSuggestion(
  doc: LoroDoc,
  threadId: string,
  suggestion: Suggestion | null
): CommentThread | CommentPermissionError {
  const map = getThreadMap(doc, threadId)
  if (!map) return 'not_found'
  if (suggestion) map.set('suggestion', stripUndefined({ ...suggestion }))
  else map.delete('suggestion')
  return readThread(threadId, map)
}

export function markOrphaned(doc: LoroDoc, threadId: string, orphaned: boolean): void {
  const map = getThreadMap(doc, threadId)
  if (!map) return
  if (orphaned) map.set('orphaned', true)
  else map.delete('orphaned')
}

export function listThreads(doc: LoroDoc, filter: ThreadFilter = {}): CommentThread[] {
  const status = filter.status ?? 'open'
  const out: CommentThread[] = []
  const map = commentsMap(doc)
  for (const key of map.keys()) {
    const value = map.get(key)
    if (!(value instanceof LoroMap)) continue
    const thread = threadFromMap(key, value)
    if (!thread) continue
    if (filter.blockId && thread.blockId !== filter.blockId) continue
    if (status !== 'all' && thread.status !== status) continue
    if (filter.mentioning && !threadMentions(thread, filter.mentioning)) continue
    out.push(thread)
  }
  out.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
  return out
}

export function threadMentions(thread: CommentThread, handle: string): boolean {
  const wanted = handle.toLowerCase()
  if (mentionedHandles(thread.body).includes(wanted)) return true
  return thread.replies.some((reply) => mentionedHandles(reply.body).includes(wanted))
}

export function hasOpenThread(doc: LoroDoc, actorId: string, blockId: string): boolean {
  return listThreads(doc, { blockId }).some((thread) => thread.author.id === actorId)
}

/** Find `quote` in the current block text, preferring the remembered offset. */
export function locateQuote(
  text: string,
  quote: string,
  hintStart?: number
): { start: number; end: number } | null {
  if (!quote) return null
  if (
    hintStart != null &&
    hintStart >= 0 &&
    text.slice(hintStart, hintStart + quote.length) === quote
  ) {
    return { start: hintStart, end: hintStart + quote.length }
  }
  const idx = text.indexOf(quote)
  if (idx < 0) return null
  return { start: idx, end: idx + quote.length }
}

export function threadFromMap(id: string, map: LoroMap): CommentThread | null {
  const blockId = map.get('blockId')
  const body = map.get('body')
  const author = authorFrom(map.get('author'))
  if (typeof blockId !== 'string' || typeof body !== 'string' || !author) return null
  const status = map.get('status')
  const replies: CommentReply[] = []
  const list = map.get('replies')
  if (list instanceof LoroList) {
    for (let i = 0; i < list.length; i += 1) {
      const reply = replyFrom(list.get(i))
      if (reply) replies.push(reply)
    }
  }
  const thread: CommentThread = {
    id,
    blockId,
    quote: stringOr(map.get('quote'), ''),
    start: numberOr(map.get('start'), 0),
    end: numberOr(map.get('end'), 0),
    anchorStart: stringOr(map.get('anchorStart'), ''),
    anchorEnd: stringOr(map.get('anchorEnd'), ''),
    author,
    body,
    createdAt: numberOr(map.get('createdAt'), 0),
    status: status === 'resolved' ? 'resolved' : 'open',
    replies
  }
  const resolvedBy = map.get('resolvedBy')
  if (typeof resolvedBy === 'string') thread.resolvedBy = resolvedBy
  const resolvedAt = map.get('resolvedAt')
  if (typeof resolvedAt === 'number') thread.resolvedAt = resolvedAt
  if (map.get('orphaned') === true) thread.orphaned = true
  if (map.get('deleted') === true) thread.deleted = true
  const suggestion = suggestionFrom(map.get('suggestion'))
  if (suggestion) thread.suggestion = suggestion
  return thread
}

function authorFrom(value: unknown): CommentAuthor | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const rec = value as Record<string, unknown>
  if (typeof rec.id !== 'string' || typeof rec.name !== 'string') return null
  return {
    id: rec.id,
    name: rec.name,
    role: rec.role === 'agent' ? 'agent' : 'human',
    color: typeof rec.color === 'string' ? rec.color : '#8a7d6d'
  }
}

function replyFrom(value: unknown): CommentReply | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const rec = value as Record<string, unknown>
  const author = authorFrom(rec.author)
  if (typeof rec.id !== 'string' || typeof rec.body !== 'string' || !author) return null
  const reply: CommentReply = { id: rec.id, author, body: rec.body, at: numberOr(rec.at, 0) }
  if (rec.deleted === true) reply.deleted = true
  return reply
}

function suggestionFrom(value: unknown): Suggestion | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const rec = value as Record<string, unknown>
  const status = rec.status
  if (
    status !== 'pending' &&
    status !== 'applying' &&
    status !== 'applied' &&
    status !== 'declined'
  ) {
    return null
  }
  const suggestion: Suggestion = { status }
  if (typeof rec.by === 'string') suggestion.by = rec.by
  if (typeof rec.error === 'string') suggestion.error = rec.error
  return suggestion
}

function stripUndefined<T extends Record<string, unknown>>(value: T): T {
  for (const key of Object.keys(value)) {
    if (value[key] === undefined) delete value[key]
  }
  return value
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' ? value : fallback
}
