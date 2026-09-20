// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { ACTOR_ORIGIN_PREFIX, DEFAULT_LIMITS } from '../shared/constants'
import { REVIEWER_TOOLS, TOOL_DEFINITIONS, TOOL_NAMES, WRITER_TOOLS } from '../shared/tools'
import type { BlockView, MutationResult, SessionLog } from '../shared/types'
import { SyncHub } from './hub'
import { addParagraph, expectOk, human, readBlock, reviewer, textOf, writer } from './test-helpers'
import { blockPlainText, findBlock, getChildren, listAssets } from './tree'

const ASSET = `asset:${'a'.repeat(64)}`

describe('DocumentSession · sync between sessions', () => {
  it('a replace_text in A is visible in B synchronously (AC-02.3)', () => {
    const hub = SyncHub.create()
    const a = writer(hub, 'nova')
    const b = writer(hub, 'rex')
    const blockId = addParagraph(a, 'The quick brown fox')
    expect(textOf(b, blockId)).toBe('The quick brown fox')

    expectOk(a.call('replace_text', { blockId, locator: { find: 'quick' }, text: 'slow' }))
    expect(textOf(b, blockId)).toBe('The slow brown fox')
    expect(blockPlainText(findBlock(hub.doc, blockId)!.node)).toBe('The slow brown fox')
  })

  it('two sessions insert into the same paragraph and both inserts survive', () => {
    const hub = SyncHub.create()
    const a = writer(hub, 'nova')
    const b = writer(hub, 'rex')
    const blockId = addParagraph(a, 'Start here.')
    a.call('insert_text', { blockId, text: ' AAA', at: { after: 'here.' } })
    b.call('insert_text', { blockId, text: ' BBB', at: { after: 'here.' } })
    const text = textOf(a, blockId)
    expect(text).toContain('AAA')
    expect(text).toContain('BBB')
    expect(textOf(b, blockId)).toBe(text)
  })

  it('a human session sees the same document through the same tools', () => {
    const hub = SyncHub.create({ title: 'Doc' })
    const ana = human(hub)
    const blockId = addParagraph(ana, 'Written by a person')
    const nova = writer(hub, 'nova')
    expect(textOf(nova, blockId)).toBe('Written by a person')
    const outline = nova.call('get_document', {}) as { blocks: Array<{ preview: string }> }
    expect(outline.blocks.map((b) => b.preview)).toContain('Written by a person')
  })
})

