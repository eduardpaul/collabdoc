import { EphemeralStore, LoroDoc, LoroMap, UndoManager } from 'loro-crdt'
import {
  ACTOR_ORIGIN_PREFIX,
  DEFAULT_LIMITS,
  SYSTEM_ORIGIN_PREFIX,
  type SessionLimits
} from '../shared/constants'
import { isToolName } from '../shared/tools'
import type {
  ActorProfile,
  BlockId,
  BlockView,
  MutationErr,
  MutationResult,
  Presence,
  SessionLog,
  SessionOptions,
  ToolName,
  ToolResult,
  UndoState
} from '../shared/types'
import { ensureAuthor } from './authors'
import { commitBoundary, configureDocument } from './document'
import { EPHEMERAL_TIMEOUT_MS, type SyncHub } from './hub'
import { asString, fail, isMutationResult, type SessionContext } from './tools/context'
import { addComment, listComments, replyComment, resolveComment } from './tools/comments'
import {
  findClaim,
  getPresence,
  readPresence,
  setPresence,
  type EphemeralPayload
} from './tools/presence'
import { getBlocks, getDocument, search } from './tools/read'
import {
  applyMarks,
  deleteBlocks,
  insertBlocks,
  insertText,
  replaceText,
  updateBlock
} from './tools/write'
import { blockAgentText, cursorAt, findBlock, toBlockView, viewOf, type LocatedBlock } from './tree'

/**
 * One participant's view of a document.
 *
 * Owns a `LoroDoc` fork kept in sync with the hub, an undo manager scoped to
 * this participant's own commits, and the tool surface. Everything an agent
 * or MCP client can do to a document goes through `call()`, which is where
 * permissions, limits and logging live.
 */
export class DocumentSession implements SessionContext {
  readonly profile: ActorProfile
  readonly doc: LoroDoc
  readonly ephemeral: EphemeralStore
  readonly limits: SessionLimits
  readonly allowedTools: ReadonlySet<ToolName> | null
  readonly enforceClaims: boolean
  private readonly undoManager: UndoManager
  private readonly hub: SyncHub
  private readonly subscriptions: Array<() => void> = []
  private disposed = false
  onLog?: (entry: SessionLog) => void

  constructor(hub: SyncHub, profile: ActorProfile, options: SessionOptions = {}) {
    this.hub = hub
    this.profile = profile
    this.enforceClaims = options.enforceClaims ?? true
    this.allowedTools = options.allowedTools ? new Set(options.allowedTools) : null
    this.limits = { ...DEFAULT_LIMITS, ...options.limits }

    this.doc = new LoroDoc()
    configureDocument(this.doc)
    this.doc.import(hub.snapshot())

    this.ephemeral = new EphemeralStore(EPHEMERAL_TIMEOUT_MS)
    const ephemeralSnapshot = hub.ephemeralSnapshot()
    if (ephemeralSnapshot.byteLength > 0) this.ephemeral.apply(ephemeralSnapshot)

    this.undoManager = new UndoManager(this.doc, {
      maxUndoSteps: 100,
      mergeInterval: 0,
      excludeOriginPrefixes: [SYSTEM_ORIGIN_PREFIX]
    })

    this.subscriptions.push(
      this.doc.subscribeLocalUpdates((bytes) => {
        this.hub.applyUpdate(this.profile.actorId, bytes)
      }),
      this.ephemeral.subscribeLocalUpdates((bytes) => {
        this.hub.applyEphemeral(this.profile.actorId, bytes)
      }),
      this.hub.subscribe(this.profile.actorId, (event) => {
        if (event.type === 'update') this.doc.import(event.bytes)
        if (event.type === 'ephemeral') this.ephemeral.apply(event.bytes)
      })
    )
  }

  get peerId(): string {
    return this.doc.peerIdStr
  }

