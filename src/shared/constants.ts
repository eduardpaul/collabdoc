/**
 * Names and limits shared by the document core, the editor and the agents.
 *
 * This module is compiled for both Node (main) and the browser (renderer):
 * no Node, Electron or React imports.
 */

// Loro tree shape read by `loro-prosemirror`. Keep these four in sync with it.
export const ROOT_DOC_KEY = 'doc'
export const ATTRIBUTES_KEY = 'attributes'
export const CHILDREN_KEY = 'children'
export const NODE_NAME_KEY = 'nodeName'

// Sidecar root containers next to the document tree.
export const META_KEY = 'meta'
export const AUTHORS_KEY = 'authors'
export const COMMENTS_KEY = 'comments'
export const CHECKPOINTS_KEY = 'checkpoints'

/**
 * Loro merges consecutive local commits whose timestamps are within this many
 * units and whose messages match. Our timestamps are milliseconds (see
 * `commitTimestamp`), so this is 1 ms: a commit that carries its own stamp
 * starts a new change, one that does not inherits the last stamp and merges.
 */
export const CHANGE_MERGE_INTERVAL = 1
/** Human typing is one history entry until 1 s idle or a block switch (05). */
export const HUMAN_COMMIT_IDLE_MS = 1_000
/** History UI waits this long after edits before recomputing (lorocollab). */
export const HISTORY_SETTLE_MS = 400
export const HISTORY_DIFF_CACHE = 32

export const BLOCK_ID_ATTR = 'blockId'
export const SCHEMA_VERSION = 1

/**
 * Commit origins. Everything a participant does (human or agent) is committed
 * with `actor:<actorId>`; bookkeeping the app does on its own behalf uses a
 * `sys:` prefix so undo managers can skip it.
 */
export const ACTOR_ORIGIN_PREFIX = 'actor:'
export const SYSTEM_ORIGIN_PREFIX = 'sys:'
export const INIT_ORIGIN = 'sys:init'
export const HUB_ORIGIN = 'sys:hub'
export const AUTHOR_ORIGIN = 'sys:author'
/** Checkpoints are bookkeeping: never an undo step (06), still a history entry (05). */
export const CHECKPOINT_ORIGIN = 'sys:checkpoint'
/** Orphan marks on comment threads (09): bookkeeping, not undoable. */
export const ORPHAN_ORIGIN = 'sys:orphan'
/** Per-user, unsynced: which replies the user has seen (09). */
export const COMMENTS_SEEN_KEY = 'collabdoc.comments.seen'

/** Undo stacks are bounded per participant (06). */
export const UNDO_MAX_STEPS = 200
/**
 * Loro's undo `mergeInterval` caps a step at this long after its first
 * commit — it is not an idle timer. Human steps are cut by the editor instead
 * (1 s idle or a block switch, like history), so the ceiling is wide.
 */
export const UNDO_STEP_MAX_MS = 60 * 60 * 1000

/** Presence is ephemeral: 15 s without a heartbeat and the peer is gone. */
export const PRESENCE_TIMEOUT_MS = 15_000
export const PRESENCE_HEARTBEAT_MS = 5_000
/** Cursor broadcasts are capped so one participant stays under 2 KB/s. */
export const PRESENCE_MAX_HZ = 20

export const SHARE_PROTOCOL_VERSION = 1
export const SHARE_MAX_PEERS = 10
export const SHARE_AUTH_TIMEOUT_MS = 10_000
export const SHARE_PROOF_WINDOW_MS = 60_000
export const SHARE_PROOF_LOCK_MS = 60_000
export const SHARE_MAX_FAILED_PROOFS = 5
export const SHARE_STALL_MS = 30_000
export const SHARE_SLOW_BUFFER_BYTES = 4 * 1024 * 1024
export const SHARE_JOIN_TIMEOUT_MS = 30_000
export const SHARE_ASSET_CHUNK_BYTES = 256 * 1024