describe('DocumentSession · permissions (AC-02.4, AC-02.5)', () => {
  it('every tool in TOOL_DEFINITIONS is dispatched by the session', () => {
    expect(TOOL_DEFINITIONS.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort())
    const hub = SyncHub.create()
    const s = writer(hub, 'nova')
    for (const name of TOOL_NAMES) {
      const result = s.call(name, {}) as { ok?: boolean; error?: string }
      expect(result.error, name).not.toBe('forbidden')
      expect(
        result.error === 'schema' &&
          /Unknown tool/.test(String((result as { message?: string }).message)),
        name
      ).toBe(false)
    }
    expect(s.call('not_a_tool', {})).toMatchObject({ ok: false, error: 'schema' })
  })

  it('a tool outside allowedTools returns forbidden and changes nothing', () => {
    const hub = SyncHub.create()
    const ana = human(hub)
    const blockId = addParagraph(ana, 'untouched')
    const before = hub.doc.version().toJSON()
    const rev = reviewer(hub, 'critic')
    const logs: SessionLog[] = []
    rev.onLog = (entry) => logs.push(entry)
    const result = rev.call('replace_text', {
      blockId,
      locator: { find: 'untouched' },
      text: 'touched'
    })
    expect(result).toMatchObject({ ok: false, error: 'forbidden' })
    expect(textOf(ana, blockId)).toBe('untouched')
    expect(hub.doc.version().toJSON()).toEqual(before)
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({ tool: 'replace_text', ok: false, actorId: 'critic' })
  })

  it('reviewers cannot mutate text but can open, reply to and resolve threads', () => {
    const hub = SyncHub.create()
    const ana = human(hub)
    const blockId = addParagraph(ana, 'Reviewed paragraph')
    const rev = reviewer(hub, 'critic')
    const denied = [
      ['insert_text', { blockId, text: 'x' }],
      ['replace_text', { blockId, locator: { find: 'Reviewed' }, text: 'x' }],
      ['insert_blocks', { at: { relation: 'inside_end' }, blocks: [{ type: 'paragraph' }] }],
      ['update_block', { blockId, type: 'heading' }],
      ['delete_blocks', { blockIds: [blockId] }],
      [
        'apply_marks',
        { blockId, marks: [{ op: 'add', type: 'bold', range: { find: 'Reviewed' } }] }
      ],
      ['undo', {}],
      ['redo', {}],
      ['set_presence', { cursor: { blockId } }]
    ] as const
    for (const [tool, args] of denied) {
      expect(rev.call(tool, args as Record<string, unknown>), tool).toMatchObject({
        ok: false,
        error: 'forbidden'
      })
    }
    const opened = rev.call('add_comment', {
      blockId,
      body: 'Tighten this.',
      locator: { find: 'paragraph' }
    })
    expectOk(opened)
    const threadId = (opened as { thread: { id: string } }).thread.id
    expectOk(rev.call('reply_comment', { threadId, body: 'Also the tone.' }))
    expectOk(rev.call('resolve_comment', { threadId }))
    expect(textOf(ana, blockId)).toBe('Reviewed paragraph')
    for (const tool of ['get_document', 'get_blocks', 'search', 'get_presence', 'list_comments']) {
      expect(REVIEWER_TOOLS).toContain(tool)
      expect(WRITER_TOOLS).toContain(tool)
    }
  })

  it('never throws from a tool body', () => {
    const hub = SyncHub.create()
    const s = writer(hub, 'nova')
    // Argument shapes an LLM might produce.
    const garbage: Array<[string, Record<string, unknown>]> = [
      ['get_blocks', { blockIds: 'b_1' }],
      ['get_blocks', { blockIds: [1, 2] }],
      ['search', { query: 5 }],
      ['insert_text', { blockId: 'nope', text: 'x' }],
      ['insert_text', { blockId: ['x'], text: 'x' }],
      ['replace_text', { blockId: 'nope', locator: 'find me', text: '' }],
      ['apply_marks', { blockId: 'nope', marks: 'bold' }],
      ['insert_blocks', { blocks: 'paragraph', at: null }],
      ['insert_blocks', { blocks: [null], at: {} }],
      ['insert_blocks', { blocks: [{ type: 'paragraph' }], at: { relation: 'sideways' } }],
      ['update_block', { blockId: 7 }],
      ['delete_blocks', { blockIds: [] }],
      ['set_presence', { cursor: 'here', claimBlockIds: 'all' }],
      ['add_comment', { blockId: 'nope', body: 42 }],
      ['reply_comment', { threadId: 'nope', body: 'x' }],
      ['resolve_comment', { threadId: 'nope' }],
      ['list_comments', { status: 'weird' }],
      ['list_comments', { mentioning: 'you' }]
    ]
    for (const [tool, args] of garbage) {
      let result: unknown
      expect(() => {
        result = s.call(tool, args)
      }, tool).not.toThrow()
      expect((result as { ok?: boolean }).ok, `${tool} ${JSON.stringify(args)}`).toBe(false)
    }
    expect(() =>
      s.call('get_document', undefined as unknown as Record<string, unknown>)
    ).not.toThrow()
  })
})

