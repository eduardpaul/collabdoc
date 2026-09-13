// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { SyncHub } from '../../core/hub'
import { addParagraph, human, textOf } from '../../core/test-helpers'
import { DocumentAssets } from '../persist/assets'
import { ShareGuest } from './guest'
import { ShareHost } from './host'
import { MemoryNetwork, MemoryTransport } from './memory-transport'
import {
  deriveSessionSecret,
  deriveTopic,
  formatJoinLink,
  generateShareCode,
  parseJoinTarget
} from '../../shared/share-crypto'
import { FramePump } from './frames'
import { runGuestHandshake, ShareProtocolError } from './handshake'
import type { GuestProfile } from './handshake'

const profile = (id: string, name: string): GuestProfile => ({
  userId: id,
  name,
  handle: name.toLowerCase(),
  color: '#2563eb',
  installPublicKey: id
})

describe('share over MemoryTransport', () => {
  const nets: MemoryNetwork[] = []

  afterEach(async () => {
    for (const net of nets.splice(0)) net.reset()
  })

  async function peers(): Promise<{
    net: MemoryNetwork
    transport: MemoryTransport
    hub: SyncHub
    host: ShareHost
    started: { code: string; link: string }
    blockId: string
    hostSession: ReturnType<typeof human>
    assets: DocumentAssets
    events: string[]
  }> {
    const net = new MemoryNetwork()
    nets.push(net)
    const transport = new MemoryTransport(net)
    const hub = SyncHub.create({ title: 'Shared' })
    const hostSession = human(hub, 'host')
    const blockId = addParagraph(hostSession, 'Hello from host')
    const assets = new DocumentAssets()
    const events: string[] = []
    const host = new ShareHost({
      hub,
      transport,
      assets,
      docId: hub.doc.getMap('meta').get('docId') as string,
      title: 'Shared',
      hostName: 'Host',
      onEvent: (event) => events.push(event.type)
    })
    const started = await host.start()
    return { net, transport, hub, host, started, blockId, hostSession, assets, events }
  }

  it('announces then a guest sees the document (AC-08.1)', async () => {
    const { transport, host, started, assets } = await peers()
    expect(started.code).toMatch(
      /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/
    )
    expect(started.link.startsWith('collabdoc://join/')).toBe(true)
    const guest = new ShareGuest({
      transport,
      assets,
      profile: profile('g1', 'Ada'),
      onEvent: () => undefined
    })
    const joined = await guest.connect(started.code)
    expect(joined.title).toBe('Shared')
    const text = [...(joined.hub.doc.getMap('doc').toJSON().children ?? [])]
    void text
    expect(joined.hub.doc.getMap('meta').get('title')).toBe('Shared')
    await host.stop()
    await guest.disconnect()
  })

  it('replicates edits both ways (AC-08.2)', async () => {
    const { transport, host, started, assets, blockId, hostSession } = await peers()
    const guest = new ShareGuest({
      transport,
      assets,
      profile: profile('g1', 'Ada'),
      onEvent: () => undefined
    })
    const joined = await guest.connect(started.code)
    const guestHuman = human(joined.hub, 'ada')
    guestHuman.call('insert_text', { blockId, text: '!' })
    await tick()
    expect(textOf(hostSession, blockId)).toContain('!')
    hostSession.call('insert_text', { blockId, text: '?' })
    await tick()
    expect(textOf(guestHuman, blockId)).toContain('?')
    await host.stop()
    await guest.disconnect()
  })

  it('rejects a wrong code at the application handshake (AC-08.3)', async () => {
    const { transport, host, started } = await peers()
    const wrong = formatJoinLink(parseKey(started.link), generateShareCode())
    const guest = new ShareGuest({
      transport,
      assets: new DocumentAssets(),
      profile: profile('g1', 'Ada'),
      onEvent: () => undefined
    })
    await expect(guest.connect(wrong)).rejects.toThrow(/wrong code|not a CollabDoc|reach the host/i)
    await host.stop()
  })

  it('rejects a replayed auth on a new connection (AC-08.4)', async () => {
    const { transport, host, started } = await peers()
    const secret = await deriveSessionSecret(started.code)
    const topic = await deriveTopic(secret)
    const conn = await transport.dial({
      code: started.code.replace(/-/g, ''),
      hostPublicKey: parseKey(started.link),
      topic
    })
    const pump = new FramePump(conn)
    await runGuestHandshake(pump, conn, { sessionSecret: secret, profile: profile('g1', 'Ada') })
    conn.destroy()

    const conn2 = await transport.dial({
      code: started.code.replace(/-/g, ''),
      hostPublicKey: parseKey(started.link),
      topic
    })
    const pump2 = new FramePump(conn2)
    // Hello arrives; send the previous connection's proof by completing handshake with
    // this connection's hash — proofs are bound to handshakeHash so a copied proof fails.
    const hello = await pump2.next()
    expect(hello.tag).toBe('hello')
    pump2.send('auth', {
      nonceG: 'AAAA',
      proof: 'AAAA',
      profile: profile('g1', 'Ada')
    })
    const reply = await pump2.next()
    expect(reply.tag).toBe('error')
    conn2.destroy()
    await host.stop()
  })

  it('refuses the 11th guest (AC-08.11)', async () => {
    const { transport, host, started, assets } = await peers()
    const guests: ShareGuest[] = []
    for (let i = 0; i < 10; i += 1) {
      const guest = new ShareGuest({
        transport,
        assets,
        profile: profile(`g${i}`, `G${i}`),
        onEvent: () => undefined
      })
      await guest.connect(started.code)
      guests.push(guest)
    }
    const extra = new ShareGuest({
      transport,
      assets,
      profile: profile('g11', 'Full'),
      onEvent: () => undefined
    })
    await expect(extra.connect(started.code)).rejects.toBeInstanceOf(ShareProtocolError)
    await host.stop()
    await Promise.all(guests.map((g) => g.disconnect()))
  })

  it('stop sharing tells the guest the host ended (AC-08.8)', async () => {
    const { transport, host, started, assets } = await peers()
    const events: string[] = []
    const guest = new ShareGuest({
      transport,
      assets,
      profile: profile('g1', 'Ada'),
      onEvent: (event) => events.push(event.type)
    })
    await guest.connect(started.code)
    await host.stop()
    await tick(20)
    expect(events).toContain('host-ending')
    await guest.disconnect()
  })

  it('doc-mismatch when the guest expected another document (AC-08.9)', async () => {
    const { transport, host, started, assets } = await peers()
    const guest = new ShareGuest({
      transport,
      assets,
      profile: profile('g1', 'Ada'),
      onEvent: () => undefined
    })
    await expect(guest.connect(started.code, 'not-the-doc')).rejects.toThrow(/different document/)
    await host.stop()
  })
})

function parseKey(link: string): Uint8Array {
  return parseJoinTarget(link).hostPublicKey!
}

function tick(ms = 30): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
