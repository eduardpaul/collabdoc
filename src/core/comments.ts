import { LoroDoc, LoroList, LoroMap } from 'loro-crdt'
import { COMMENTS_KEY } from '../shared/constants'
import { mentionedHandles } from '../shared/handles'
import { newReplyId, newThreadId } from '../shared/ids'
import type {
  CommentAuthor,
  CommentReply,
  CommentThread,
  Suggestion,
  SuggestionStatus,
  ThreadStatus
} from '../shared/types'
import { decodeAnchor, encodeAnchor } from './anchors'
import { blockAgentText, findBlock, firstText, isSyntaxFigure } from './tree'

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

export type CommentError = 'not_found' | 'forbidden' | 'conflict' | 'invalid_range'
export type CommentPermissionError = CommentError

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
    whole?: boolean
  }
): CommentThread {
  const id = newThreadId()
  const map = commentsMap(doc).setContainer(id, new LoroMap())
  map.set('blockId', input.blockId)
  if (input.whole) map.set('whole', true)
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

/**
 * Open a thread on a block: on `start..end` of its text, or on the whole
 * block when no range is given. The span is remembered three ways — Loro
 * cursors (stable through edits), offsets and the quoted text (display and
 * fallback). Shared by the `add_comment` tool and the editor.
 */
export function openThreadOnRange(
  doc: LoroDoc,
  input: {
    blockId: string
    start?: number
    end?: number
    author: CommentAuthor
    body: string
    createdAt?: number
  }
): CommentThread | CommentError {
  const found = findBlock(doc, input.blockId)
  if (!found) return 'not_found'
  const content = blockAgentText(found.node)
  const whole = input.start == null && input.end == null
  const start = whole ? 0 : Math.max(0, input.start ?? 0)
  const end = whole ? content.length : Math.min(content.length, input.end ?? content.length)
  if (end < start || (end === start && content.length > 0 && !whole)) return 'invalid_range'
  const text = isSyntaxFigure(found.node) ? null : firstText(found.node)
  const anchorStart = whole ? undefined : text?.getCursor(start, 0)
  const anchorEnd = whole ? undefined : text?.getCursor(end, 0)
  return openThread(doc, {
    blockId: input.blockId,
    quote: content.slice(start, end),
    start,
    end,
    anchorStart: anchorStart ? encodeAnchor(anchorStart) : '',
    anchorEnd: anchorEnd ? encodeAnchor(anchorEnd) : '',
    author: input.author,
    body: input.body,
    createdAt: input.createdAt,
    whole
  })
}

/**
 * Where a thread's span is now. Cursors follow the characters through edits
 * before and inside the span. When both cursors land on the same offset the
 * characters are gone — an undo brings back *new* characters the cursors do
 * not know — so the quote is searched for, as it is for threads written
 * without cursors (figures). Whole-block threads span the block's text.
 */
export function currentSpan(
  doc: LoroDoc,
  thread: CommentThread
): { start: number; end: number } | null {
  const found = findBlock(doc, thread.blockId)
  if (!found) return null
  const content = blockAgentText(found.node)
  if (thread.whole) return { start: 0, end: content.length }
  if (thread.anchorStart && thread.anchorEnd) {
    try {
      const start = doc.getCursorPos(decodeAnchor(thread.anchorStart))
      const end = doc.getCursorPos(decodeAnchor(thread.anchorEnd))
      if (start && end && end.offset > start.offset) {
        return { start: start.offset, end: end.offset }
      }
    } catch {
      /* the text container itself is gone: fall through to the quote */
    }
  }
  return locateQuote(content, thread.quote, thread.start)
}

/**
 * Mark threads whose block or span no longer exists, and clear the mark when
 * an undo brings the text back. Returns the ids that changed; the caller
 * commits. Never drops a thread: an orphan stays listed.
 */
export function refreshOrphans(doc: LoroDoc): string[] {
  const changed: string[] = []
  for (const thread of listThreads(doc, { status: 'all' })) {
    const orphaned = currentSpan(doc, thread) === null
    if (orphaned === (thread.orphaned ?? false)) continue
    markOrphaned(doc, thread.id, orphaned)
    changed.push(thread.id)
  }
  return changed
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
  if (map.get('status') === 'resolved') return 'conflict'
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
  if (map.get('status') !== 'resolved') return 'conflict'
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

/**
 * The suggestion machine: `pending → applying → applied | declined`, and a
 * pending suggestion may be declined outright. Anything else is a conflict,
 * as is attaching a suggestion to a resolved thread.
 */
const SUGGESTION_MOVES: Record<string, readonly SuggestionStatus[]> = {
  none: ['pending'],
  pending: ['applying', 'declined'],
  applying: ['applied', 'declined'],
  applied: [],
  declined: []
}

export function transitionSuggestion(
  doc: LoroDoc,
  threadId: string,
  next: SuggestionStatus,
  meta: { by?: string; error?: string } = {}
): CommentThread | CommentError {
  const map = getThreadMap(doc, threadId)
  if (!map) return 'not_found'
  const current = suggestionFrom(map.get('suggestion'))
  const from = current?.status ?? 'none'
  if (!SUGGESTION_MOVES[from].includes(next)) return 'conflict'
  if (from === 'none' && map.get('status') === 'resolved') return 'conflict'
  map.set('suggestion', stripUndefined({ status: next, by: meta.by, error: meta.error }))
  return readThread(threadId, map)
}

/** Raw write, no transition check — tests and repairs; flows use `transitionSuggestion`. */
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
  if (map.get('whole') === true) thread.whole = true
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

/**
 * Threads as Markdown footnotes for export: one footnote per thread with its
 * status, quote, author and replies. Deleted bodies are shown as such.
 */
export function threadsAsFootnotes(threads: CommentThread[]): string {
  if (threads.length === 0) return ''
  const lines: string[] = ['', '---', '', '## Comments', '']
  threads.forEach((thread, i) => {
    const n = i + 1
    const state = thread.orphaned ? 'orphaned' : thread.status
    const where = thread.whole || !thread.quote ? 'on block' : `on “${collapse(thread.quote)}”`
    const body = thread.deleted ? '_(deleted)_' : collapse(thread.body)
    lines.push(`[^c${n}]: **${thread.author.name}** (${state}, ${where}): ${body}`)
    for (const reply of thread.replies) {
      const text = reply.deleted ? '_(deleted)_' : collapse(reply.body)
      lines.push(`    - **${reply.author.name}**: ${text}`)
    }
  })
  return lines.join('\n') + '\n'
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}