export const ASSET_SRC_PREFIX = 'asset:'
export const ASSET_SRC_PATTERN = /^asset:[a-f0-9]{64}$/

/** Per-session caps. Overridable so external MCP clients can be held tighter. */
export const DEFAULT_LIMITS = {
  maxInsertChars: 8000,
  maxBlocksPerCall: 20,
  maxBlocksPerRead: 50,
  maxSearchResults: 50,
  maxCommentChars: 2000,
  defaultClaimSeconds: 30,
  maxClaimSeconds: 120
} as const

export type SessionLimits = { -readonly [K in keyof typeof DEFAULT_LIMITS]: number }

export const ALLOWED_NODES = [
  'paragraph',
  'heading',
  'blockquote',
  'codeBlock',
  'horizontalRule',
  'bulletList',
  'orderedList',
  'taskList',
  'listItem',
  'taskItem',
  'imageFigure',
  'mermaidFigure',
  'infographicFigure'
] as const

export const ALLOWED_MARKS = [
  'bold',
  'italic',
  'underline',
  'strike',
  'code',
  'link',
  'highlight',
  'superscript',
  'subscript'
] as const

export const BLOCK_ID_TYPES = [
  'paragraph',
  'heading',
  'blockquote',
  'codeBlock',
  'listItem',
  'taskItem',
  'horizontalRule',
  'imageFigure',
  'mermaidFigure',
  'infographicFigure'
] as const

/** Nodes with no text content of their own. */
export const ATOM_NODE_TYPES = ['horizontalRule', 'imageFigure', 'hardBreak'] as const

/**
 * Node types whose children are blocks. Everything else holds text (or
 * nothing), so nesting a block inside one produces a tree ProseMirror cannot
 * build: the offending block *and its parent's text* stop rendering.
 */
export const BLOCK_CONTAINER_TYPES = [
  'blockquote',
  'listItem',
  'taskItem',
  'bulletList',
  'orderedList',
  'taskList'
] as const

export const FIGURE_TYPES = ['imageFigure', 'mermaidFigure', 'infographicFigure'] as const
export const SYNTAX_FIGURE_TYPES = ['mermaidFigure', 'infographicFigure'] as const

export const FIGURE_WIDTHS = [50, 75, 100] as const
export const FIGURE_ALIGNS = ['left', 'center', 'right'] as const

export const MAX_IMAGE_BYTES = 2 * 1024 * 1024
export const MAX_DOCUMENT_ASSET_BYTES = 25 * 1024 * 1024

export const HEADING_LEVELS = [1, 2, 3, 4] as const

/**
 * How a mark behaves when text is typed at its edge.
 *
 * `loro-prosemirror` derives the same config from the ProseMirror schema
 * (`inclusive !== false` → `"after"`). This table and the Tiptap extensions
 * must agree, or the same edit marks up differently depending on who made it;
 * `checkTextStyleParity` in the renderer fails the dev run if they drift.
 *
 * `link` expands because Tiptap's Link mark is inclusive whenever autolink is
 * on, and autolink is on.
 */
export const TEXT_STYLE_CONFIG = {
  bold: { expand: 'after' as const },
  italic: { expand: 'after' as const },
  underline: { expand: 'after' as const },
  strike: { expand: 'after' as const },
  code: { expand: 'none' as const },
  link: { expand: 'after' as const },
  highlight: { expand: 'none' as const },
  superscript: { expand: 'none' as const },
  subscript: { expand: 'none' as const }
}

export type TextStyleExpand = 'after' | 'none'
export type AllowedNode = (typeof ALLOWED_NODES)[number]
export type AllowedMark = (typeof ALLOWED_MARKS)[number]
export type HeadingLevel = (typeof HEADING_LEVELS)[number]
export type FigureWidth = (typeof FIGURE_WIDTHS)[number]
export type FigureAlign = (typeof FIGURE_ALIGNS)[number]
export type SyntaxFigureType = (typeof SYNTAX_FIGURE_TYPES)[number]