describe('DocumentSession · text tools', () => {
  it('replace_text refuses a stale find and returns conflict for a stale view', () => {
    const hub = SyncHub.create()
    const a = writer(hub, 'nova')
    const b = writer(hub, 'rex')
    const blockId = addParagraph(a, 'Collaborative canvas')
    const snapshot = readBlock(a, blockId)

    expectOk(
      b.call('replace_text', { blockId, locator: { find: 'Collaborative' }, text: 'Shared' })
    )

    const stale = a.call('replace_text', {
      blockId,
      locator: { find: 'Collaborative canvas' },
      text: 'Agent canvas'
    }) as MutationResult
    expect(stale).toMatchObject({ ok: false, error: 'invalid_locator' })

    const conflict = a.call('replace_text', {
      blockId,
      locator: { find: 'canvas' },
      text: 'page',
      view: snapshot.view
    }) as MutationResult
    expect(conflict).toMatchObject({ ok: false, error: 'conflict' })
    expect(!conflict.ok && conflict.blocks?.[0].text).toBe('Shared canvas')

    const fresh = readBlock(a, blockId)
    expectOk(
      a.call('replace_text', {
        blockId,
        locator: { find: 'canvas' },
        text: 'page',
        view: fresh.view
      })
    )
    expect(textOf(b, blockId)).toBe('Shared page')
  })

  it('insert_text with marks and apply_marks add/remove respect ALLOWED_MARKS', () => {
    const hub = SyncHub.create()
    const a = writer(hub, 'nova')
    const blockId = addParagraph(a, 'plain')
    expectOk(a.call('insert_text', { blockId, text: ' bold', marks: [{ type: 'bold' }] }))
    expect(readBlock(a, blockId).marks).toEqual([{ type: 'bold', attrs: {}, start: 5, end: 10 }])

    expect(a.call('insert_text', { blockId, text: 'x', marks: [{ type: 'blink' }] })).toMatchObject(
      {
        ok: false,
        error: 'schema'
      }
    )
    expect(
      a.call('apply_marks', {
        blockId,
        marks: [{ op: 'add', type: 'blink', range: { find: 'plain' } }]
      })
    ).toMatchObject({ ok: false, error: 'schema' })
    expect(
      a.call('apply_marks', { blockId, marks: [{ op: 'toggle', type: 'bold' }] })
    ).toMatchObject({
      ok: false,
      error: 'schema'
    })
    expect(
      a.call('apply_marks', {
        blockId,
        marks: [{ op: 'add', type: 'bold', range: { find: 'zzz' } }]
      })
    ).toMatchObject({ ok: false, error: 'invalid_locator' })
    expect(
      a.call('apply_marks', {
        blockId,
        marks: [{ op: 'add', type: 'bold', range: { after: 'plain' } }]
      })
    ).toMatchObject({ ok: false, error: 'invalid_locator' })

    expectOk(
      a.call('apply_marks', {
        blockId,
        marks: [
          { op: 'remove', type: 'bold', range: { find: ' bold' } },
          { op: 'add', type: 'link', attrs: { href: 'https://x.y' }, range: { find: 'plain' } }
        ]
      })
    )
    expect(readBlock(a, blockId).marks).toEqual([
      { type: 'link', attrs: { href: 'https://x.y' }, start: 0, end: 5 }
    ])
  })

  it('anchors from get_blocks follow the text through concurrent edits', () => {
    const hub = SyncHub.create()
    const a = writer(hub, 'nova')
    const b = writer(hub, 'rex')
    const blockId = addParagraph(a, 'alpha beta')
    const { anchors } = readBlock(a, blockId)
    b.call('insert_text', { blockId, text: 'ZERO ', at: { before: 'alpha' } })
    expectOk(a.call('insert_text', { blockId, text: ' END', at: { anchor: anchors.end } }))
    expect(textOf(b, blockId)).toBe('ZERO alpha beta END')
    expectOk(
      a.call('replace_text', {
        blockId,
        locator: { anchor: anchors.start, length: 5 },
        text: 'zero'
      })
    )
    // `anchors.start` is attached to the first character, so it followed "alpha".
    expect(textOf(b, blockId)).toBe('ZERO zero beta END')
  })

  it('text tools refuse blocks without text', () => {
    const hub = SyncHub.create()
    const a = writer(hub, 'nova')
    const hr = a.call('insert_blocks', {
      at: { relation: 'inside_end' },
      blocks: [{ type: 'horizontalRule' }, { type: 'bulletList' }]
    }) as MutationResult
    expectOk(hr)
    for (const block of hr.blocks) {
      expect(a.call('insert_text', { blockId: block.blockId, text: 'x' })).toMatchObject({
        ok: false,
        error: 'schema'
      })
      expect(
        a.call('replace_text', { blockId: block.blockId, locator: { find: 'x' }, text: 'y' })
      ).toMatchObject({ ok: false, error: 'schema' })
      expect(
        a.call('apply_marks', { blockId: block.blockId, marks: [{ op: 'add', type: 'bold' }] })
      ).toMatchObject({ ok: false, error: 'schema' })
    }
  })

  it('search returns locators that replace_text accepts', () => {
    const hub = SyncHub.create()
    const a = writer(hub, 'nova')
    const p1 = addParagraph(a, 'red fish blue fish')
    addParagraph(a, 'one fish')
    const all = a.call('search', { query: 'fish' }) as {
      hits: Array<{ blockId: string; locator: unknown }>
    }
    expect(all.hits).toHaveLength(3)
    expect(all.hits[1]).toEqual({
      blockId: p1,
      snippet: 'red fish blue fish',
      locator: { find: 'fish', occurrence: 2 }
    })
    const only = a.call('search', { query: 'fish', blockId: p1, maxResults: 1 }) as {
      hits: unknown[]
    }
    expect(only.hits).toHaveLength(1)
    expectOk(
      a.call('replace_text', { blockId: p1, locator: all.hits[1].locator as object, text: 'whale' })
    )
    expect(textOf(a, p1)).toBe('red fish blue whale')
    expect(a.call('search', { query: '' })).toMatchObject({ ok: false, error: 'schema' })
  })
})

