import type {
  CommentAuthor,
  CommentThread,
  MutationErr,
  ReplyResult,
  TextLocator,
  ThreadResult,
  ThreadsResult
} from '../../shared/types'
import { encodeAnchor } from '../anchors'
import { listThreads, openThread, replyToThread, resolveThread, getThread } from '../comments'
import { resolveRange, resolveRangeInString } from '../locators'
import { blockAgentText, findBlock, firstText, isSyntaxFigure } from '../tree'
import { asRecord, asString, fail, type SessionContext } from './context'

function authorOf(ctx: SessionContext): CommentAuthor {
  return {
    id: ctx.profile.actorId,
    name: ctx.profile.name,
    role: ctx.profile.role,
    color: ctx.profile.color
  }
}

function checkBody(ctx: SessionContext, raw: unknown): { ok: true; body: string } | MutationErr {
  const body = asString(raw)?.trim()
  if (!body) return fail('schema', 'body is required.')
  if (body.length > ctx.limits.maxCommentChars) {
    return fail('limit', `Comments are limited to ${ctx.limits.maxCommentChars} characters.`)
  }
  return { ok: true, body }
}

export function addComment(
  ctx: SessionContext,
  args: Record<string, unknown>
): ThreadResult | MutationErr {
  const blockId = asString(args.blockId)
  if (!blockId) return fail('schema', 'blockId is required.')
  const checked = checkBody(ctx, args.body)
  if (!checked.ok) return checked
  const found = findBlock(ctx.doc, blockId)
  if (!found) return fail('not_found', `Block ${blockId} was not found.`)

  const content = blockAgentText(found.node)
  const locator = asRecord(args.locator) as TextLocator | undefined
  let start = 0
  let end = content.length
  if (locator && Object.keys(locator).length > 0) {
    const text = isSyntaxFigure(found.node) ? null : firstText(found.node)
    const resolved = text
      ? resolveRange(ctx.doc, text, locator, 'span')
      : resolveRangeInString(content, locator, 'span')
    if (!resolved.ok) return fail('invalid_locator', resolved.message)
    start = resolved.range.start
    end = resolved.range.end
  }
  if (end < start || (end === start && content.length > 0)) {
    return fail('invalid_locator', 'Comment range is empty.')
  }

  const text = isSyntaxFigure(found.node) ? null : firstText(found.node)
  const anchorStart = text?.getCursor(start, 0)
  const anchorEnd = text?.getCursor(end, 0)
  let thread: CommentThread | null = null
  ctx.commit(`comment: ${checked.body.slice(0, 80)}`, () => {
    thread = openThread(ctx.doc, {
      blockId,
      quote: content.slice(start, end),
      start,
      end,
      anchorStart: anchorStart ? encodeAnchor(anchorStart) : '',
      anchorEnd: anchorEnd ? encodeAnchor(anchorEnd) : '',
      author: authorOf(ctx),
      body: checked.body
    })
  })
  return { ok: true as const, thread: thread as unknown as CommentThread }
}

export function replyComment(
  ctx: SessionContext,
  args: Record<string, unknown>
): ReplyResult | MutationErr {
  const threadId = asString(args.threadId)
  if (!threadId) return fail('schema', 'threadId is required.')
  const checked = checkBody(ctx, args.body)
  if (!checked.ok) return checked
  if (!getThread(ctx.doc, threadId)) return fail('not_found', `Thread ${threadId} was not found.`)
  let result: ReturnType<typeof replyToThread> = 'not_found'
  ctx.commit(`reply: ${checked.body.slice(0, 80)}`, () => {
    result = replyToThread(ctx.doc, threadId, authorOf(ctx), checked.body)
  })
  if (typeof result === 'string') return fail(result, `Could not reply to ${threadId}.`)
  return { ok: true as const, reply: result, thread: getThread(ctx.doc, threadId) }
}

export function resolveComment(
  ctx: SessionContext,
  args: Record<string, unknown>
): ThreadResult | MutationErr {
  const threadId = asString(args.threadId)
  if (!threadId) return fail('schema', 'threadId is required.')
  const reason = asString(args.reason)?.trim()
  if (reason && reason.length > 500) return fail('limit', 'reason is limited to 500 characters.')
  const existing = getThread(ctx.doc, threadId)
  if (!existing) return fail('not_found', `Thread ${threadId} was not found.`)
  if (existing.status === 'resolved') {
    return fail('conflict', `Thread ${threadId} is already resolved.`)
  }
  let result: ReturnType<typeof resolveThread> = 'not_found'
  ctx.commit(reason ? `resolve: ${reason.slice(0, 80)}` : 'resolve thread', () => {
    if (reason) replyToThread(ctx.doc, threadId, authorOf(ctx), reason)
    result = resolveThread(ctx.doc, threadId, authorOf(ctx))
  })
  if (typeof result === 'string') return fail(result, `Could not resolve ${threadId}.`)
  return { ok: true as const, thread: result }
}

export function listComments(
  ctx: SessionContext,
  args: Record<string, unknown>
): ThreadsResult | MutationErr {
  const blockId = asString(args.blockId)
  const status = asString(args.status)
  if (status && status !== 'open' && status !== 'resolved' && status !== 'all') {
    return fail('schema', 'status must be open, resolved or all.')
  }
  let mentioning: string | undefined
  if (args.mentioning !== undefined) {
    if (args.mentioning !== 'me') return fail('schema', 'mentioning must be "me".')
    if (!ctx.profile.handle) return { threads: [] }
    mentioning = ctx.profile.handle
  }
  const threads = listThreads(ctx.doc, {
    blockId,
    status: status as 'open' | 'resolved' | 'all' | undefined,
    mentioning
  })
  return { threads }
}
