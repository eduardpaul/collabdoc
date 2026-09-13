// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { CommentAuthor, CommentThread, ReplyResult, ThreadResult } from '../shared/types'
import { REVIEWER_TOOLS } from '../shared/tools'
import {
  currentSpan,
  deleteThreadBody,
  editReply,
  editThreadBody,
  getThread,
  hasOpenThread,
  listThreads,
  locateQuote,
  markOrphaned,
  openThread,
  refreshOrphans,
  reopenThread,
  replyToThread,
  resolveThread,
  setSuggestion,
  threadMentions,
  threadsAsFootnotes,
  transitionSuggestion
} from './comments'
import { SyncHub } from './hub'
import { addParagraph, expectOk, human, reviewer, textOf, writer } from './test-helpers'

const ANA: CommentAuthor = { id: 'ana', name: 'Ana', role: 'human', color: '#c45c26' }
const REX: CommentAuthor = { id: 'rex', name: 'Rex', role: 'agent', color: '#1f8a70' }

function thread(result: unknown): CommentThread {
  expectOk(result)
  return (result as ThreadResult).thread
}

describe('comment threads through the tools', () => {
  it('people and agents open, reply, resolve and list threads the same way', () => {
    const hub = SyncHub.create()
    const ana = human(hub, 'ana')
    const rex = reviewer(hub, 'rex')
    const blockId = addParagraph(ana, 'The cat sat on the mat.')

    const opened = thread(
      ana.call('add_comment', {
        blockId,
        body: '@rex is "sat" the right verb?',
        locator: { find: 'sat' }
      })
    )
    expect(opened).toMatchObject({
      blockId,
      quote: 'sat',
      start: 8,
      end: 11,
      author: { id: 'ana', name: 'Ana', role: 'human' },
      status: 'open',
      replies: []
    })
    expect(opened.anchorStart).not.toBe('')

    const mine = rex.call('list_comments', { mentioning: 'me' }) as { threads: CommentThread[] }
    expect(mine.threads.map((t) => t.id)).toEqual([opened.id])
    const nobody = ana.call('list_comments', { mentioning: 'me' }) as { threads: CommentThread[] }
    expect(nobody.threads).toEqual([])

    const reply = rex.call('reply_comment', { threadId: opened.id, body: 'Yes — keep it.' })
    expectOk(reply)
    expect((reply as ReplyResult).reply).toMatchObject({
      author: { id: 'rex', role: 'agent' },
      body: 'Yes — keep it.'
    })
    expect((reply as ReplyResult).thread?.replies).toHaveLength(1)

    const seenByAna = ana.call('list_comments', { blockId }) as { threads: CommentThread[] }
    expect(seenByAna.threads[0].replies[0].body).toBe('Yes — keep it.')

    const resolved = thread(
      rex.call('resolve_comment', { threadId: opened.id, reason: 'Answered.' })
    )
    expect(resolved).toMatchObject({ status: 'resolved', resolvedBy: 'rex' })
    expect(resolved.replies.map((r) => r.body)).toEqual(['Yes — keep it.', 'Answered.'])
    expect(resolved.resolvedAt).toBeGreaterThan(0)

    expect((ana.call('list_comments', {}) as { threads: unknown[] }).threads).toEqual([])
    expect(
      (ana.call('list_comments', { status: 'resolved' }) as { threads: unknown[] }).threads
    ).toHaveLength(1)
    expect(
      (ana.call('list_comments', { status: 'all' }) as { threads: unknown[] }).threads
    ).toHaveLength(1)
    expect(rex.call('resolve_comment', { threadId: opened.id })).toMatchObject({
      ok: false,
      error: 'conflict'
    })
    expect(
      rex.call('resolve_comment', { threadId: opened.id, reason: 'x'.repeat(501) })
    ).toMatchObject({ ok: false, error: 'limit' })
  })

  it('validates comment arguments', () => {
    const hub = SyncHub.create()
    const ana = human(hub)
    const blockId = addParagraph(ana, 'Some text')
    expect(ana.call('add_comment', { body: 'x' })).toMatchObject({ ok: false, error: 'schema' })
    expect(ana.call('add_comment', { blockId, body: '   ' })).toMatchObject({
      ok: false,
      error: 'schema'
    })
    expect(ana.call('add_comment', { blockId: 'b_nope', body: 'x' })).toMatchObject({
      ok: false,
      error: 'not_found'
    })
    expect(ana.call('add_comment', { blockId, body: 'x', locator: { find: 'zzz' } })).toMatchObject(
      { ok: false, error: 'invalid_locator' }
    )
    expect(
      ana.call('add_comment', { blockId, body: 'x', locator: { after: 'Some' } })
    ).toMatchObject({ ok: false, error: 'invalid_locator' })
    expect(ana.call('reply_comment', { body: 'x' })).toMatchObject({ ok: false, error: 'schema' })
    expect(ana.call('reply_comment', { threadId: 'c_nope', body: 'x' })).toMatchObject({
      ok: false,
      error: 'not_found'
    })
    expect(ana.call('resolve_comment', {})).toMatchObject({ ok: false, error: 'schema' })
    expect(ana.call('resolve_comment', { threadId: 'c_nope' })).toMatchObject({
      ok: false,
      error: 'not_found'
    })
    const whole = thread(ana.call('add_comment', { blockId, body: 'whole block' }))
    expect(whole.quote).toBe('Some text')
    expect(whole.start).toBe(0)
    expect(whole.end).toBe(9)
  })

  it('comment actions are undoable by the participant who made them', () => {
    const hub = SyncHub.create()
    const ana = human(hub)
    const rex = writer(hub, 'rex')
    const blockId = addParagraph(ana, 'Text')
    const opened = thread(ana.call('add_comment', { blockId, body: 'note' }))
    expectOk(rex.call('reply_comment', { threadId: opened.id, body: 'reply' }))
    expect(getThread(hub.doc, opened.id)?.replies).toHaveLength(1)
    expectOk(rex.call('undo', {}))
    expect(getThread(hub.doc, opened.id)?.replies).toHaveLength(0)
    expectOk(ana.call('undo', {}))
    expect(getThread(hub.doc, opened.id)).toBeNull()
    expectOk(ana.call('redo', {}))
    expect(getThread(hub.doc, opened.id)?.body).toBe('note')
  })

  it('concurrent replies from two sessions both land', () => {
    const hub = SyncHub.create()
    const ana = human(hub)
    const blockId = addParagraph(ana, 'Text')
    const opened = thread(ana.call('add_comment', { blockId, body: 'note' }))

    const offline = SyncHub.fromSnapshot(hub.snapshot())
    const rex = writer(offline, 'rex')
    const from = offline.doc.version()
    const fromHub = hub.doc.version()
    expectOk(rex.call('reply_comment', { threadId: opened.id, body: 'from rex' }))
    expectOk(ana.call('reply_comment', { threadId: opened.id, body: 'from ana' }))
    hub.applyUpdate('offline', offline.doc.export({ mode: 'update', from }))
    offline.applyUpdate('hub', hub.doc.export({ mode: 'update', from: fromHub }))

    const bodies = getThread(hub.doc, opened.id)!
      .replies.map((r) => r.body)
      .sort()
    expect(bodies).toEqual(['from ana', 'from rex'])
    expect(
      getThread(offline.doc, opened.id)!
        .replies.map((r) => r.body)
        .sort()
    ).toEqual(bodies)
  })
})