describe('DocumentSession · block tools', () => {
  it('refuses to nest a block inside a text block but allows containers', () => {
    const hub = SyncHub.create()
    const a = writer(hub, 'echo')
    const para = addParagraph(a, 'Body')
    const nested = a.call('insert_blocks', {
      at: { relation: 'inside_end', blockId: para },
      blocks: [{ type: 'heading', attrs: { level: 2 }, text: 'Section' }]
    }) as MutationResult
    expect(nested).toMatchObject({ ok: false, error: 'schema' })
    expect(!nested.ok && nested.message).toContain('after')
    expect(getChildren(findBlock(a.doc, para)!.node)).toHaveLength(1)

    const sibling = a.call('insert_blocks', {
      at: { relation: 'before', blockId: para },
      blocks: [{ type: 'heading', attrs: { level: 2 }, text: 'Section' }]
    }) as MutationResult
    expectOk(sibling)
    const outline = a.call('get_document', {}) as {
      blocks: Array<{ blockId: string; type: string }>
    }
    expect(outline.blocks.map((b) => b.type)).toEqual(['paragraph', 'heading', 'paragraph'])

    const quote = a.call('insert_blocks', {
      at: { relation: 'after', blockId: para },
      blocks: [{ type: 'blockquote' }]
    }) as MutationResult
    expectOk(quote)
    const quoteId = quote.blocks[0].blockId
    expectOk(
      a.call('insert_blocks', {
        at: { relation: 'inside_end', blockId: quoteId },
        blocks: [{ type: 'paragraph', text: 'Quoted line' }]
      })
    )
    expectOk(
      a.call('insert_blocks', {
        at: { relation: 'inside_start', blockId: quoteId },
        blocks: [{ type: 'paragraph', text: 'First' }]
      })
    )
    expect(blockPlainText(findBlock(a.doc, quoteId)!.node)).toBe('First\nQuoted line')
    expect(a.call('update_block', { blockId: quoteId, type: 'paragraph' })).toMatchObject({
      ok: false,
      error: 'schema'
    })
    expect(a.call('update_block', { blockId: para, type: 'blockquote' })).toMatchObject({
      ok: false,
      error: 'schema'
    })
    expectOk(
      a.call('insert_blocks', {
        at: { relation: 'inside_start' },
        blocks: [{ type: 'paragraph', text: 'Top' }]
      })
    )
    expect(
      (a.call('get_document', {}) as { blocks: Array<{ preview: string }> }).blocks[0].preview
    ).toBe('Top')
    expect(
      a.call('insert_blocks', {
        at: { relation: 'after', blockId: 'b_missing' },
        blocks: [{ type: 'paragraph' }]
      })
    ).toMatchObject({ ok: false, error: 'not_found' })
  })

  it('update_block changes type and attrs and validates heading levels', () => {
    const hub = SyncHub.create()
    const a = writer(hub, 'nova')
    const blockId = addParagraph(a, 'Title')
    expectOk(a.call('update_block', { blockId, type: 'heading', attrs: { level: 2 } }))
    expect(readBlock(a, blockId)).toMatchObject({
      type: 'heading',
      attrs: { level: 2 },
      text: 'Title'
    })
    expect(a.call('update_block', { blockId, attrs: { level: 9 } })).toMatchObject({
      ok: false,
      error: 'schema'
    })
    expect(a.call('update_block', { blockId, type: 'marquee' })).toMatchObject({
      ok: false,
      error: 'schema'
    })
    expect(a.call('update_block', { blockId, type: 'horizontalRule' })).toMatchObject({
      ok: false,
      error: 'schema'
    })
    expect(a.call('update_block', { blockId, attrs: { caption: 'x' } })).toMatchObject({
      ok: false,
      error: 'schema'
    })
    expect(a.call('update_block', { blockId, attrs: { source: 'x' } })).toMatchObject({
      ok: false,
      error: 'schema'
    })
    expectOk(
      a.call('update_block', {
        blockId,
        attrs: { level: null, textAlign: 'center', blockId: 'b_hijack' }
      })
    )
    expect(readBlock(a, blockId).attrs).toEqual({ blockId, textAlign: 'center' })
    expect(a.call('update_block', { blockId: 'b_missing', type: 'heading' })).toMatchObject({
      ok: false,
      error: 'not_found'
    })
  })

  it('delete_blocks handles nested ids, stale views and mixed parents', () => {
    const hub = SyncHub.create()
    const a = writer(hub, 'nova')
    const quote = a.call('insert_blocks', {
      at: { relation: 'inside_end' },
      blocks: [{ type: 'blockquote' }]
    }) as MutationResult
    expectOk(quote)
    const quoteId = quote.blocks[0].blockId
    const inner = a.call('insert_blocks', {
      at: { relation: 'inside_end', blockId: quoteId },
      blocks: [{ type: 'paragraph', text: 'in' }]
    }) as MutationResult
    expectOk(inner)
    const p1 = addParagraph(a, 'one')
    const p2 = addParagraph(a, 'two')
    const view = readBlock(a, p2).view
    a.call('insert_text', { blockId: p2, text: '!' })
    expect(a.call('delete_blocks', { blockIds: [p2], view })).toMatchObject({
      ok: false,
      error: 'conflict'
    })
    expect(a.call('delete_blocks', { blockIds: [p2, 'b_missing'] })).toMatchObject({
      ok: false,
      error: 'not_found'
    })
    expectOk(a.call('delete_blocks', { blockIds: [inner.blocks[0].blockId, quoteId, p2, p1] }))
    const outline = a.call('get_document', {}) as { blocks: Array<{ type: string }> }
    expect(outline.blocks.map((b) => b.type)).toEqual(['paragraph'])
  })
})

