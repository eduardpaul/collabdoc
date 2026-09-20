// @vitest-environment node
import { mkdtemp, rm, symlink } from 'fs/promises'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { listHistory } from '../../core/history'
import { DocumentRegistry } from '../../core/registry'
import { addParagraph, human, textOf } from '../../core/test-helpers'
import { allBlocks, blockPlainText } from '../../core/tree'
import type { RunEvent, RunPersona, RunRecord, RunRequest } from '../../shared/agents'
import { DocumentMcpServer } from '../mcp/DocumentMcpServer'
import { AgentRuntime } from './AgentRuntime'
import { SecretStore, plainCipher } from './secrets'
import { McpSourceStore } from './sources'

const FAKE = resolve(__dirname, '../../../resources/test/fake-cli.js')

type Harness = {
  runtime: AgentRuntime
  mcp: DocumentMcpServer
  registry: DocumentRegistry
  docId: string
  blockId: string
  events: RunEvent[]
  userData: string
}

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
  delete process.env.FAKE_CLI_MODE
})

async function harness(
  options: { maxParallel?: number; maxQueue?: number } = {}
): Promise<Harness> {
  const userData = await mkdtemp(join(tmpdir(), 'collabdoc-runtime-'))
  const bin = await mkdtemp(join(tmpdir(), 'collabdoc-bin-'))
  await symlink(FAKE, join(bin, 'claude'))
  const registry = new DocumentRegistry({ closeDelayMs: Number.POSITIVE_INFINITY })
  const entry = registry.create({ title: 'Tides' })
  const blockId = addParagraph(human(entry.hub, 'ana'), 'The quick brown fox jumps.')
  const mcp = new DocumentMcpServer({ registry, userData })
  await mcp.init()
  const secrets = new SecretStore(userData, plainCipher)
  const sources = new McpSourceStore({ userData, secrets })
  await sources.load()
  const events: RunEvent[] = []
  const runtime = new AgentRuntime({
    registry,
    mcp,
    sources,
    userData,
    onEvent: (event) => events.push(event),
    // Only the stub is "installed": the machine's real CLIs must not be probed by tests.
    backendOptions: {
      resolveBinary: async (binary) => (binary === 'claude' ? join(bin, 'claude') : null),
      killGraceMs: 300
    },
    limits: { maxParallel: options.maxParallel ?? 2, maxQueue: options.maxQueue ?? 8 }
  })
  await runtime.init()
  cleanups.push(async () => {
    await runtime.dispose()
    await mcp.stop()
    registry.closeAll()
    await rm(userData, { recursive: true, force: true })
    await rm(bin, { recursive: true, force: true })
  })
  return { runtime, mcp, registry, docId: entry.docId, blockId, events, userData }
}

const nova: RunPersona = {
  id: 'agent_writer',
  name: 'Nova',
  handle: 'nova',
  role: 'writer',
  color: '#2563eb',
  instructions: 'Clear prose.',
  skills: ['draft']
}

const rex: RunPersona = {
  ...nova,
  id: 'agent_reviewer',
  name: 'Rex',
  handle: 'rex',
  role: 'reviewer'
}

function request(h: Harness, overrides: Partial<RunRequest> = {}): RunRequest {
  return {
    docId: h.docId,
    docTitle: 'Tides',
    kind: 'ask',
    persona: nova,
    backendId: 'claude-code',
    prompt: 'Draft an intro about tides.',
    sourceIds: [],
    ...overrides
  }
}

async function untilDone(h: Harness, runId: string, timeoutMs = 20_000): Promise<RunRecord> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const record = h.runtime.getRun(runId)
    if (record && record.endedAt !== null) return record
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error(`run ${runId} did not finish`)
}

describe('AgentRuntime · a writer persona on a CLI backend (AC-17.2, AC-17.8)', () => {
  it('produces commits attributed to the persona via the document MCP server and records the tool calls', async () => {
    const h = await harness()
    process.env.FAKE_CLI_MODE = 'mcp'
    const queued = h.runtime.run(request(h))
    const record = await untilDone(h, queued.runId)
    expect(record.status).toBe('done')
    expect(record.error).toBeNull()
    expect(record.summary).toBe('Done.')
    // Steps come from the server side: the outline read and the insert, with arguments.
    expect(record.steps.map((s) => s.tool)).toEqual(['get_document', 'insert_blocks'])
    expect(record.steps[1].args).toMatchObject({ at: { relation: 'inside_end' } })
    expect(record.writes).toBe(1)
    expect(record.command).toContain('--mcp-config')
    expect(record.command).not.toContain(h.mcp.token!)

    const hub = h.registry.get(h.docId)!.hub
    const last = listHistory(hub.doc).at(-1)!
    expect(last.author).toMatchObject({ actorId: 'agent_writer', name: 'Nova', color: '#2563eb' })
    const texts = allBlocks(hub.doc).map(({ node }) => blockPlainText(node))
    expect(texts.some((t) => t.startsWith('Drafted intro for:'))).toBe(true)
    // The run's MCP sessions are gone (AC-17.5) and the renderer saw the lifecycle.
    expect(h.mcp.sessionsForRun(record.runId)).toBe(0)
    const statuses = h.events
      .filter((e): e is Extract<RunEvent, { type: 'run' }> => e.type === 'run')
      .map((e) => e.record.status)
    expect(statuses[0]).toBe('queued')
    expect(statuses).toContain('working')
    expect(statuses.at(-1)).toBe('done')
    expect(h.events.filter((e) => e.type === 'step')).toHaveLength(2)
  })

  it('works with no API-key provider at all: only the CLI backend is needed', async () => {
    const h = await harness()
    const backends = await h.runtime.listBackends(true)
    const claude = backends.find((b) => b.id === 'claude-code')!
    expect(claude.available).toBe(true)
    expect(backends.find((b) => b.id === 'codex')!.available).toBe(false)
  })
})

