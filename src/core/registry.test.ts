// @vitest-environment node
import { LoroDoc } from 'loro-crdt'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { decodeDocFrame, encodeDocFrame } from '../shared/protocol'
import { openDocument, readMeta } from './document'
import { SyncHub } from './hub'
import { bindLink, type FrameLink } from './link'
import { DocumentRegistry } from './registry'
import { addParagraph, human, textOf, writer } from './test-helpers'
import { memoryLinkPair } from './test-links'
import { allBlocks, blockPlainText, ensureText, findBlock } from './tree'

/** A client-side LoroDoc driven over a frame link, the way the renderer does it. */
function frameClient(link: FrameLink): {
  doc: LoroDoc
  frames: string[]
  type: (id: string, t: string) => void
} {
  const doc = new LoroDoc()
  const frames: string[] = []
  link.onMessage((data) => {
    const frame = decodeDocFrame(data)
    if (frame.kind === 'ephemeral') return
    frames.push(frame.kind)
    doc.import(frame.bytes)
  })
  doc.subscribeLocalUpdates((bytes) => link.send(encodeDocFrame('update', bytes)))
  return {
    doc,
    frames,
    type: (id, text) => {
      const node = findBlock(doc, id)!.node
      const loroText = ensureText(node)
      loroText.insert(loroText.length, text)
      doc.commit()
    }
  }
}

const registries: DocumentRegistry[] = []
function registry(
  options: ConstructorParameters<typeof DocumentRegistry>[0] = {}
): DocumentRegistry {
  const created = new DocumentRegistry({ closeDelayMs: 0, warn: () => {}, ...options })
  registries.push(created)
  return created
}

afterEach(() => {
  for (const item of registries.splice(0)) item.closeAll()
  vi.useRealTimers()
})

describe('bindLink', () => {
  it('sends a snapshot on attach, then relays updates both ways', () => {
    const hub = SyncHub.create({ title: 'Linked' })
    const ana = human(hub)
    const blockId = addParagraph(ana, 'hello')
    const [hubEnd, clientEnd] = memoryLinkPair()
    const client = frameClient(clientEnd)
    bindLink(hub, 'client', hubEnd, { warn: () => {} })

    expect(client.frames).toEqual(['snapshot'])
    expect(readMeta(client.doc).title).toBe('Linked')
    expect(blockPlainText(findBlock(client.doc, blockId)!.node)).toBe('hello')

    client.type(blockId, ' from client')
    expect(textOf(ana, blockId)).toBe('hello from client')

    ana.call('insert_text', { blockId, text: ' and back' })
    expect(client.frames.at(-1)).toBe('update')
    expect(blockPlainText(findBlock(client.doc, blockId)!.node)).toBe('hello from client and back')
  })

  it('drops malformed and unimportable frames with a warning and keeps working (AC-03.8)', () => {
    const hub = SyncHub.create()
    const ana = human(hub)
    const blockId = addParagraph(ana, 'safe')
    const warnings: string[] = []
    const [hubEnd, clientEnd] = memoryLinkPair()
    const client = frameClient(clientEnd)
    bindLink(hub, 'fuzz', hubEnd, { warn: (message) => warnings.push(message) })
    const before = hub.doc.version().toJSON()

    let seed = 7
    const random = (): number => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0
      return seed / 0x1_0000_0000
    }
    const junk: unknown[] = [
      new Uint8Array(),
      new Uint8Array([7]),
      new Uint8Array([1]),
      new Uint8Array([0, 1, 2, 3]),
      new Uint8Array([1, 255, 255, 255, 255]),
      'not bytes',
      { kind: 'update', bytes: [1, 2] },
      null,
      42
    ]
    for (let i = 0; i < 200; i += 1) {
      const length = 1 + Math.floor(random() * 64)
      const bytes = new Uint8Array(length)
      for (let j = 0; j < length; j += 1) bytes[j] = Math.floor(random() * 256)
      bytes[0] = Math.floor(random() * 4)
      junk.push(bytes)
    }
    const snapshot = hub.snapshot()
    junk.push(encodeDocFrame('update', snapshot.subarray(0, Math.floor(snapshot.length / 2))))

    for (const item of junk) {
      expect(() => clientEnd.send(item as Uint8Array)).not.toThrow()
    }
    expect(warnings.length).toBeGreaterThan(0)
    expect(hub.doc.version().toJSON()).toEqual(before)
    expect(textOf(ana, blockId)).toBe('safe')

    client.type(blockId, ' still')
    expect(textOf(ana, blockId)).toBe('safe still')
  })

  it('stops relaying once the link closes', () => {
    const hub = SyncHub.create()
    const ana = human(hub)
    const blockId = addParagraph(ana, 'x')
    const [hubEnd, clientEnd] = memoryLinkPair()
    const client = frameClient(clientEnd)
    let closed = false
    const unbind = bindLink(hub, 'c', hubEnd, { onClose: () => (closed = true), warn: () => {} })
    unbind()
    expect(closed).toBe(true)
    ana.call('insert_text', { blockId, text: 'y' })
    expect(blockPlainText(findBlock(client.doc, blockId)!.node)).toBe('x')
  })
})

