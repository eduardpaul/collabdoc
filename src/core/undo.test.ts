// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { addCheckpoint, listCheckpoints } from './checkpoints'
import { createDocument } from './document'
import { listHistory } from './history'
import { SyncHub } from './hub'
import { addParagraph, expectOk, human, textOf, writer } from './test-helpers'
import { findBlock, firstText } from './tree'
import { applyUndo, createUndoManager } from './undo'

describe('per-actor undo (06)', () => {
  it('undo removes only this actor’s characters; a peer’s text typed inside stays contiguous (AC-06.3)', () => {
    const hub = SyncHub.create()
    const ana = human(hub, 'ana')
    const nova = writer(hub, 'nova')
    const p = addParagraph(ana, 'start ')
    expectOk(ana.call('insert_text', { blockId: p, text: 'hello world' }))
    expect(textOf(ana, p)).toBe('start hello world')
    // Nova types inside the span Ana is about to undo.
    expectOk(nova.call('insert_text', { blockId: p, text: 'XYZ', at: { after: 'hello' } }))
    expect(textOf(ana, p)).toBe('start helloXYZ world')
    const undone = ana.call('undo', {})
    expect(undone).toMatchObject({ ok: true, applied: 'undo' })
    expect(textOf(ana, p)).toBe('start XYZ')
    expect(textOf(nova, p)).toBe('start XYZ')
    expectOk(ana.call('redo', {}))
    expect(textOf(ana, p)).toBe('start helloXYZ world')
  })

  it('agent undo returns the affected blocks and reports nothing-to-undo as ok (AC-06.6)', () => {
    const hub = SyncHub.create()
    const nova = writer(hub, 'nova')
    const p = addParagraph(nova, 'draft')
    expectOk(nova.call('replace_text', { blockId: p, locator: { find: 'draft' }, text: 'final' }))
    const undone = nova.call('undo', {})
    expect(undone).toMatchObject({ ok: true, applied: 'undo', undo: { canRedo: true } })
    expect((undone as { blocks: { blockId: string; text: string }[] }).blocks).toMatchObject([
      { blockId: p, text: 'draft' }
    ])
    expectOk(nova.call('undo', {}))
    expect(nova.call('undo', {})).toMatchObject({
      ok: true,
      applied: 'nothing to undo',
      blocks: [],
      undo: { canUndo: false, canRedo: true }
    })
    expectOk(nova.call('redo', {}))
    expectOk(nova.call('redo', {}))
    expect(nova.call('redo', {})).toMatchObject({ ok: true, applied: 'nothing to redo' })
    expect(textOf(nova, p)).toBe('final')
  })

  it('an undo is its own history entry by the actor, not a shrink of the typing entry (AC-06.2)', () => {
    const hub = SyncHub.create()
    const ana = human(hub, 'ana')
    const p = addParagraph(ana, 'typed')
    const before = listHistory(hub.doc).length
    expectOk(ana.call('undo', {}))
    const history = listHistory(hub.doc)
    expect(history).toHaveLength(before + 1)
    const last = history[history.length - 1]
    expect(last.message).toBe('undo')
    expect(last.author.actorId).toBe('ana')
    expect(findBlock(hub.doc, p)).toBeNull()
  })

  it('checkpoints are skipped by undo (AC-06.7)', () => {
    const doc = createDocument()
    const manager = createUndoManager(doc, { mergeInterval: 0 })
    const text = firstText(findBlock(doc, blockAt(doc, 0))!.node)!
    text.insert(0, 'typed')
    doc.commit({ origin: 'actor:ana' })
    addCheckpoint(doc, { name: 'Draft 1', actorId: 'ana' })
    expect(applyUndo(doc, manager, 'undo').applied).toBe(true)
    expect(text.toString()).toBe('')
    expect(listCheckpoints(doc).map((cp) => cp.name)).toEqual(['Draft 1'])
    expect(manager.canUndo()).toBe(false)
  })

  it('the undo stack holds at most 200 steps and memory stays bounded over 10 000 edits (AC-06.8)', () => {
    const doc = createDocument()
    const manager = createUndoManager(doc, { mergeInterval: 0 })
    const text = firstText(findBlock(doc, blockAt(doc, 0))!.node)!
    const gc = (globalThis as { gc?: () => void }).gc
    const heapBefore = (): number => {
      gc?.()
      return process.memoryUsage().heapUsed
    }
    const baseline = heapBefore()
    for (let i = 0; i < 10_000; i += 1) {
      text.insert(text.length, 'x')
      doc.commit({ origin: 'actor:ana' })
    }
    let steps = 0
    while (applyUndo(doc, manager, 'undo').applied) steps += 1
    expect(steps).toBe(200)
    expect(text).toHaveLength(9_800)
    if (gc) {
      // The JS side of the stack is a few hundred small records; well under 20 MB.
      expect(heapBefore() - baseline).toBeLessThan(20 * 1024 * 1024)
    }
  }, 60_000)
})

function blockAt(doc: ReturnType<typeof createDocument>, index: number): string {
  const blocks = listHistory(doc)[0]?.blockIds
  if (blocks?.[index]) return blocks[index]
  throw new Error('no block')
}