describe('comment model', () => {
  function seeded(): { hub: SyncHub; id: string } {
    const hub = SyncHub.create()
    const opened = openThread(hub.doc, {
      blockId: 'b_1',
      quote: 'q',
      start: 0,
      end: 1,
      anchorStart: '',
      anchorEnd: '',
      author: ANA,
      body: 'hello @rex',
      createdAt: 10
    })
    hub.commitLocal('seed')
    return { hub, id: opened.id }
  }

  it('only the author edits or deletes their body and replies', () => {
    const { hub, id } = seeded()
    expect(editThreadBody(hub.doc, id, 'rex', 'nope')).toBe('forbidden')
    expect(editThreadBody(hub.doc, 'c_missing', 'ana', 'x')).toBe('not_found')
    expect((editThreadBody(hub.doc, id, 'ana', 'edited') as CommentThread).body).toBe('edited')

    const reply = replyToThread(hub.doc, id, REX, 'r1', 20)
    expect(typeof reply).toBe('object')
    const replyId = (reply as { id: string }).id
    expect(editReply(hub.doc, id, replyId, 'ana', { body: 'hijack' })).toBe('forbidden')
    expect(editReply(hub.doc, id, 'r_missing', 'rex', { body: 'x' })).toBe('not_found')
    expect(editReply(hub.doc, 'c_missing', replyId, 'rex', { body: 'x' })).toBe('not_found')
    expect(editReply(hub.doc, id, replyId, 'rex', { body: 'r1 edited' })).toMatchObject({
      body: 'r1 edited'
    })
    expect(editReply(hub.doc, id, replyId, 'rex', { deleted: true })).toMatchObject({
      body: '',
      deleted: true
    })
    expect(getThread(hub.doc, id)!.replies[0]).toMatchObject({ id: replyId, deleted: true, at: 20 })

    expect(deleteThreadBody(hub.doc, id, 'rex')).toBe('forbidden')
    expect(deleteThreadBody(hub.doc, 'c_missing', 'ana')).toBe('not_found')
    expect(deleteThreadBody(hub.doc, id, 'ana')).toMatchObject({ deleted: true, body: '' })
    expect(replyToThread(hub.doc, 'c_missing', REX, 'x')).toBe('not_found')
  })

  it('resolving declines a pending suggestion; reopening clears resolution', () => {
    const { hub, id } = seeded()
    expect(setSuggestion(hub.doc, 'c_missing', { status: 'pending' })).toBe('not_found')
    expect(
      (setSuggestion(hub.doc, id, { status: 'pending', by: undefined }) as CommentThread).suggestion
    ).toEqual({ status: 'pending' })
    const resolved = resolveThread(hub.doc, id, REX, 30) as CommentThread
    expect(resolved).toMatchObject({
      status: 'resolved',
      resolvedBy: 'rex',
      resolvedAt: 30,
      suggestion: { status: 'declined', by: 'rex' }
    })
    expect(resolveThread(hub.doc, 'c_missing', REX)).toBe('not_found')
    const reopened = reopenThread(hub.doc, id) as CommentThread
    expect(reopened.status).toBe('open')
    expect(reopened.resolvedBy).toBeUndefined()
    expect(reopened.resolvedAt).toBeUndefined()
    expect(reopenThread(hub.doc, 'c_missing')).toBe('not_found')
    expect((setSuggestion(hub.doc, id, null) as CommentThread).suggestion).toBeUndefined()
    markOrphaned(hub.doc, id, true)
    expect(getThread(hub.doc, id)?.orphaned).toBe(true)
    markOrphaned(hub.doc, id, false)
    expect(getThread(hub.doc, id)?.orphaned).toBeUndefined()
    markOrphaned(hub.doc, 'c_missing', true)
  })

  it('filters by block, status and mentions and sorts by creation time', () => {
    const { hub, id } = seeded()
    const later = openThread(hub.doc, {
      blockId: 'b_2',
      quote: '',
      start: 0,
      end: 0,
      anchorStart: '',
      anchorEnd: '',
      author: REX,
      body: 'second',
      createdAt: 5
    })
    replyToThread(hub.doc, later.id, ANA, 'ping @Ana and @rex-2 but not @r')
    expect(listThreads(hub.doc).map((t) => t.id)).toEqual([later.id, id])
    expect(listThreads(hub.doc, { blockId: 'b_1' }).map((t) => t.id)).toEqual([id])
    expect(listThreads(hub.doc, { mentioning: 'rex' }).map((t) => t.id)).toEqual([id])
    expect(listThreads(hub.doc, { mentioning: 'ana' }).map((t) => t.id)).toEqual([later.id])
    expect(listThreads(hub.doc, { mentioning: 'rex-2' }).map((t) => t.id)).toEqual([later.id])
    expect(threadMentions(getThread(hub.doc, later.id)!, 'r')).toBe(false)
    expect(hasOpenThread(hub.doc, 'ana', 'b_1')).toBe(true)
    expect(hasOpenThread(hub.doc, 'rex', 'b_1')).toBe(false)
    resolveThread(hub.doc, id, ANA)
    expect(listThreads(hub.doc, { status: 'open' }).map((t) => t.id)).toEqual([later.id])
    expect(listThreads(hub.doc, { status: 'resolved' }).map((t) => t.id)).toEqual([id])
    expect(listThreads(hub.doc, { status: 'all' })).toHaveLength(2)
  })

  it('ignores malformed entries in the comments map', () => {
    const hub = SyncHub.create()
    hub.doc.getMap('comments').set('junk', 'not a thread')
    hub.doc
      .getMap('comments')
      .setContainer('half', new (hub.doc.getMap('x').constructor as new () => never)())
    expect(listThreads(hub.doc, { status: 'all' })).toEqual([])
    expect(getThread(hub.doc, 'junk')).toBeNull()
    expect(getThread(hub.doc, 'half')).toBeNull()
  })

  it('locateQuote prefers the remembered offset and falls back to search', () => {
    expect(locateQuote('a cat and a cat', 'cat', 12)).toEqual({ start: 12, end: 15 })
    expect(locateQuote('a cat and a cat', 'cat', 3)).toEqual({ start: 2, end: 5 })
    expect(locateQuote('a cat', 'dog')).toBeNull()
    expect(locateQuote('a cat', '')).toBeNull()
  })
})