describe('DocumentSession · limits (AC-02.8)', () => {
  it('enforces the default caps', () => {
    const hub = SyncHub.create()
    const a = writer(hub, 'nova')
    const blockId = addParagraph(a, 'x')
    const long = 'y'.repeat(DEFAULT_LIMITS.maxInsertChars + 1)
    expect(a.call('insert_text', { blockId, text: long })).toMatchObject({
      ok: false,
      error: 'limit'
    })
    expect(a.call('replace_text', { blockId, locator: { find: 'x' }, text: long })).toMatchObject({
      ok: false,
      error: 'limit'
    })
    const many = Array.from({ length: DEFAULT_LIMITS.maxBlocksPerCall + 1 }, () => ({
      type: 'paragraph'
    }))
    expect(a.call('insert_blocks', { at: { relation: 'inside_end' }, blocks: many })).toMatchObject(
      { ok: false, error: 'limit' }
    )
    expect(
      a.call('insert_blocks', {
        at: { relation: 'inside_end' },
        blocks: [{ type: 'paragraph', text: long }]
      })
    ).toMatchObject({ ok: false, error: 'limit' })
    const ids = Array.from({ length: DEFAULT_LIMITS.maxBlocksPerRead + 1 }, () => blockId)
    expect(a.call('get_blocks', { blockIds: ids })).toMatchObject({ ok: false, error: 'limit' })
    expect(
      a.call('delete_blocks', { blockIds: Array.from({ length: 21 }, () => blockId) })
    ).toMatchObject({ ok: false, error: 'limit' })
    expect(
      a.call('insert_blocks', { at: { relation: 'inside_end' }, blocks: [{ type: 'marquee' }] })
    ).toMatchObject({ ok: false, error: 'schema' })
    expect(
      a.call('add_comment', { blockId, body: 'z'.repeat(DEFAULT_LIMITS.maxCommentChars + 1) })
    ).toMatchObject({ ok: false, error: 'limit' })
  })

  it('limits are configurable per session', () => {
    const hub = SyncHub.create()
    const tight = writer(hub, 'ext', {
      limits: { maxInsertChars: 10, maxSearchResults: 1, maxBlocksPerRead: 1 }
    })
    const blockId = addParagraph(tight, 'ab ab ab')
    expect(tight.call('insert_text', { blockId, text: '12345678901' })).toMatchObject({
      ok: false,
      error: 'limit'
    })
    expectOk(tight.call('insert_text', { blockId, text: '1234567890' }))
    expect(
      (tight.call('search', { query: 'ab', maxResults: 50 }) as { hits: unknown[] }).hits
    ).toHaveLength(1)
    expect(tight.call('get_blocks', { blockIds: [blockId, blockId] })).toMatchObject({
      ok: false,
      error: 'limit'
    })
    expect(tight.limits.maxBlocksPerCall).toBe(DEFAULT_LIMITS.maxBlocksPerCall)
  })
})

