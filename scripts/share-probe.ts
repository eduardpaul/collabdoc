/**
 * Real-network probe for sharing (08): the actual ShareHost / ShareGuest over
 * the actual HyperswarmTransport, in plain Node — no Electron, no renderer.
 *
 *   npx vite-node scripts/share-probe.ts host
 *   npx vite-node scripts/share-probe.ts guest <code-or-link> [--pings 20] [--gap 250]
 *   npx vite-node scripts/share-probe.ts loopback [--pings 20]
 *
 * Host: announces, prints the code/link, and answers every `ping:<n>` block
 * a guest writes with an `ack:<n>` block. Guest: joins, then writes pings
 * through the document and measures the round trip of each — the same path
 * a keystroke takes (Loro update → frame → UDX → Loro import) both ways, so
 * one-way edit latency ≈ RTT / 2, with no clock sync needed. `loopback` runs
 * both ends in one process through two separate swarms and the public DHT.
 */
import { SyncHub } from '../src/core/hub'
import { DocumentSession } from '../src/core/session'
import { allBlocks, blockAgentText } from '../src/core/tree'
import { DocumentAssets } from '../src/main/persist/assets'
import { ShareGuest } from '../src/main/share/guest'
import { ShareHost } from '../src/main/share/host'
import { HyperswarmTransport } from '../src/main/share/hyperswarm-transport'
import type { GuestProfile } from '../src/main/share/handshake'
import type { ActorProfile } from '../src/shared/types'

const args = process.argv.slice(2)
const mode = args[0] ?? 'help'
const flag = (name: string, fallback: number): number => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? Number(args[i + 1]) : fallback
}
const stamp = (): string => new Date().toISOString().slice(11, 23)
const log = (...parts: unknown[]): void => console.log(stamp(), ...parts)

function actor(id: string, name: string): ActorProfile {
  return { actorId: id, name, handle: name.toLowerCase(), color: '#2563eb', role: 'human' }
}

function guestProfile(id: string, name: string): GuestProfile {
  return { userId: id, name, handle: name.toLowerCase(), color: '#c45c26', installPublicKey: id }
}

function texts(hub: SyncHub): string[] {
  return allBlocks(hub.doc).map(({ node }) => blockAgentText(node))
}

async function runHost(): Promise<{ code: string; link: string; stop: () => Promise<void> }> {
  const hub = SyncHub.create({ title: 'Probe' })
  const session = new DocumentSession(hub, actor('host', 'Host'), { enforceClaims: false })
  session.call('insert_blocks', { blocks: [{ type: 'paragraph', text: 'probe document' }] })
  const t0 = performance.now()
  const host = new ShareHost({
    hub,
    transport: new HyperswarmTransport(),
    assets: new DocumentAssets(),
    docId: hub.doc.getMap('meta').get('docId') as string,
    title: 'Probe',
    hostName: 'Host',
    onEvent: (event) => {
      if (event.type === 'guest-joined') {
        log(`guest joined: ${event.guest.name} via ${event.guest.connection}`)
      } else if (event.type !== 'ready') {
        log('host event', JSON.stringify(event))
      }
    }
  })
  const started = await host.start()
  log(`announced on the DHT in ${Math.round(performance.now() - t0)} ms`)
  log(`code: ${started.code}`)
  log(`link: ${started.link}`)
  // Answer pings through the document.
  const acked = new Set<string>()
  hub.doc.subscribe(() => {
    for (const text of texts(hub)) {
      const m = /^ping:(\d+):/.exec(text)
      if (!m || acked.has(m[1])) continue
      acked.add(m[1])
      session.call('insert_blocks', { blocks: [{ type: 'paragraph', text: `ack:${m[1]}` }] })
    }
  })
  return { ...started, stop: () => host.stop() }
}

async function runGuest(target: string, pings: number, gapMs: number): Promise<void> {
  const t0 = performance.now()
  let tDial = 0
  const guest = new ShareGuest({
    transport: new HyperswarmTransport(),
    assets: new DocumentAssets(),
    profile: guestProfile('probe-guest', 'Probe'),
    onEvent: (event) => {
      if (event.type === 'status') {
        if (event.status === 'verifying') tDial = performance.now()
        log(`guest: ${event.status} (+${Math.round(performance.now() - t0)} ms)`)
      } else log('guest event', JSON.stringify(event))
    }
  })
  const joined = await guest.connect(target)
  const tJoined = performance.now()
  log(
    `joined "${joined.title}" in ${Math.round(tJoined - t0)} ms ` +
      `(find+connect ${Math.round(tDial - t0)} ms, handshake+snapshot ${Math.round(tJoined - tDial)} ms)`
  )
  const conn = (guest as unknown as { conn: { connectionType: string; remoteAddress?: string } })
    .conn
  log(`connection: ${conn.connectionType}${conn.remoteAddress ? ` to ${conn.remoteAddress}` : ''}`)

  const session = new DocumentSession(joined.hub, actor('probe-guest', 'Probe'), {
    enforceClaims: false
  })
  const sent = new Map<number, number>()
  const rtts: number[] = []
  const done = new Promise<void>((resolve) => {
    joined.hub.doc.subscribe(() => {
      for (const text of texts(joined.hub)) {
        const m = /^ack:(\d+)$/.exec(text)
        if (!m) continue
        const n = Number(m[1])
        const at = sent.get(n)
        if (at == null) continue
        sent.delete(n)
        rtts.push(performance.now() - at)
        if (rtts.length === pings) resolve()
      }
    })
  })
  for (let i = 0; i < pings; i += 1) {
    sent.set(i, performance.now())
    session.call('insert_blocks', {
      blocks: [{ type: 'paragraph', text: `ping:${i}:${Date.now()}` }]
    })
    await new Promise((r) => setTimeout(r, gapMs))
  }
  await Promise.race([done, new Promise((r) => setTimeout(r, 15_000))])
  const sorted = [...rtts].sort((a, b) => a - b)
  const pct = (p: number): string =>
    sorted.length
      ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))].toFixed(1)
      : '–'
  log(
    `edit round trip over ${rtts.length}/${pings} pings: ` +
      `p50 ${pct(0.5)} ms · p95 ${pct(0.95)} ms · max ${pct(1)} ms → one-way ≈ ${(Number(pct(0.5)) / 2).toFixed(1)} ms`
  )
  if (rtts.length < pings) log(`WARNING: ${pings - rtts.length} ping(s) never acknowledged`)
  await guest.disconnect()
}

async function main(): Promise<void> {
  if (mode === 'host') {
    const host = await runHost()
    log('waiting for guests — Ctrl+C to stop')
    process.on('SIGINT', () => {
      void host.stop().then(() => process.exit(0))
    })
    await new Promise(() => undefined)
  } else if (mode === 'guest') {
    if (!args[1]) throw new Error('guest needs a code or link')
    await runGuest(args[1], flag('pings', 20), flag('gap', 250))
    process.exit(0)
  } else if (mode === 'loopback') {
    const host = await runHost()
    await runGuest(host.link, flag('pings', 20), flag('gap', 250))
    await host.stop()
    process.exit(0)
  } else {
    console.log('usage: share-probe.ts host | guest <code|link> | loopback  [--pings N] [--gap ms]')
    process.exit(1)
  }
}

main().catch((error) => {
  log('FAILED', error instanceof Error ? error.message : error)
  process.exit(1)
})
