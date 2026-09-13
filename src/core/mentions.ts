import { LoroDoc, LoroMap } from 'loro-crdt'
import { MENTION_NODE } from '../shared/constants'
import { mentionedHandles } from '../shared/handles'
import type { MentionAttrs, MentionRequest, MentionState, MentionTarget } from '../shared/types'
import { listThreads } from './comments'
import { allBlocks, blockAgentText, blockIdOf, getAttrs, getChildren, nodeName } from './tree'

/**
 * Mentions in the document tree. A chip is an inline `mention` map among a
 * block's children (see `blockPlainText`, which flattens it to `@handle` for
 * agents). Requests live on the chip itself — `requestId`, `sentAt`, `state`
 * — so they sync, persist and survive a reload without any extra store.
 */

export type MentionSite = { blockId: string; node: LoroMap; attrs: MentionAttrs; index: number }

export function mentionSites(doc: LoroDoc): MentionSite[] {
  const out: MentionSite[] = []
  for (const { node } of allBlocks(doc)) {
    const blockId = blockIdOf(node)
    if (!blockId) continue
    const children = getChildren(node)
    for (let i = 0; i < children.length; i += 1) {
      const child = children.get(i)
      if (!(child instanceof LoroMap) || nodeName(child) !== MENTION_NODE) continue
      const attrs = mentionAttrsOf(child)
      if (attrs) out.push({ blockId, node: child, attrs, index: i })
    }
  }
  return out
}

export function mentionAttrsOf(node: LoroMap): MentionAttrs | null {
  const attrs = getAttrs(node)
  const id = attrs.get('id')
  const handle = attrs.get('handle')
  if (typeof id !== 'string' || typeof handle !== 'string') return null
  const kind = attrs.get('kind') === 'agent' ? 'agent' : 'person'
  const label = attrs.get('label')
  const out: MentionAttrs = { kind, id, handle, label: typeof label === 'string' ? label : handle }
  const requestId = attrs.get('requestId')
  if (typeof requestId === 'string') out.requestId = requestId
  const sentAt = attrs.get('sentAt')
  if (typeof sentAt === 'number') out.sentAt = sentAt
  const state = attrs.get('state')
  if (typeof state === 'string') out.state = state as MentionState
  return out
}

/**
 * Requests sent from the document: every chip with `sentAt`, with the block
 * text as the message. Recipients scan this on every change and after a
 * rejoin, which is how an offline collaborator finds a mention on return.
 */
export function documentRequests(
  doc: LoroDoc,
  docId: string,
  fromFor: (blockId: string) => MentionRequest['from']
): MentionRequest[] {
  const out: MentionRequest[] = []
  for (const site of mentionSites(doc)) {
    const { attrs, blockId } = site
    if (!attrs.requestId || !attrs.sentAt) continue
    const found = allBlocks(doc).find(({ node }) => blockIdOf(node) === blockId)
    out.push({
      requestId: attrs.requestId,
      docId,
      origin: 'document',
      blockId,
      target: targetOf(attrs),
      from: fromFor(blockId),
      text: found ? blockAgentText(found.node) : '',
      at: attrs.sentAt
    })
  }
  return out
}

/**
 * Requests from comments: a body or reply that names a handle. The thread or
 * reply id is the request id, so the same mention is never delivered twice.
 */
export function commentRequests(
  doc: LoroDoc,
  docId: string,
  resolve: (handle: string) => MentionTarget | null
): MentionRequest[] {
  const out: MentionRequest[] = []
  for (const thread of listThreads(doc, { status: 'all' })) {
    const items = [
      { id: `thread:${thread.id}`, body: thread.body, author: thread.author, at: thread.createdAt },
      ...thread.replies.map((reply) => ({
        id: `reply:${reply.id}`,
        body: reply.body,
        author: reply.author,
        at: reply.at
      }))
    ]
    for (const item of items) {
      for (const handle of new Set(mentionedHandles(item.body))) {
        const target = resolve(handle)
        if (!target) continue
        out.push({
          requestId: `${item.id}:${target.id}`,
          docId,
          origin: 'comment',
          blockId: thread.blockId,
          threadId: thread.id,
          target,
          from: { id: item.author.id, name: item.author.name, color: item.author.color },
          text: item.body,
          at: item.at
        })
      }
    }
  }
  return out
}

/** Write a request's state onto its chip. Returns false when the chip is gone. */
export function setMentionState(doc: LoroDoc, requestId: string, state: MentionState): boolean {
  for (const site of mentionSites(doc)) {
    if (site.attrs.requestId !== requestId) continue
    if (site.attrs.state === state) return true
    getAttrs(site.node).set('state', state)
    return true
  }
  return false
}

/** The instruction an agent gets: the block text without the leading chip. */
export function requestInstruction(text: string, handle: string): string {
  return text.replace(new RegExp(`^\\s*@${handle}\\b[:,]?\\s*`, 'i'), '').trim()
}

export function targetOf(attrs: MentionAttrs): MentionTarget {
  return { kind: attrs.kind, id: attrs.id, handle: attrs.handle, label: attrs.label }
}
