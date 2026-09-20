// @vitest-environment node
/**
 * Two people on one shared document, each with their own agents (17 × 08).
 * The host and the guest each run their own main process pieces here —
 * registry, MCP server, runtime — joined by the in-memory share transport.
 * A guest's agent edits the guest's replica; the edit reaches the host as an
 * attributed commit; the host has no handle on that run.
 */
import { mkdtemp, rm, symlink } from 'fs/promises'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { readAuthors } from '../../core/authors'
import { listHistory } from '../../core/history'
import { DocumentRegistry } from '../../core/registry'
import { addParagraph, human } from '../../core/test-helpers'
import { allBlocks, blockPlainText } from '../../core/tree'
import type { RunPersona, RunRecord, RunRequest } from '../../shared/agents'
import { DocumentAssets } from '../persist/assets'
import { DocumentMcpServer } from '../mcp/DocumentMcpServer'
import { ShareGuest } from '../share/guest'
import { ShareHost } from '../share/host'
import { MemoryNetwork, MemoryTransport } from '../share/memory-transport'
import { AgentRuntime } from './AgentRuntime'
import { SecretStore, plainCipher } from './secrets'
import { McpSourceStore } from './sources'

const FAKE = resolve(__dirname, '../../../resources/test/fake-cli.js')

type Peer = {
  registry: DocumentRegistry
  mcp: DocumentMcpServer
  runtime: AgentRuntime
  userData: string
}

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
  delete process.env.FAKE_CLI_MODE
})

/** One person's main process: their own registry, MCP server and runtime, with the stub as `claude`. */
async function peer(name: string, registry: DocumentRegistry): Promise<Peer> {
  const userData = await mkdtemp(join(tmpdir(), `collabdoc-${name}-`))
  const bin = await mkdtemp(join(tmpdir(), `collabdoc-${name}-bin-`))
  await symlink(FAKE, join(bin, 'claude'))
  const mcp = new DocumentMcpServer({ registry, userData })
  await mcp.init()
  const secrets = new SecretStore(userData, plainCipher)
  const sources = new McpSourceStore({ userData, secrets })
  await sources.load()
  const runtime = new AgentRuntime({
    registry,
    mcp,
    sources,
    userData,
    onEvent: () => undefined,
    backendOptions: {
      resolveBinary: async (binary) => (binary === 'claude' ? join(bin, 'claude') : null),
      killGraceMs: 300
    }
  })
  await runtime.init()
  cleanups.push(async () => {
    await runtime.dispose()
    await mcp.stop()
    registry.closeAll()
    await rm(userData, { recursive: true, force: true })
    await rm(bin, { recursive: true, force: true })
  })
  return { registry, mcp, runtime, userData }
}

const architectAgent: RunPersona = {
  id: 'agent_ada_architect',
  name: 'Architect',
  handle: 'architect',
  role: 'writer',
  color: '#7c3aed',
  instructions: 'C4 diagrams, Azure costs.',
  skills: ['c4']
}

function request(docId: string, persona: RunPersona): RunRequest {
  return {
    docId,
    docTitle: 'Shared',
    kind: 'ask',
    persona,
    backendId: 'claude-code',
    prompt: 'Add the architecture section.',
    sourceIds: []
  }
}

async function untilDone(runtime: AgentRuntime, runId: string): Promise<RunRecord> {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const record = runtime.getRun(runId)
    if (record && record.endedAt !== null) return record
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error('run did not finish')
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 150))

describe('each participant runs their own agents on a shared document', () => {
  it("a guest's agent edits through the guest's own runtime; the host sees an attributed commit and cannot touch the run", async () => {
    process.env.FAKE_CLI_MODE = 'mcp'
    // Host: PM's machine.
    const net = new MemoryNetwork()
    cleanups.push(async () => net.reset())
    const hostRegistry = new DocumentRegistry({ closeDelayMs: Number.POSITIVE_INFINITY })
    const entry = hostRegistry.create({ title: 'Shared' })
    const pm = human(entry.hub, 'pm')
    addParagraph(pm, 'Scope: build the thing.')
    const assets = new DocumentAssets()
    const shareHost = new ShareHost({
      hub: entry.hub,
      transport: new MemoryTransport(net),
      assets,
      docId: entry.docId,
      title: 'Shared',
      hostName: 'PM',
      onEvent: () => undefined
    })
    const started = await shareHost.start()
    cleanups.push(() => shareHost.stop())
    const host = await peer('host', hostRegistry)

    // Guest: the architect's machine joins and registers its replica in its own registry.
    const guestRegistry = new DocumentRegistry({ closeDelayMs: Number.POSITIVE_INFINITY })
    const shareGuest = new ShareGuest({
      transport: new MemoryTransport(net),
      assets: new DocumentAssets(),
      profile: {
        userId: 'ada',
        name: 'Ada',
        handle: 'ada',
        color: '#1f8a70',
        installPublicKey: 'k'.repeat(64)
      },
      onEvent: () => undefined
    })
    const joined = await shareGuest.connect(started.code)
    cleanups.push(() => shareGuest.disconnect())
    guestRegistry.register(joined.hub)
    const guest = await peer('guest', guestRegistry)

    // Ada asks *her* Architect. The run exists only in her runtime.
    const queued = guest.runtime.run(request(entry.docId, architectAgent))
    const record = await untilDone(guest.runtime, queued.runId)
    expect(record.status).toBe('done')
    expect(record.writes).toBe(1)
    await tick()

    // The PM's document has the Architect's commit, attributed to the Architect — not to Ada, not to the PM's agents.
    const hostTexts = allBlocks(entry.hub.doc).map(({ node }) => blockPlainText(node))
    expect(hostTexts.some((t) => t.startsWith('Drafted intro for:'))).toBe(true)
    const last = listHistory(entry.hub.doc).at(-1)!
    expect(last.author).toMatchObject({
      actorId: 'agent_ada_architect',
      name: 'Architect',
      color: '#7c3aed'
    })
    const authors = Object.values(readAuthors(entry.hub.doc))
    expect(authors.find((a) => a.actorId === 'agent_ada_architect')).toMatchObject({
      role: 'agent',
      handle: 'architect'
    })

    // The host has no run, no session and no lever for it.
    expect(host.runtime.listRuns(entry.docId)).toEqual([])
    expect(host.runtime.cancel(queued.runId)).toBe(false)
    expect(host.mcp.sessionsForRun(queued.runId)).toBe(0)
    expect(host.mcp.state().connected).toEqual([])
    // Registering a run under the guest's agent id on the host would be the host's *own* run: a
    // different process, a different MCP server, a different token — nothing the guest's CLI can reach.
    expect(guest.mcp.token).not.toBe(host.mcp.token)

    // And the other way round: the PM's Writer runs on the PM's machine and lands on Ada's replica.
    const pmWriter: RunPersona = { ...architectAgent, id: 'agent_pm_writer', name: 'Writer', handle: 'writer', color: '#2563eb' }
    const hostRun = await untilDone(host.runtime, host.runtime.run(request(entry.docId, pmWriter)).runId)
    expect(hostRun.status).toBe('done')
    await tick()
    const guestLast = listHistory(joined.hub.doc).at(-1)!
    expect(guestLast.author).toMatchObject({ actorId: 'agent_pm_writer', name: 'Writer' })
    expect(guest.runtime.listRuns(entry.docId).map((r) => r.agentId)).toEqual(['agent_ada_architect'])
  })
})