describe('DocumentRegistry', () => {
  it('creates one hub per document and disposes it when the last subscriber leaves (AC-03.1, AC-03.5)', () => {
    vi.useFakeTimers()
    const disposed: string[] = []
    const reg = registry({ closeDelayMs: 50, onDispose: (id) => disposed.push(id) })
    const entry = reg.create({ title: 'One' })
    expect(reg.list()).toEqual([entry.docId])
    expect(reg.debug()[0]).toMatchObject({ docId: entry.docId, title: 'One', subscribers: [] })

    const [hubEnd, clientEnd] = memoryLinkPair()
    frameClient(clientEnd)
    const detach = reg.attach(entry.docId, 'renderer', hubEnd)
    expect(reg.debug()[0].subscribers).toEqual(['renderer'])
    expect(() => reg.attach(entry.docId, 'renderer', memoryLinkPair()[0])).toThrow(
      /already attached/
    )

    detach()
    expect(reg.has(entry.docId)).toBe(true)
    vi.advanceTimersByTime(49)
    expect(reg.has(entry.docId)).toBe(true)
    vi.advanceTimersByTime(1)
    expect(reg.has(entry.docId)).toBe(false)
    expect(disposed).toEqual([entry.docId])
    expect(() => reg.attach(entry.docId, 'late', memoryLinkPair()[0])).toThrow(/not open/)
  })

  it('a re-attach inside the grace period keeps unsaved edits (AC-03.7)', () => {
    vi.useFakeTimers()
    const reg = registry({ closeDelayMs: 1000 })
    const { docId } = reg.create({ title: 'Reload me' })

    const [hubEnd, clientEnd] = memoryLinkPair()
    const first = frameClient(clientEnd)
    reg.attach(docId, 'renderer', hubEnd)
    const id = readIdOf(first.doc)
    first.type(id, 'typed before reload')
    hubEnd.close()
    vi.advanceTimersByTime(500)

    const [hubEnd2, clientEnd2] = memoryLinkPair()
    const second = frameClient(clientEnd2)
    reg.attach(docId, 'renderer', hubEnd2)
    expect(second.frames).toEqual(['snapshot'])
    expect(blockPlainText(findBlock(second.doc, id)!.node)).toBe('typed before reload')
    vi.advanceTimersByTime(5000)
    expect(reg.has(docId)).toBe(true)
  })

  it("two documents never see each other's frames (AC-03.6)", () => {
    const reg = registry({ closeDelayMs: Infinity })
    const a = reg.create({ title: 'A' })
    const b = reg.create({ title: 'B' })
    const [aHub, aClient] = memoryLinkPair()
    const [bHub, bClient] = memoryLinkPair()
    const ca = frameClient(aClient)
    const cb = frameClient(bClient)
    reg.attach(a.docId, 'win-a', aHub)
    reg.attach(b.docId, 'win-b', bHub)
    ca.type(readIdOf(ca.doc), 'only in A')
    cb.type(readIdOf(cb.doc), 'only in B')
    expect(ca.frames).toEqual(['snapshot'])
    expect(cb.frames).toEqual(['snapshot'])
    expect(reg.debug().map((d) => d.text)).toEqual(['only in A', 'only in B'])
    expect(readMeta(ca.doc).docId).toBe(a.docId)
    expect(readMeta(cb.doc).docId).toBe(b.docId)
  })

  it('adopts an existing hub and refuses duplicates', () => {
    const reg = registry({ closeDelayMs: Infinity })
    const hub = SyncHub.fromSnapshot(SyncHub.create({ docId: 'fixed', title: 'T' }).snapshot())
    reg.register(hub)
    expect(reg.get('fixed')?.hub).toBe(hub)
    expect(() => reg.register(SyncHub.create({ docId: 'fixed' }))).toThrow(/already open/)
    expect(() =>
      reg.register(new SyncHub(openDocument(new LoroDoc().export({ mode: 'snapshot' }))))
    ).toThrow(/docId/)
    expect(reg.close('fixed')).toBe(true)
    expect(reg.close('fixed')).toBe(false)
  })

  it('agents count as subscribers without a link', () => {
    vi.useFakeTimers()
    const reg = registry({ closeDelayMs: 10 })
    const entry = reg.create()
    reg.hold(entry, 'agent:nova')
    const nova = writer(entry.hub, 'nova')
    addParagraph(nova, 'agent text')
    vi.advanceTimersByTime(100)
    expect(reg.has(entry.docId)).toBe(true)
    reg.release(entry, 'agent:nova')
    reg.release(entry, 'agent:nova')
    vi.advanceTimersByTime(100)
    expect(reg.has(entry.docId)).toBe(false)
  })

  it('returns main-process heap to within 10 % after three open/close cycles (AC-03.5)', () => {
    const gc = (globalThis as { gc?: () => void }).gc
    if (!gc) {
      console.warn('AC-03.5 memory check skipped: run vitest with --expose-gc')
      return
    }
    const reg = registry({ closeDelayMs: 0 })
    const cycle = (): void => {
      const entry = reg.create({ title: 'Cycle' })
      const [hubEnd, clientEnd] = memoryLinkPair()
      const client = frameClient(clientEnd)
      const detach = reg.attach(entry.docId, 'renderer', hubEnd)
      const id = readIdOf(client.doc)
      for (let i = 0; i < 200; i += 1) client.type(id, `line ${i} of some text. `)
      detach()
      reg.close(entry.docId)
    }
    cycle()
    gc()
    const baseline = process.memoryUsage().heapUsed
    for (let i = 0; i < 3; i += 1) cycle()
    gc()
    const after = process.memoryUsage().heapUsed
    expect(after).toBeLessThan(baseline * 1.1)
  })
})

function readIdOf(doc: LoroDoc): string {
  const first = allBlocks(doc)[0]
  const attrs = first.node.get('attributes') as { get(key: string): unknown }
  return String(attrs.get('blockId'))
}
