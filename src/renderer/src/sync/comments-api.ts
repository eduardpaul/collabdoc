import {
  deleteThreadBody,
  editReply,
  editThreadBody,
  getThread,
  openThreadOnRange,
  refreshOrphans,
  reopenThread,
  replyToThread,
  resolveThread,
  type CommentError
} from '@core/comments'
import { ORPHAN_ORIGIN } from '@shared/constants'
import type { CommentAuthor, CommentThread } from '@shared/types'
import type { DocumentClient } from './DocumentClient'

export type CommentActionResult = { ok: true; thread: CommentThread } | { ok: false; error: string }

/**
 * The local user's comment actions, each one attributed commit and one undo
 * step — the renderer's counterpart of the agent tools, on the same core
 * model with the same permissions.
 */
export class CommentsApi {
  constructor(private readonly client: DocumentClient) {}

  private get author(): CommentAuthor {
    const { actorId, name, role, color } = this.client.profile
    return { id: actorId, name, role, color }
  }

  add(input: { blockId: string; start?: number; end?: number; body: string }): CommentActionResult {
    const body = input.body.trim()
    if (!body) return { ok: false, error: 'Write something first.' }
    let result: CommentThread | CommentError = 'not_found'
    this.client.commitStep(`comment: ${body.slice(0, 80)}`, () => {
      result = openThreadOnRange(this.client.doc, { ...input, body, author: this.author })
    })
    return finish(result)
  }

  reply(threadId: string, body: string): CommentActionResult {
    const text = body.trim()
    if (!text) return { ok: false, error: 'Write something first.' }
    let result: CommentError | null = null
    this.client.commitStep(`reply: ${text.slice(0, 80)}`, () => {
      const written = replyToThread(this.client.doc, threadId, this.author, text)
      if (typeof written === 'string') result = written
    })
    return result ? finish(result) : finish(getThread(this.client.doc, threadId) ?? 'not_found')
  }

  resolve(threadId: string): CommentActionResult {
    let result: CommentThread | CommentError = 'not_found'
    this.client.commitStep('resolve thread', () => {
      result = resolveThread(this.client.doc, threadId, this.author)
    })
    return finish(result)
  }

  reopen(threadId: string): CommentActionResult {
    let result: CommentThread | CommentError = 'not_found'
    this.client.commitStep('reopen thread', () => {
      result = reopenThread(this.client.doc, threadId)
    })
    return finish(result)
  }

  edit(threadId: string, body: string): CommentActionResult {
    const text = body.trim()
    if (!text) return { ok: false, error: 'Write something first.' }
    let result: CommentThread | CommentError = 'not_found'
    this.client.commitStep('edit comment', () => {
      result = editThreadBody(this.client.doc, threadId, this.author.id, text)
    })
    return finish(result)
  }

  remove(threadId: string): CommentActionResult {
    let result: CommentThread | CommentError = 'not_found'
    this.client.commitStep('delete comment', () => {
      result = deleteThreadBody(this.client.doc, threadId, this.author.id)
    })
    return finish(result)
  }

  editReply(threadId: string, replyId: string, body: string): CommentActionResult {
    const text = body.trim()
    if (!text) return { ok: false, error: 'Write something first.' }
    return this.patchReply(threadId, replyId, 'edit reply', { body: text })
  }

  removeReply(threadId: string, replyId: string): CommentActionResult {
    return this.patchReply(threadId, replyId, 'delete reply', { deleted: true })
  }

  /**
   * Mark threads whose span or block is gone. Every peer runs this after
   * changes; the writes are idempotent, so whoever notices first wins and the
   * rest see nothing to do.
   */
  refreshOrphans(): string[] {
    let changed: string[] = []
    this.client.commitSystem(ORPHAN_ORIGIN, () => {
      changed = refreshOrphans(this.client.doc)
    })
    return changed
  }

  private patchReply(
    threadId: string,
    replyId: string,
    message: string,
    patch: { body?: string; deleted?: boolean }
  ): CommentActionResult {
    let result: CommentError | null = null
    this.client.commitStep(message, () => {
      const written = editReply(this.client.doc, threadId, replyId, this.author.id, patch)
      if (typeof written === 'string') result = written
    })
    return result ? finish(result) : finish(getThread(this.client.doc, threadId) ?? 'not_found')
  }
}

const MESSAGES: Record<CommentError, string> = {
  not_found: 'That comment is gone.',
  forbidden: 'Only the author can change this.',
  conflict: 'That comment already changed.',
  invalid_range: 'Nothing is selected to comment on.'
}

function finish(result: CommentThread | CommentError): CommentActionResult {
  if (typeof result === 'string') return { ok: false, error: MESSAGES[result] }
  return { ok: true, thread: result }
}
