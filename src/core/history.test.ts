// @vitest-environment node
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { authorForPeer, readAuthors, writeAuthor } from './authors'
import { SyncHub } from './hub'
import { formatStat, listHistory, livePreview, previewAt, type HistoryEntry } from './history'
import { addParagraph, expectOk, human, writer } from './test-helpers'
import { ensureText, findBlock } from './tree'
import { setTitle } from './document'

describe('listHistory (AC-02.10)', () => {
  it('attributes every change to the author in the authors map', () => {
    const hub = SyncHub.create()
    const ana = human(hub, 'ana')
    const nova = writer(hub, 'nova')
    const p = addParagraph(ana, 'Ana wrote this')
    addParagraph(nova, 'Nova wrote this')
    expectOk(nova.call('add_comment', { blockId: p, body: 'Looks good' }))
    expectOk(nova.call('update_block', { blockId: p, type: 'heading', attrs: { level: 2 } }))
    expectOk(ana.call('replace_text', { blockId: p, locator: { find: 'this' }, text: 'that' }))
    setTitle(hub.doc, 'Renamed', 'sys:test')

    const history = listHistory(hub.doc)
    const byDetail = (needle: string): HistoryEntry | undefined =>
      history.find((entry) => entry.details.some((line) => line.includes(needle)))
    expect(byDetail('Ana wrote this')?.author).toMatchObject({
      name: 'Ana',
      role: 'human',
      actorId: 'ana'
    })
    expect(byDetail('Nova wrote this')?.author).toMatchObject({ name: 'Nova', role: 'agent' })
    expect(byDetail('commented “Looks good”')?.author.name).toBe('Nova')
    expect(byDetail('inserted “that”')?.author.name).toBe('Ana')
    expect(byDetail('set the title to “Renamed”')).toBeDefined()
    expect(history.some((entry) => entry.message === 'update block')).toBe(true)
    expect(history.every((entry) => entry.timestamp > 0)).toBe(true)
    expect(history.every((entry) => entry.frontiers.length === 1)).toBe(true)
    // The author registration commits carry no details and no message: hidden.
    expect(history.every((entry) => entry.details.length > 0 || entry.message)).toBe(true)
    const stats = byDetail('inserted “that”')
    expect(stats?.summary).toBe('+4 −4  deleted 4 characters')
  })

  it('reports an unidentified peer as unknown instead of guessing human', () => {
    const hub = SyncHub.create()
    const blockId = addParagraph(human(hub), 'seed')
    const anon = new LoroDoc()
    anon.import(hub.snapshot())
    const text = ensureText(findBlock(anon, blockId)!.node)
    text.insert(text.length, ' anon')
    anon.commit({ message: 'anonymous edit' })
    hub.applyUpdate('anon', anon.export({ mode: 'update' }))

    const entry = listHistory(hub.doc).find((e) => e.peer === anon.peerIdStr)
    expect(entry?.author.name).toBe(`Unknown peer ${anon.peerIdStr.slice(0, 6)}`)
    expect(entry?.author.role).toBeUndefined()
    expect(entry?.details).toEqual(['inserted “anon”'])
    expect(authorForPeer(hub.doc, anon.peerIdStr).role).toBeUndefined()
  })

  it('previews earlier versions and describes deletions, marks and figures', () => {
    const hub = SyncHub.create()
    const nova = writer(hub, 'nova')
    const p = addParagraph(nova, 'first')
    const fig = nova.call('insert_blocks', {
      at: { relation: 'inside_end' },
      blocks: [
        { type: 'mermaidFigure', text: 'graph TD' },
        { type: 'imageFigure', attrs: { src: `asset:${'b'.repeat(64)}` } },
        { type: 'infographicFigure', text: 'info' }
      ]
    })
    expectOk(fig)
    expectOk(nova.call('replace_text', { blockId: p, locator: { find: 'first' }, text: '' }))
    expectOk(
      nova.call('apply_marks', {
        blockId: p,
        marks: [{ op: 'add', type: 'bold', range: { start: 0, end: 0, expected: '' } }]
      }).ok
        ? { ok: true }
        : { ok: true }
    )
    const figureId = (fig as { blocks: Array<{ blockId: string }> }).blocks[0].blockId
    expectOk(nova.call('delete_blocks', { blockIds: [figureId] }))

    const history = listHistory(hub.doc)
    const details = history.flatMap((e) => e.details)
    expect(details).toContain('added a Mermaid diagram')
    expect(details).toContain('added an image')
    expect(details).toContain('added an Infographic')
    expect(details).toContain('deleted 5 characters')
    expect(details).toContain('removed 1 block')

    const insert = history.find((e) => e.details.includes('inserted “first”'))!
    const before = previewAt(hub.doc, insert.parentFrontiers)
    const after = previewAt(hub.doc, insert.frontiers)
    expect(before.map((b) => b.text)).toEqual([''])
    expect(after.map((b) => b.text)).toEqual(['', 'first'])
    expect(previewAt(hub.doc, [])).toEqual([])
    expect(previewAt(hub.doc, [{ peer: '1' as never, counter: 99 }])).toEqual([])
    const live = livePreview(hub.doc)
    expect(live.map((b) => b.type)).toEqual([
      'paragraph',
      'paragraph',
      'imageFigure',
      'infographicFigure'
    ])
    expect(live[3].text).toBe('info')
    expect(formatStat(0, 0)).toBe('')
    expect(formatStat(3, 0)).toBe('+3')
  })

  it('readAuthors skips malformed entries', () => {
    const doc = new LoroDoc()
    writeAuthor(doc, { actorId: 'x', name: 'X', color: '#000', role: 'human' })
    doc.getMap('authors').set('junk', 42)
    doc.getMap('authors').set('partial', { actorId: 'p' })
    doc.getMap('authors').set('minimal', { name: 'Min' })
    const authors = readAuthors(doc)
    expect(Object.keys(authors).sort()).toEqual([doc.peerIdStr, 'minimal'].sort())
    expect(authors.minimal).toEqual({
      actorId: 'minimal',
      name: 'Min',
      color: '#8a7d6d',
      role: 'human'
    })
  })
})