describe('DocumentSession · attribution (AC-02.9)', () => {
  it('commits every successful mutation with actor origin, a message and a timestamp', () => {
    const hub = SyncHub.create()
    const a = writer(hub, 'nova')
    const origins: string[] = []
    a.doc.subscribePreCommit((event) => {
      origins.push(event.origin)
    })
    const blockId = addParagraph(a, 'one')
    a.call('insert_text', { blockId, text: ' two' })
    a.call('update_block', { blockId, type: 'heading', attrs: { level: 1 } })
    a.call('add_comment', { blockId, body: 'note' })
    // The first commit is preceded by the one-off author registration.
    expect(origins).toEqual(['sys:author', ...Array(4).fill(`${ACTOR_ORIGIN_PREFIX}nova`)])

    const changes = (a.doc.getAllChanges().get(a.peerId) ?? []).filter((c) => c.message)
    expect(changes.map((c) => c.message)).toEqual([
      'insert 1 block(s)',
      'insert 4 chars',
      'update block',
      'comment: note'
    ])
    expect(changes.every((c) => c.timestamp > 0)).toBe(true)
  })

  it('registers the author with its first commit and undo is per participant', () => {
    const hub = SyncHub.create()
    const a = writer(hub, 'nova')
    const b = writer(hub, 'rex')
    expect(hub.doc.getMap('authors').size).toBe(0)
    const blockId = addParagraph(a, 'mine')
    // The handle travels too, so other machines resolve @nova to this actor.
    expect(hub.doc.getMap('authors').get(a.peerId)).toEqual({
      actorId: 'nova',
      name: 'Nova',
      color: '#123456',
      role: 'agent',
      handle: 'nova'
    })
    expect(hub.doc.getMap('authors').get(b.peerId)).toBeUndefined()

    b.call('insert_text', { blockId, text: ' and yours' })
    expect(hub.doc.getMap('authors').get(b.peerId)).toMatchObject({ actorId: 'rex' })
    // b's undo only touches b's own insert; a's edit stays.
    expect(b.call('undo', {})).toMatchObject({ ok: true, undo: { canUndo: false, canRedo: true } })
    expect(textOf(a, blockId)).toBe('mine')
    expect(b.call('undo', {})).toMatchObject({ ok: true, applied: 'nothing to undo' })
    expectOk(b.call('redo', {}))
    expect(textOf(a, blockId)).toBe('mine and yours')
    expect(b.call('redo', {})).toMatchObject({ ok: true, applied: 'nothing to redo' })
    // a's undo removes a's block; the author entry it registered survives.
    expect(a.call('undo', {})).toMatchObject({ ok: true })
    expect((b.call('get_document', {}) as { blocks: unknown[] }).blocks).toHaveLength(1)
    expect(hub.doc.getMap('authors').get(a.peerId)).toMatchObject({ actorId: 'nova' })
    expectOk(a.call('redo', {}))
    expect((b.call('get_document', {}) as { blocks: unknown[] }).blocks).toHaveLength(2)
  })
})

describe('DocumentSession · presence and claims', () => {
  it('publishes cursors and claims; claims block enforcing sessions only', () => {
    const hub = SyncHub.create()
    const a = writer(hub, 'nova', { enforceClaims: true })
    const b = writer(hub, 'rex', { enforceClaims: true })
    const relaxed = human(hub)
    const blockId = addParagraph(relaxed, 'claimable')
    const other = addParagraph(relaxed, 'free')

    expect(a.call('set_presence', { cursor: { blockId: 'b_missing' } })).toMatchObject({
      ok: false,
      error: 'not_found'
    })
    expect(a.call('set_presence', { claimBlockIds: ['b_missing'] })).toMatchObject({
      ok: false,
      error: 'not_found'
    })
    const set = a.call('set_presence', {
      cursor: { blockId, offset: 3 },
      claimBlockIds: [blockId],
      claimSeconds: 60
    })
    expectOk(set)

    const seenByB = (b.call('get_presence', {}) as { actors: Array<Record<string, unknown>> })
      .actors
    const nova = seenByB.find((p) => p.actorId === 'nova')
    expect(nova).toMatchObject({ name: 'Nova', role: 'agent', cursor: { blockId, offset: 3 } })
    expect((nova?.claim as { blockIds: string[] }).blockIds).toEqual([blockId])

    expect(b.call('insert_text', { blockId, text: 'x' })).toMatchObject({
      ok: false,
      error: 'claimed'
    })
    expectOk(b.call('insert_text', { blockId: other, text: 'x' }))
    expectOk(a.call('insert_text', { blockId, text: 'x' }))
    expectOk(relaxed.call('insert_text', { blockId, text: 'y' }))

    const near = (
      b.call('get_presence', { nearBlockId: blockId }) as { actors: Array<{ actorId: string }> }
    ).actors
    expect(near.map((p) => p.actorId)).toContain('nova')
    const nowhere = (b.call('get_presence', { nearBlockId: 'b_none' }) as { actors: unknown[] })
      .actors
    expect(nowhere).toHaveLength(0)

    a.dispose()
    const after = (b.call('get_presence', {}) as { actors: Array<{ actorId: string }> }).actors
    expect(after.map((p) => p.actorId)).not.toContain('nova')
    expectOk(b.call('insert_text', { blockId, text: 'z' }))
  })

  it('a mutation moves the cursor to the end of the last written block', () => {
    const hub = SyncHub.create()
    const a = writer(hub, 'nova')
    const blockId = addParagraph(a, 'abc')
    const me = (
      a.call('get_presence', {}) as { actors: Array<Record<string, unknown>> }
    ).actors.find((p) => p.actorId === 'nova')
    expect(me?.cursor).toEqual({ blockId, offset: 3 })
    const result = a.call('insert_text', { blockId, text: 'de' }) as MutationResult
    expectOk(result)
    expect(result.presenceNearby.find((p) => p.actorId === 'nova')?.cursor).toEqual({
      blockId,
      offset: 5
    })
  })

  it('does not assume a role when a peer published no user payload (AC-07.5)', () => {
    const hub = SyncHub.create()
    const a = human(hub, 'ana')
    addParagraph(a, 'hello')
    a.ephemeral.set('999', { anchor: null, focus: null, user: null })
    const actors = (a.call('get_presence', {}) as { actors: Array<Record<string, unknown>> }).actors
    const ghost = actors.find((p) => p.peerId === '999')
    expect(ghost).toMatchObject({ peerId: '999', actorId: '999' })
    expect(ghost?.role).toBeUndefined()
    expect(actors.find((p) => p.actorId === 'ana')?.role).toBe('human')
  })
})

