// @vitest-environment node
import { LoroMap, LoroText } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { ATTRIBUTES_KEY, CHILDREN_KEY, NODE_NAME_KEY } from '../shared/constants'
import type { BlockView, MentionTarget } from '../shared/types'
import { SyncHub } from './hub'
import {
  commentRequests,
  documentRequests,
  mentionSites,
  requestInstruction,
  setMentionState
} from './mentions'
import { addParagraph, expectOk, human, textOf, writer } from './test-helpers'
import { findBlock, getChildren } from './tree'

/** What the editor writes: a chip map before the paragraph's text run. */
function prependChip(hub: SyncHub, blockId: string, attrs: Record<string, string | number>): void {
  const node = findBlock(hub.doc, blockId)!.node
  const children = getChildren(node)
  const chip = children.insertContainer(0, new LoroMap())
  chip.set(NODE_NAME_KEY, 'mention')
  const a = chip.getOrCreateContainer(ATTRIBUTES_KEY, new LoroMap())
  for (const [key, value] of Object.entries(attrs)) a.set(key, value)
  chip.getOrCreateContainer(CHILDREN_KEY, new LoroMap())
  hub.doc.commit({ origin: 'actor:ana', timestamp: Date.now() })
}

describe('mentions in the tree (10)', () => {
  it('agents read a chip as @handle and cannot create one (AC-10.2)', () => {
    const hub = SyncHub.create()
    const ana = human(hub)
    const nova = writer(hub, 'nova')
    const p = addParagraph(ana, ' write X')
    prependChip(hub, p, { kind: 'agent', id: 'arch', handle: 'arch', label: 'Arch' })
    expect(textOf(nova, p)).toBe('@arch write X')
    const blocks = (nova.call('get_blocks', { blockIds: [p] }) as { blocks: BlockView[] }).blocks
    expect(blocks[0].text).toBe('@arch write X')
    expect(
      nova.call('insert_blocks', { blocks: [{ type: 'mention', text: '@ana' }] })
    ).toMatchObject({ ok: false, error: 'schema' })
    expect(mentionSites(hub.doc)).toHaveLength(1)
  })

  it('an agent edit after the chip keeps the chip (AC-10.7)', () => {
    const hub = SyncHub.create()
    const ana = human(hub)
    const nova = writer(hub, 'nova')
    const p = addParagraph(ana, ' write X')
    prependChip(hub, p, { kind: 'agent', id: 'arch', handle: 'arch', label: 'Arch' })
    expectOk(
      nova.call('replace_text', { blockId: p, locator: { find: 'write X' }, text: 'the intro' })
    )
    expect(textOf(nova, p)).toBe('@arch the intro')
    const children = getChildren(findBlock(hub.doc, p)!.node)
    expect(children.get(0)).toBeInstanceOf(LoroMap)
    expect(children.get(1)).toBeInstanceOf(LoroText)
  })

  it('sent chips and comment mentions are requests with stable ids (AC-10.3, AC-10.6)', () => {
    const hub = SyncHub.create()
    const ana = human(hub)
    const p = addParagraph(ana, ' please check the numbers')
    prependChip(hub, p, {
      kind: 'person',
      id: 'bea',
      handle: 'bea',
      label: 'Bea',
      requestId: 'req_1',
      sentAt: 1000
    })
    const q = addParagraph(ana, ' no request here')
    prependChip(hub, q, { kind: 'person', id: 'bea', handle: 'bea', label: 'Bea' })
    const from = { id: 'ana', name: 'Ana', color: '#c45c26' }
    const fromDoc = documentRequests(hub.doc, 'd1', () => from)
    expect(fromDoc).toEqual([
      {
        requestId: 'req_1',
        docId: 'd1',
        origin: 'document',
        blockId: p,
        target: { kind: 'person', id: 'bea', handle: 'bea', label: 'Bea' },
        from,
        text: '@bea please check the numbers',
        at: 1000
      }
    ])
    expect(setMentionState(hub.doc, 'req_1', 'seen')).toBe(true)
    expect(setMentionState(hub.doc, 'req_missing', 'seen')).toBe(false)
    expect(mentionSites(hub.doc).find((s) => s.attrs.requestId === 'req_1')?.attrs.state).toBe(
      'seen'
    )

    const opened = ana.call('add_comment', {
      blockId: p,
      body: '@reviewer is this supported?'
    }) as {
      thread: { id: string }
    }
    expectOk(
      ana.call('reply_comment', { threadId: opened.thread.id, body: 'also @bea, and @nobody' })
    )
    const resolve = (handle: string): MentionTarget | null =>
      handle === 'reviewer'
        ? { kind: 'agent' as const, id: 'rev', handle: 'reviewer', label: 'Reviewer' }
        : handle === 'bea'
          ? { kind: 'person' as const, id: 'bea', handle: 'bea', label: 'Bea' }
          : null
    const fromComments = commentRequests(hub.doc, 'd1', resolve)
    expect(fromComments.map((r) => [r.requestId.split(':')[0], r.target.id, r.threadId])).toEqual([
      ['thread', 'rev', opened.thread.id],
      ['reply', 'bea', opened.thread.id]
    ])
    expect(fromComments[0].origin).toBe('comment')
    // Same document, same ids: a rescan produces nothing new.
    expect(commentRequests(hub.doc, 'd1', resolve).map((r) => r.requestId)).toEqual(
      fromComments.map((r) => r.requestId)
    )
  })

  it('strips the leading chip from the instruction', () => {
    expect(requestInstruction('@writer draft an intro', 'writer')).toBe('draft an intro')
    expect(requestInstruction('@Writer: draft', 'writer')).toBe('draft')
    expect(requestInstruction('as @writer said', 'writer')).toBe('as @writer said')
  })
})
