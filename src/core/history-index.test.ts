// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { addCheckpoint, listCheckpoints } from './checkpoints'
import { createDocument, openDocument } from './document'
import { diffBlocks, diffChange, diffWords } from './history-diff'
import { authorCounts, filterHistory, listHistory } from './history'
import { HistoryIndex } from './history-index'
import { SyncHub } from './hub'
import { addParagraph, expectOk, human, writer } from './test-helpers'


describe('HistoryIndex (AC-05.10)', () => {
  it('appends new commits without rewriting earlier entries', () => {
    const hub = SyncHub.create()
    const ana = human(hub, 'ana')
    addParagraph(ana, 'one')
    const index = new HistoryIndex(hub.doc)
    const first = index.list().map((e) => e.id)
    expect(first.length).toBeGreaterThan(0)
    addParagraph(ana, 'two')
    const second = index.refresh()
    expect(second.slice(0, first.length).map((e) => e.id)).toEqual(first)
    expect(second.length).toBeGreaterThan(first.length)
  })

  it('records last author per block', () => {
    const hub = SyncHub.create()
    const ana = human(hub, 'ana')
    const nova = writer(hub, 'nova')
    const p = addParagraph(ana, 'start')
    expectOk(nova.call('replace_text', { blockId: p, locator: { find: 'start' }, text: 'nova' }))
    const index = new HistoryIndex(hub.doc)
    expect(index.lastAuthor(p)?.name).toBe('Nova')
  })

  it('appends 1 000 commits onto 10 000 in under 1 s', () => {
    const doc = createDocument()
    doc.setChangeMergeInterval(0)
    const text = doc.getText('bench')
    const t0 = 1_700_000_000_000
    for (let i = 0; i < 10_000; i += 1) {
      text.insert(text.length, 'a')
      doc.commit({ origin: 'actor:ana', message: `n${i}`, timestamp: t0 + i * 2_000 })
    }
    const index = new HistoryIndex(doc)
    const before = index.list().length
    expect(before).toBeGreaterThan(10_000)
    const start = performance.now()
    for (let i = 0; i < 1_000; i += 1) {
      text.insert(text.length, 'b')
      doc.commit({ origin: 'actor:ana', message: `m${i}`, timestamp: t0 + 40_000_000 + i * 2_000 })
      index.refresh()
    }
    const elapsed = performance.now() - start
    expect(index.list().length).toBeGreaterThanOrEqual(before + 1_000)
    expect(elapsed).toBeLessThan(1_000)
  }, 60_000)
})

describe('history filters (AC-05.3)', () => {
  it('author counts sum to the unfiltered total', () => {
    const hub = SyncHub.create()
    const ana = human(hub, 'ana')
    const nova = writer(hub, 'nova')
    addParagraph(ana, 'Ana')
    addParagraph(nova, 'Nova')
    const history = listHistory(hub.doc)
    const counts = authorCounts(history)
    let sum = 0
    for (const n of counts.values()) sum += n
    expect(sum).toBe(history.length)
    const onlyAna = filterHistory(history, { actorId: 'ana' })
    expect(onlyAna.every((e) => e.author.actorId === 'ana')).toBe(true)
    expect(onlyAna.length).toBe(counts.get('ana'))
  })
})

describe('diffChange (AC-05.4)', () => {
  it('reports word-level parts for a changed block', () => {
    const hub = SyncHub.create()
    const ana = human(hub, 'ana')
    const p = addParagraph(ana, 'hello world')
    expectOk(ana.call('replace_text', { blockId: p, locator: { find: 'world' }, text: 'there' }))
    const entry = listHistory(hub.doc).find((e) => e.message.includes('replace_text'))
    expect(entry).toBeDefined()
    const hunks = diffChange(hub.doc, entry!)
    const change = hunks.find((h) => h.kind === 'change')
    expect(change?.parts.some((part) => part.type === 'remove' && part.text.includes('world'))).toBe(
      true
    )
    expect(change?.parts.some((part) => part.type === 'add' && part.text.includes('there'))).toBe(
      true
    )
  })

  it('diffWords keeps unchanged words', () => {
    const parts = diffWords('the cat sat', 'the dog sat')
    expect(parts.some((p) => p.type === 'same' && p.text.includes('the'))).toBe(true)
    expect(parts.some((p) => p.type === 'remove' && p.text.includes('cat'))).toBe(true)
    expect(parts.some((p) => p.type === 'add' && p.text.includes('dog'))).toBe(true)
  })

  it('diffBlocks marks added and removed ids', () => {
    const hunks = diffBlocks(
      [{ type: 'paragraph', text: 'keep', blockId: 'a' }],
      [
        { type: 'paragraph', text: 'keep', blockId: 'a' },
        { type: 'paragraph', text: 'new', blockId: 'b' }
      ]
    )
    expect(hunks.some((h) => h.kind === 'add' && h.blockId === 'b')).toBe(true)
  })
})

describe('checkpoints (AC-05.5)', () => {
  it('stores a named checkpoint that survives a snapshot round-trip', () => {
    const hub = SyncHub.create()
    const ana = human(hub, 'ana')
    addParagraph(ana, 'pinned')
    const marked = addCheckpoint(hub.doc, { name: 'Draft 1', actorId: 'ana' })
    expect(marked.name).toBe('Draft 1')
    const listed = listCheckpoints(hub.doc)
    expect(listed).toHaveLength(1)
    expect(listed[0].frontiers.length).toBeGreaterThan(0)
    const again = openDocument(hub.snapshot())
    expect(listCheckpoints(again)[0]?.name).toBe('Draft 1')
  })
})

describe('agent commit messages (AC-05.8)', () => {
  it('records replace_text as its own commit message', () => {
    const hub = SyncHub.create()
    const nova = writer(hub, 'nova')
    const p = addParagraph(nova, 'foo')
    expectOk(nova.call('replace_text', { blockId: p, locator: { find: 'foo' }, text: 'bar' }))
    const entry = listHistory(hub.doc).find((e) => e.message.includes('replace_text'))
    expect(entry?.message).toMatch(/replace_text in b_.*: "foo" → "bar"/)
    expect(entry?.author.role).toBe('agent')
  })
})
