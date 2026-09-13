import type { AllowedMark, AllowedNode, SessionLimits } from './constants'

export type BlockId = string
/** An opaque, stable position inside a block (an encoded Loro cursor). */
export type Anchor = string
/** A short fingerprint of a block's content; changes when the block does. */
export type View = string

export type ParticipantRole = 'human' | 'agent'

/** Who a `DocumentSession` acts as. Supplied by identity (07) or the agent runtime (12). */
export type ActorProfile = {
  actorId: string
  name: string
  color: string
  role: ParticipantRole
  /** Lower-case `@handle`; lets `list_comments { mentioning: "me" }` work. */
  handle?: string
}

export type AuthorRecord = {
  actorId: string
  name: string
  color: string
  role: ParticipantRole
  handle?: string
}

export type TextLocator = {
  find?: string
  occurrence?: number
  start?: number
  end?: number
  expected?: string
  after?: string
  before?: string
  anchor?: Anchor
  length?: number
}

export type MarkInput = {
  type: AllowedMark | string
  attrs?: Record<string, unknown>
  start?: number
  end?: number
}

export type NodeInput = {
  type: AllowedNode | string
  attrs?: Record<string, unknown>
  text?: string
  marks?: MarkInput[]
}

export type MarkView = {
  type: string
  attrs?: Record<string, unknown>
  start: number
  end: number
}

export type BlockOutline = {
  blockId: BlockId
  type: string
  attrs: Record<string, unknown>
  preview: string
}

export type BlockView = {
  blockId: BlockId
  type: string
  attrs: Record<string, unknown>
  text: string
  marks: MarkView[]
  view: View
  anchors: { start: Anchor; end: Anchor }
}

export type Presence = {
  /** The actor's own id when it published one, otherwise its Loro peer id. */
  actorId: string
  /** The Loro peer id, which is what claims and cursors are keyed by. */
  peerId: string
  /** Absent for a peer that did not say — do not assume "human". */
  role?: ParticipantRole
  name?: string
  color?: string
  cursor?: { blockId: BlockId; offset: number }
  claim?: { blockIds: BlockId[]; until: string }
}

export type UndoState = { canUndo: boolean; canRedo: boolean }

export type MutationOk = {
  ok: true
  applied: string
  blocks: BlockView[]
  presenceNearby: Presence[]
  undo: UndoState
}

/**
 * Why a tool call did not apply.
 *
 * - `forbidden` — the tool is not in this session's `allowedTools`.
 * - `schema` — arguments or node/mark types the document does not accept.
 * - `not_found` — a block or thread id that does not exist.
 * - `invalid_locator` — the locator does not resolve in the current text.
 * - `conflict` — the block changed since it was read (`view` / `expected`).
 * - `claimed` — another participant holds an advisory claim on the block.
 * - `limit` — a per-session cap was exceeded.
 */
export type MutationErrorKind =
  'forbidden' | 'schema' | 'not_found' | 'invalid_locator' | 'conflict' | 'claimed' | 'limit'

export type MutationErr = {
  ok: false
  error: MutationErrorKind
  message: string
  blocks?: BlockView[]
  presenceNearby?: Presence[]
}

export type MutationResult = MutationOk | MutationErr

export type SearchHit = {
  blockId: BlockId
  snippet: string
  locator: { find: string; occurrence: number }
}

export type OutlineResult = { blocks: BlockOutline[] }
export type BlocksResult = { blocks: BlockView[] }
export type SearchResult = { hits: SearchHit[] }
export type PresenceResult = { actors: Presence[] }
export type SetPresenceResult = { ok: true; presence: PresenceResult }
export type ThreadResult = { ok: true; thread: CommentThread }
export type ReplyResult = { ok: true; reply: CommentReply; thread: CommentThread | null }
export type ThreadsResult = { threads: CommentThread[] }

/** Everything `DocumentSession.call` can return. */
export type ToolResult =
  | MutationResult
  | OutlineResult
  | BlocksResult
  | SearchResult
  | PresenceResult
  | SetPresenceResult
  | ThreadResult
  | ReplyResult
  | ThreadsResult

export type ThreadStatus = 'open' | 'resolved'
export type SuggestionStatus = 'pending' | 'applying' | 'applied' | 'declined'

export type CommentAuthor = {
  id: string
  name: string
  role: ParticipantRole
  color: string
}

export type CommentReply = {
  id: string
  author: CommentAuthor
  body: string
  at: number
  deleted?: boolean
}

export type Suggestion = {
  status: SuggestionStatus
  by?: string
  error?: string
}

export type CommentThread = {
  id: string
  blockId: BlockId
  quote: string
  start: number
  end: number
  anchorStart: Anchor
  anchorEnd: Anchor
  author: CommentAuthor
  body: string
  createdAt: number
  status: ThreadStatus
  resolvedBy?: string
  resolvedAt?: number
  orphaned?: boolean
  deleted?: boolean
  replies: CommentReply[]
  suggestion?: Suggestion
}

export type SessionLog = {
  at: number
  actorId: string
  name: string
  tool: string
  summary: string
  ok: boolean
}

export type SessionOptions = {
  /** Tools this session may call; everything else returns `forbidden`. */
  allowedTools?: readonly ToolName[]
  /**
   * Whether other participants' advisory claims block this session's writes.
   * Off for the human's own session: claims are hints, not locks.
   */
  enforceClaims?: boolean
  limits?: Partial<SessionLimits>
}

export type ToolName =
  | 'get_document'
  | 'get_blocks'
  | 'search'
  | 'insert_text'
  | 'replace_text'
  | 'apply_marks'
  | 'insert_blocks'
  | 'update_block'
  | 'delete_blocks'
  | 'undo'
  | 'redo'
  | 'set_presence'
  | 'get_presence'
  | 'add_comment'
  | 'reply_comment'
  | 'resolve_comment'
  | 'list_comments'