describe('AgentRuntime · reviewer on a backend (AC-17.4)', () => {
  it('cannot write: the write attempt is recorded as forbidden and the comment goes through', async () => {
    const h = await harness()
    process.env.FAKE_CLI_MODE = 'forbidden'
    const record = await untilDone(h, h.runtime.run(request(h, { persona: rex })).runId)
    expect(record.status).toBe('done')
    expect(record.steps.map((s) => [s.tool, s.ok, s.error ?? null])).toEqual([
      ['get_document', true, null],
      ['replace_text', false, 'forbidden'],
      ['add_comment', true, null]
    ])
    expect(record.writes).toBe(1)
    const hub = h.registry.get(h.docId)!.hub
    expect(textOf(human(hub, 'ana'), h.blockId)).toBe('The quick brown fox jumps.')
  })
})

describe('AgentRuntime · cancel, errors and scheduling', () => {
  it('cancel kills the CLI, ends cancelled, and leaves no MCP session (AC-17.5)', async () => {
    const h = await harness()
    process.env.FAKE_CLI_MODE = 'sleep'
    const queued = h.runtime.run(request(h))
    await new Promise((r) => setTimeout(r, 400))
    const started = Date.now()
    expect(h.runtime.cancel(queued.runId)).toBe(true)
    const record = await untilDone(h, queued.runId)
    expect(record.status).toBe('cancelled')
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(h.mcp.sessionsForRun(record.runId)).toBe(0)
  })

  it('a failing CLI surfaces a typed error with the stderr tail (AC-17.6)', async () => {
    const h = await harness()
    process.env.FAKE_CLI_MODE = 'auth'
    const record = await untilDone(h, h.runtime.run(request(h)).runId)
    expect(record.status).toBe('error')
    expect(record.error).toMatchObject({ kind: 'auth', exitCode: 1 })
    expect(record.error!.stderrTail[0]).toMatch(/Not logged in/)
  })

  it('a missing backend fails fast with not_available', async () => {
    const h = await harness()
    const record = await untilDone(h, h.runtime.run(request(h, { backendId: 'codex' })).runId)
    expect(record.status).toBe('error')
    expect(record.error?.kind).toBe('not_available')
  })

  it('at most maxParallel runs are in flight; the rest wait as queued (AC-12.3)', async () => {
    const h = await harness({ maxParallel: 2 })
    process.env.FAKE_CLI_MODE = 'sleep'
    const a = h.runtime.run(request(h, { persona: { ...nova, id: 'a1', name: 'A' } }))
    const b = h.runtime.run(request(h, { persona: { ...nova, id: 'a2', name: 'B' } }))
    const c = h.runtime.run(request(h, { persona: { ...nova, id: 'a3', name: 'C' } }))
    await new Promise((r) => setTimeout(r, 600))
    const status = (id: string): string => h.runtime.getRun(id)!.status
    expect([status(a.runId), status(b.runId)]).toEqual(['working', 'working'])
    expect(status(c.runId)).toBe('queued')
    h.runtime.cancel(a.runId)
    await untilDone(h, a.runId)
    await new Promise((r) => setTimeout(r, 400))
    expect(status(c.runId)).toBe('working')
  })

  it('one agent runs one turn at a time and the 9th queued job is rejected (AC-12.4)', async () => {
    const h = await harness({ maxParallel: 2, maxQueue: 8 })
    process.env.FAKE_CLI_MODE = 'sleep'
    const first = h.runtime.run(request(h))
    await new Promise((r) => setTimeout(r, 300))
    expect(h.runtime.getRun(first.runId)!.status).toBe('working')
    const queued: RunRecord[] = []
    for (let i = 0; i < 8; i += 1) queued.push(h.runtime.run(request(h)))
    expect(queued.every((r) => r.status === 'queued')).toBe(true)
    const ninth = h.runtime.run(request(h))
    expect(ninth.status).toBe('error')
    expect(ninth.error?.kind).toBe('rejected')
    expect(ninth.error?.message).toMatch(/8 requests waiting/)
    h.runtime.cancelAgent(nova.id)
    await untilDone(h, first.runId)
    expect(h.runtime.listRuns(h.docId).filter((r) => r.status === 'cancelled')).toHaveLength(9)
  })
})