describe('comment spans and state (09)', () => {
  it('a span follows its words through edits before and inside it; deleting it orphans the thread (AC-09.6)', () => {
    const hub = SyncHub.create()
    const ana = human(hub)
    const p = addParagraph(ana, 'The quick brown fox jumps')
    const opened = thread(
      ana.call('add_comment', { blockId: p, body: 'nice', locator: { find: 'brown fox' } })
    )
    expect(opened.whole).toBeUndefined()
    expect(currentSpan(hub.doc, opened)).toEqual({ start: 10, end: 19 })
    // Editing before the span: same words, new offsets.
    expectOk(ana.call('insert_text', { blockId: p, text: 'Look! ', at: { start: 0 } }))
    const after = getThread(hub.doc, opened.id)!
    const moved = currentSpan(hub.doc, after)!
    expect(textOf(ana, p).slice(moved.start, moved.end)).toBe('brown fox')
    // Editing inside: the surviving characters stay covered.
    expectOk(ana.call('replace_text', { blockId: p, locator: { find: 'brown ' }, text: '' }))
    const inside = currentSpan(hub.doc, getThread(hub.doc, opened.id)!)!
    expect(textOf(ana, p).slice(inside.start, inside.end)).toBe('fox')
    expect(refreshOrphans(hub.doc)).toEqual([])
    // Deleting the whole span orphans the thread but keeps it listed.
    expectOk(ana.call('replace_text', { blockId: p, locator: { find: 'fox' }, text: '' }))
    expect(currentSpan(hub.doc, getThread(hub.doc, opened.id)!)).toBeNull()
    expect(refreshOrphans(hub.doc)).toEqual([opened.id])
    expect(listThreads(hub.doc, { status: 'all' }).map((t) => [t.id, t.orphaned])).toEqual([
      [opened.id, true]
    ])
    // The quoted words coming back (two undos) clears the mark: the cursors
    // point at the deleted characters, so this is the quote being found again.
    expectOk(ana.call('undo', {}))
    expectOk(ana.call('undo', {}))
    expect(textOf(ana, p)).toBe('Look! The quick brown fox jumps')
    expect(refreshOrphans(hub.doc)).toEqual([opened.id])
    expect(getThread(hub.doc, opened.id)?.orphaned).toBeUndefined()
  })

  it('a whole-block thread spans the block text and is orphaned only with the block (AC-09.10)', () => {
    const hub = SyncHub.create()
    const ana = human(hub)
    const p = addParagraph(ana, 'whole')
    const opened = thread(ana.call('add_comment', { blockId: p, body: 'block note' }))
    expect(opened.whole).toBe(true)
    expectOk(
      ana.call('replace_text', { blockId: p, locator: { find: 'whole' }, text: 'other words' })
    )
    expect(currentSpan(hub.doc, getThread(hub.doc, opened.id)!)).toEqual({ start: 0, end: 11 })
    expect(refreshOrphans(hub.doc)).toEqual([])
    expectOk(ana.call('delete_blocks', { blockIds: [p] }))
    expect(refreshOrphans(hub.doc)).toEqual([opened.id])
    expect(getThread(hub.doc, opened.id)?.orphaned).toBe(true)
  })

  it('rejects illegal thread and suggestion transitions (AC-09.3)', () => {
    const hub = SyncHub.create()
    const ana = human(hub)
    const p = addParagraph(ana, 'text')
    const id = thread(ana.call('add_comment', { blockId: p, body: 'q' })).id
    expect(reopenThread(hub.doc, id)).toBe('conflict')
    expect(transitionSuggestion(hub.doc, id, 'applying')).toBe('conflict')
    expect(transitionSuggestion(hub.doc, id, 'applied')).toBe('conflict')
    expect((transitionSuggestion(hub.doc, id, 'pending') as CommentThread).suggestion).toEqual({
      status: 'pending'
    })
    expect(transitionSuggestion(hub.doc, id, 'pending')).toBe('conflict')
    expect(transitionSuggestion(hub.doc, id, 'applied')).toBe('conflict')
    expect(
      (transitionSuggestion(hub.doc, id, 'applying', { by: 'rex' }) as CommentThread).suggestion
    ).toEqual({ status: 'applying', by: 'rex' })
    expect(transitionSuggestion(hub.doc, id, 'pending')).toBe('conflict')
    expect(transitionSuggestion(hub.doc, id, 'declined', { error: 'no' })).toMatchObject({
      suggestion: { status: 'declined', error: 'no' }
    })
    expect(transitionSuggestion(hub.doc, id, 'applied')).toBe('conflict')
    expect(transitionSuggestion(hub.doc, id, 'applying')).toBe('conflict')
    // pending → applying → applied, then nothing moves.
    expect((setSuggestion(hub.doc, id, null) as CommentThread).suggestion).toBeUndefined()
    transitionSuggestion(hub.doc, id, 'pending')
    transitionSuggestion(hub.doc, id, 'applying')
    expect(transitionSuggestion(hub.doc, id, 'applied')).toMatchObject({
      suggestion: { status: 'applied' }
    })
    expect(transitionSuggestion(hub.doc, id, 'declined')).toBe('conflict')
    // Resolved threads take no new suggestion; resolving twice conflicts.
    expectOk(ana.call('resolve_comment', { threadId: id }))
    expect(resolveThread(hub.doc, id, ANA)).toBe('conflict')
    expect(ana.call('resolve_comment', { threadId: id })).toMatchObject({
      ok: false,
      error: 'conflict'
    })
    setSuggestion(hub.doc, id, null)
    expect(transitionSuggestion(hub.doc, id, 'pending')).toBe('conflict')
    expect(reopenThread(hub.doc, id)).toMatchObject({ status: 'open' })
    expect(transitionSuggestion(hub.doc, 'c_missing', 'pending')).toBe('not_found')
  })

  it('a reply and a resolve from two sessions at once both land (AC-09.5)', () => {
    const hub = SyncHub.create()
    const ana = human(hub)
    const rex = writer(hub, 'rex')
    const p = addParagraph(ana, 'text')
    const id = thread(ana.call('add_comment', { blockId: p, body: 'question' })).id
    // Neither session sees the other's change until the hub relays it: fork
    // both, act, then let the hub merge.
    const anaDoc = ana.doc
    const rexDoc = rex.doc
    replyToThread(anaDoc, id, ANA, 'answer', 20)
    resolveThread(rexDoc, id, REX, 21)
    anaDoc.commit({ origin: 'actor:ana' })
    rexDoc.commit({ origin: 'actor:rex' })
    const merged = getThread(hub.doc, id)!
    expect(merged.status).toBe('resolved')
    expect(merged.resolvedBy).toBe('rex')
    expect(merged.replies.map((r) => r.body)).toEqual(['answer'])
    expect(getThread(anaDoc, id)).toEqual(merged)
    expect(getThread(rexDoc, id)).toEqual(merged)
  })

  it('exports threads as Markdown footnotes (AC-09.11)', () => {
    const hub = SyncHub.create()
    const ana = human(hub)
    const rex = writer(hub, 'rex')
    const p = addParagraph(ana, 'Some words here')
    const a = thread(
      ana.call('add_comment', { blockId: p, body: 'first\nline', locator: { find: 'words' } })
    )
    expectOk(rex.call('reply_comment', { threadId: a.id, body: 'ok' }))
    const b = thread(rex.call('add_comment', { blockId: p, body: 'whole' }))
    expectOk(rex.call('resolve_comment', { threadId: b.id }))
    deleteThreadBody(hub.doc, b.id, 'rex')
    expect(threadsAsFootnotes([])).toBe('')
    expect(threadsAsFootnotes(listThreads(hub.doc, { status: 'all' }))).toBe(
      [
        '',
        '---',
        '',
        '## Comments',
        '',
        `[^c1]: **Ana** (open, on “words”): first line`,
        `    - **Rex**: ok`,
        `[^c2]: **Rex** (resolved, on block): _(deleted)_`,
        ''
      ].join('\n')
    )
  })

  it('reviewer sessions have the comment and read tools and nothing else (AC-09.12)', () => {
    expect([...REVIEWER_TOOLS].sort()).toEqual(
      [
        'get_document',
        'get_blocks',
        'search',
        'get_presence',
        'add_comment',
        'reply_comment',
        'resolve_comment',
        'list_comments'
      ].sort()
    )
    const hub = SyncHub.create()
    const p = addParagraph(human(hub), 'text')
    const rev = reviewer(hub, 'rev')
    expect(rev.call('insert_text', { blockId: p, text: 'x' })).toMatchObject({
      ok: false,
      error: 'forbidden'
    })
    expectOk(rev.call('add_comment', { blockId: p, body: 'fine' }))
  })
})
