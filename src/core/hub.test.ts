// @vitest-environment node
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { readMeta } from './document'
import { SyncHub } from './hub'
import { addParagraph, human, textOf, writer } from './test-helpers'
import { ensureText, findBlock, blockPlainText } from './tree'

describe('SyncHub', () => {
  it('creates an empty titled document and restores from a snapshot', () => {
    const hub = SyncHub.create({ title: 'Plan' })
    expect(readMeta(hub.doc).title).toBe('Plan')
    const again = SyncHub.fromSnapshot(hub.snapshot())
    expect(readMeta(again.doc)).toEqual(readMeta(hub.doc))
  })

  it('fans an update out to every listener except its source', () => {
    const hub = SyncHub.create()
    const seen: string[] = []
    hub.subscribe('a', (event) => seen.push(`a:${event.type}`))
    hub.subscribe('b', (event) => seen.push(`b:${event.type}`))
    const client = new LoroDoc()
    client.import(hub.snapshot())
    client.getMap('meta').set('title', 'x')
    client.commit()
    hub.applyUpdate('a', client.export({ mode: 'update' }))
    expect(seen).toEqual(['b:update'])
    hub.applyEphemeral('b', hub.ephemeralSnapshot())
    expect(seen).toEqual(['b:update', 'a:ephemeral'])
  })

  it('replays edits made while a client was disconnected (version-vector resume)', () => {
    const hub = SyncHub.create()
    const ana = human(hub)
    const blockId = addParagraph(ana, 'Hello')

    const client = new LoroDoc()
    client.import(hub.snapshot())
    const type = (text: string): void => {
      const node = findBlock(client, blockId)!.node
      const loroText = ensureText(node)
      loroText.insert(loroText.length, text)
      client.commit()
    }

    type(' online.')
    hub.applyUpdate('client', client.export({ mode: 'update' }))
    expect(textOf(ana, blockId)).toBe('Hello online.')

    const atDisconnect = client.version()
    type(' offline one.')
    type(' offline two.')
    expect(textOf(ana, blockId)).toBe('Hello online.')

    hub.applyUpdate('client', client.export({ mode: 'update', from: atDisconnect }))
    expect(textOf(ana, blockId)).toBe('Hello online. offline one. offline two.')
    expect(blockPlainText(findBlock(hub.doc, blockId)!.node)).toBe(textOf(ana, blockId))
  })

  it('stops notifying a disposed hub and drops a disposed session', () => {
    const hub = SyncHub.create()
    const a = writer(hub, 'nova')
    const b = writer(hub, 'rex')
    const blockId = addParagraph(a, 'shared')
    a.dispose()
    expect(a.call('insert_text', { blockId, text: 'x' })).toMatchObject({
      ok: false,
      error: 'forbidden'
    })
    b.call('insert_text', { blockId, text: '!' })
    expect(textOf(b, blockId)).toBe('shared!')
    expect(blockPlainText(findBlock(a.doc, blockId)!.node)).toBe('shared')
    hub.dispose()
    expect(() => b.call('insert_text', { blockId, text: '?' })).not.toThrow()
  })
})