  get origin(): string {
    return `${ACTOR_ORIGIN_PREFIX}${this.profile.actorId}`
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const unsubscribe of this.subscriptions) unsubscribe()
    this.ephemeral.delete(this.peerId)
    this.hub.applyEphemeral(this.profile.actorId, this.ephemeral.encodeAll())
  }

  /**
   * The single choke point. Never throws for a tool body: anything a tool
   * cannot express as a `MutationErr` is reported as `schema` with the
   * message, and logged.
   */
  call(name: string, args: Record<string, unknown> = {}): ToolResult {
    const started = Date.now()
    if (this.disposed) {
      return this.logged(started, name, fail('forbidden', 'This session has been disposed.'))
    }
    if (!isToolName(name)) {
      return this.logged(started, name, fail('schema', `Unknown tool: ${name}`))
    }
    if (this.allowedTools && !this.allowedTools.has(name)) {
      return this.logged(
        started,
        name,
        fail('forbidden', `${name} is not available to ${this.profile.name}.`)
      )
    }
    let result: ToolResult
    try {
      result = this.dispatch(name, args ?? {})
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      result = fail('schema', `${name} failed: ${message}`)
    }
    return this.logged(started, name, result, args)
  }

  private dispatch(name: ToolName, args: Record<string, unknown>): ToolResult {
    switch (name) {
      case 'get_document':
        return getDocument(this, args)
      case 'get_blocks':
        return getBlocks(this, args)
      case 'search':
        return search(this, args)
      case 'insert_text':
        return insertText(this, args)
      case 'replace_text':
        return replaceText(this, args)
      case 'apply_marks':
        return applyMarks(this, args)
      case 'insert_blocks':
        return insertBlocks(this, args)
      case 'update_block':
        return updateBlock(this, args)
      case 'delete_blocks':
        return deleteBlocks(this, args)
      case 'undo':
        return this.undo()
      case 'redo':
        return this.redo()
      case 'set_presence':
        return setPresence(this, args)
      case 'get_presence':
        return getPresence(this, args)
      case 'add_comment':
        return addComment(this, args)
      case 'reply_comment':
        return replyComment(this, args)
      case 'resolve_comment':
        return resolveComment(this, args)
      case 'list_comments':
        return listComments(this, args)
    }
  }

  private undo(): MutationResult {
    if (!this.undoManager.canUndo()) return fail('conflict', 'Nothing to undo.')
    this.undoManager.undo()
    return this.ok('undo', [])
  }

  private redo(): MutationResult {
    if (!this.undoManager.canRedo()) return fail('conflict', 'Nothing to redo.')
    this.undoManager.redo()
    return this.ok('redo', [])
  }

  // ---- SessionContext -----------------------------------------------------

  prepareBlock(
    blockId: BlockId,
    view: string | undefined
  ): MutationErr | { ok: true; found: LocatedBlock } {
    const found = findBlock(this.doc, blockId)
    if (!found) return fail('not_found', `Block ${blockId} was not found.`)
    if (view && viewOf(found.node) !== view) {
      const block = toBlockView(found.node)
      return {
        ok: false,
        error: 'conflict',
        message: 'Block changed since it was last read. Re-read and retry.',
        blocks: block ? [block] : []
      }
    }
    return { ok: true, found }
  }

  claimConflict(blockId: BlockId): MutationErr | null {
    if (!this.enforceClaims) return null
    const claim = findClaim(this, blockId)
    if (!claim) return null
    return fail('claimed', `${claim.who} currently claims this block. Wait or edit somewhere else.`)
  }

  mutate(applied: string, write: () => LoroMap[]): MutationResult {
    let nodes: LoroMap[] = []
    this.commit(applied, () => {
      nodes = write()
    })
    const last = nodes[nodes.length - 1]
    if (last) {
      const cursor = cursorAt(last, blockAgentText(last).length)
      this.writePresence(cursor?.encode() ?? null)
    }
    return this.ok(applied, nodes)
  }

  commit(message: string, write: () => void): void {
    ensureAuthor(this.doc, {
      actorId: this.profile.actorId,
      name: this.profile.name,
      color: this.profile.color,
      role: this.profile.role
    })
    this.undoManager.groupStart()
    try {
      write()
    } catch (err) {
      // Whatever landed before the throw must not stay pending: commit it
      // under a message that says so, then let `call()` report the error.
      closeGroup(this.undoManager)
      commitBoundary(this.doc, { origin: this.origin, message: `failed: ${message}` })
      throw err
    }
    closeGroup(this.undoManager)
    commitBoundary(this.doc, { origin: this.origin, message })
  }

  undoState(): UndoState {
    return { canUndo: this.undoManager.canUndo(), canRedo: this.undoManager.canRedo() }
  }

  presence(nearBlockId?: string): Presence[] {
    return readPresence(this, nearBlockId)
  }

  writePresence(cursorBytes: Uint8Array | null, claimIds: string[] = [], until?: string): void {
    const payload: EphemeralPayload = {
      anchor: cursorBytes,
      focus: cursorBytes,
      user: {
        name: this.profile.name,
        color: this.profile.color,
        actorId: this.profile.actorId,
        role: this.profile.role
      },
      claim: claimIds.length && until ? { blockIds: claimIds, until } : undefined
    }
    this.ephemeral.set(this.peerId, payload)
  }

  // ---- helpers ------------------------------------------------------------

  private ok(applied: string, nodes: LoroMap[]): MutationResult {
    const blocks = nodes.map((node) => toBlockView(node)).filter((b): b is BlockView => b != null)
    return {
      ok: true,
      applied,
      blocks,
      presenceNearby: this.presence(),
      undo: this.undoState()
    }
  }

  private logged(
    at: number,
    tool: string,
    result: ToolResult,
    args: Record<string, unknown> = {}
  ): ToolResult {
    const ok = !isMutationResult(result) || result.ok
    this.onLog?.({
      at,
      actorId: this.profile.actorId,
      name: this.profile.name,
      tool,
      summary: summarize(tool, args, result),
      ok
    })
    return result
  }
}

function closeGroup(undoManager: UndoManager): void {
  try {
    undoManager.groupEnd()
  } catch {
    /* the group may already be closed by a conflicting import */
  }
}

function summarize(name: string, args: Record<string, unknown>, result: unknown): string {
  if (isMutationResult(result) && !result.ok) return result.message
  const rec = (result ?? {}) as Record<string, unknown>
  switch (name) {
    case 'get_document':
      return `outline (${(rec.blocks as unknown[] | undefined)?.length ?? 0} blocks)`
    case 'get_blocks':
      return `read ${(rec.blocks as unknown[] | undefined)?.length ?? 0} block(s)`
    case 'search':
      return `${(rec.hits as unknown[] | undefined)?.length ?? 0} hits for "${asString(args.query) ?? ''}"`
    case 'set_presence':
      return 'presence updated'
    case 'get_presence':
      return `${(rec.actors as unknown[] | undefined)?.length ?? 0} participants`
    case 'add_comment': {
      const body = (rec.thread as { body?: string } | undefined)?.body
      return body ? `comment: ${body.slice(0, 80)}` : 'comment added'
    }
    case 'reply_comment': {
      const body = (rec.reply as { body?: string } | undefined)?.body
      return body ? `reply: ${body.slice(0, 80)}` : 'reply added'
    }
    case 'resolve_comment':
      return 'thread resolved'
    case 'list_comments':
      return `${(rec.threads as unknown[] | undefined)?.length ?? 0} threads`
    default:
      return isMutationResult(result) && result.ok ? result.applied : name
  }
}