describe('DocumentSession · figures (AC-02.13)', () => {
  it('mermaid and infographic figures expose the source as text and the caption as an attr', () => {
    const hub = SyncHub.create()
    const a = writer(hub, 'nova')
    const created = a.call('insert_blocks', {
      at: { relation: 'inside_end' },
      blocks: [
        { type: 'mermaidFigure', text: 'flowchart LR\n  A --> B', attrs: { caption: 'Flow' } },
        {
          type: 'infographicFigure',
          attrs: { source: 'infographic list', caption: 'Info', width: 75 }
        }
      ]
    }) as MutationResult
    expectOk(created)
    const [mermaid, info] = created.blocks
    expect(mermaid).toMatchObject({
      type: 'mermaidFigure',
      text: 'flowchart LR\n  A --> B',
      marks: []
    })
    expect(mermaid.attrs).toMatchObject({ caption: 'Flow', source: 'flowchart LR\n  A --> B' })
    expect(info).toMatchObject({ type: 'infographicFigure', text: 'infographic list' })
    expect(info.attrs).toMatchObject({ caption: 'Info', width: 75 })

    expectOk(
      a.call('replace_text', {
        blockId: mermaid.blockId,
        locator: { find: 'A --> B' },
        text: 'A --> C'
      })
    )
    expectOk(a.call('insert_text', { blockId: mermaid.blockId, text: '\n  C --> D' }))
    expect(readBlock(a, mermaid.blockId).text).toBe('flowchart LR\n  A --> C\n  C --> D')
    expect(readBlock(a, mermaid.blockId).attrs.caption).toBe('Flow')

    expectOk(
      a.call('update_block', {
        blockId: mermaid.blockId,
        attrs: { caption: 'New flow', align: 'left' }
      })
    )
    expect(readBlock(a, mermaid.blockId).attrs).toMatchObject({
      caption: 'New flow',
      align: 'left'
    })
    expectOk(
      a.call('update_block', { blockId: info.blockId, attrs: { source: 'infographic tree' } })
    )
    expect(readBlock(a, info.blockId).text).toBe('infographic tree')

    expect(
      a.call('apply_marks', {
        blockId: mermaid.blockId,
        marks: [{ op: 'add', type: 'bold', range: { find: 'LR' } }]
      })
    ).toMatchObject({ ok: false, error: 'schema' })
    expect(
      a.call('update_block', { blockId: mermaid.blockId, attrs: { width: 33 } })
    ).toMatchObject({ ok: false, error: 'schema' })
    expect(
      a.call('update_block', { blockId: mermaid.blockId, attrs: { align: 'justify' } })
    ).toMatchObject({ ok: false, error: 'schema' })
    expect(
      a.call('update_block', { blockId: mermaid.blockId, attrs: { style: 'width: 9999px' } })
    ).toMatchObject({ ok: false, error: 'schema' })
    expect(
      a.call('update_block', { blockId: mermaid.blockId, attrs: { caption: 7 } })
    ).toMatchObject({ ok: false, error: 'schema' })
    expect(a.call('update_block', { blockId: mermaid.blockId, type: 'paragraph' })).toMatchObject({
      ok: false,
      error: 'schema'
    })
    expect(
      a.call('update_block', { blockId: mermaid.blockId, attrs: { source: 'x'.repeat(9000) } })
    ).toMatchObject({ ok: false, error: 'limit' })
    expect(
      a.call('insert_text', { blockId: mermaid.blockId, text: 'x'.repeat(8000) })
    ).toMatchObject({ ok: false, error: 'limit' })

    const outline = a.call('get_document', {}) as {
      blocks: Array<{ type: string; preview: string; attrs: Record<string, unknown> }>
    }
    expect(outline.blocks[1]).toMatchObject({
      type: 'mermaidFigure',
      preview: 'flowchart LR\n  A --> C\n  C --> D',
      attrs: { caption: 'New flow' }
    })
    const hits = a.call('search', { query: 'C --> D' }) as { hits: Array<{ blockId: string }> }
    expect(hits.hits[0].blockId).toBe(mermaid.blockId)
  })

  it('comments on a figure quote the source', () => {
    const hub = SyncHub.create()
    const a = writer(hub, 'nova')
    const created = a.call('insert_blocks', {
      at: { relation: 'inside_end' },
      blocks: [{ type: 'mermaidFigure', text: 'graph TD\n  X --> Y' }]
    }) as MutationResult
    expectOk(created)
    const result = a.call('add_comment', {
      blockId: created.blocks[0].blockId,
      body: 'Rename Y',
      locator: { find: 'Y' }
    })
    expectOk(result)
    expect((result as { thread: { quote: string; anchorStart: string } }).thread).toMatchObject({
      quote: 'Y',
      anchorStart: ''
    })
  })

  it('image figures need an asset reference; data URIs and URLs are refused', () => {
    const hub = SyncHub.create()
    const a = writer(hub, 'nova')
    const bad = [
      { type: 'imageFigure' },
      { type: 'imageFigure', attrs: { src: 'data:image/png;base64,AAAA' } },
      { type: 'imageFigure', attrs: { src: 'https://example.com/x.png' } },
      { type: 'imageFigure', attrs: { src: 'asset:short' } }
    ]
    for (const block of bad) {
      expect(
        a.call('insert_blocks', { at: { relation: 'inside_end' }, blocks: [block] }),
        JSON.stringify(block)
      ).toMatchObject({ ok: false, error: 'schema' })
    }
    const created = a.call('insert_blocks', {
      at: { relation: 'inside_end' },
      blocks: [{ type: 'imageFigure', attrs: { src: ASSET, alt: 'A chart', caption: 'Figure 1' } }]
    }) as MutationResult
    expectOk(created)
    const image = created.blocks[0]
    expect(image).toMatchObject({
      type: 'imageFigure',
      text: '',
      attrs: { src: ASSET, alt: 'A chart', caption: 'Figure 1' }
    })
    expect(listAssets(hub.doc)).toEqual(['a'.repeat(64)])

    expect(
      a.call('update_block', {
        blockId: image.blockId,
        attrs: { src: 'data:image/png;base64,AAAA' }
      })
    ).toMatchObject({ ok: false, error: 'schema' })
    expect(a.call('insert_text', { blockId: image.blockId, text: 'x' })).toMatchObject({
      ok: false,
      error: 'schema'
    })
    expectOk(
      a.call('update_block', { blockId: image.blockId, attrs: { caption: 'Figure 2', width: 50 } })
    )
    expect(readBlock(a, image.blockId).attrs).toMatchObject({ caption: 'Figure 2', width: 50 })
    const whole = a.call('add_comment', { blockId: image.blockId, body: 'Nice chart' })
    expectOk(whole)
    expect((whole as { thread: { quote: string } }).thread.quote).toBe('')
  })

  it('the same block read by a second session carries the figure conventions', () => {
    const hub = SyncHub.create()
    const a = writer(hub, 'nova')
    const b = reviewer(hub, 'critic')
    const created = a.call('insert_blocks', {
      at: { relation: 'inside_end' },
      blocks: [{ type: 'infographicFigure', text: 'infographic x', attrs: { caption: 'Cap' } }]
    }) as MutationResult
    expectOk(created)
    const view = (
      b.call('get_blocks', { blockIds: [created.blocks[0].blockId] }) as { blocks: BlockView[] }
    ).blocks[0]
    expect(view.text).toBe('infographic x')
    expect(view.attrs.caption).toBe('Cap')
  })
})
