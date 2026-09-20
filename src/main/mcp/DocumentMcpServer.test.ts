// @vitest-environment node
import { mkdtemp, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, describe, expect, it } from 'vitest'
import { readAuthors } from '../../core/authors'
import { listHistory } from '../../core/history'
import { DocumentRegistry } from '../../core/registry'
import { addParagraph, human, textOf } from '../../core/test-helpers'
import { REVIEWER_TOOLS, WRITER_TOOLS } from '../../shared/tools'
import type { RunStep } from '../../shared/agents'
import { DocumentMcpServer } from './DocumentMcpServer'

type Harness = {
  server: DocumentMcpServer
  registry: DocumentRegistry
  dir: string
  docId: string
  blockId: string
}

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

async function harness(): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'collabdoc-mcp-'))
  const registry = new DocumentRegistry({ closeDelayMs: Number.POSITIVE_INFINITY })
  const entry = registry.create({ title: 'Launch plan' })
  const ana = human(entry.hub, 'ana')
  const blockId = addParagraph(ana, 'The quick brown fox jumps.')
  const server = new DocumentMcpServer({ registry, userData: dir })
  await server.init()
  await server.start()
  cleanups.push(async () => {
    await server.stop()
    registry.closeAll()
    await rm(dir, { recursive: true, force: true })
  })
  return { server, registry, dir, docId: entry.docId, blockId }
}

async function connect(
  server: DocumentMcpServer,
  options: { token?: string; headers?: Record<string, string>; name?: string } = {}
): Promise<Client> {
  const token = options.token ?? server.token ?? ''
  const transport = new StreamableHTTPClientTransport(new URL(server.url!), {
    requestInit: {
      headers: { Authorization: `Bearer ${token}`, ...(options.headers ?? {}) }
    }
  })
  const client = new Client({ name: options.name ?? 'Claude Code', version: '1.0.0' })
  await client.connect(transport)
  cleanups.push(async () => {
    try {
      await client.close()
    } catch {
      /* already closed */
    }
  })
  return client
}

function parse<T>(result: { content: unknown }): T {
  const first = (result.content as Array<{ type: string; text: string }>)[0]
  return JSON.parse(first.text) as T
}

describe('DocumentMcpServer · transport and auth (AC-16.1, AC-16.10)', () => {
  it('binds to loopback on a random port and refuses calls without the bearer token', async () => {
    const h = await harness()
    expect(h.server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
    const res = await fetch(h.server.url!, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream'
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    })
    expect(res.status).toBe(401)
    const wrong = await fetch(h.server.url!, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: 'Bearer nope'
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    })
    expect(wrong.status).toBe(401)
  })

  it('persists the switch and token in userData/mcp.json with 0600', async () => {
    const h = await harness()
    await h.server.setEnabled(true)
    const raw = JSON.parse(await readFile(join(h.dir, 'mcp.json'), 'utf8')) as {
      enabled: boolean
      token: string
    }
    expect(raw.enabled).toBe(true)
    expect(raw.token).toBe(h.server.token)
    expect(raw.token).toMatch(/^[a-f0-9]{64}$/)
  })

  it('lists the open documents for an approved client (AC-16.1)', async () => {
    const h = await harness()
    await h.server.setClientRole('Claude Code', 'writer')
    const client = await connect(h.server)
    const docs = parse<{ documents: Array<{ docId: string; title: string }> }>(
      await client.callTool({ name: 'list_documents', arguments: {} })
    )
    expect(docs.documents).toEqual([{ docId: h.docId, title: 'Launch plan' }])
    const outline = parse<{ blocks: Array<{ blockId: string }> }>(
      await client.callTool({ name: 'get_document', arguments: { docId: h.docId } })
    )
    // A new document starts with one empty paragraph; ours follows it.
    expect(outline.blocks.map((b) => b.blockId)).toContain(h.blockId)
  })
})

describe('DocumentMcpServer · attribution and roles (AC-16.2, AC-16.3)', () => {
  it("an external client's replace_text is committed under its own actor and color", async () => {
    const h = await harness()
    await h.server.setClientRole('Claude Code', 'writer')
    const client = await connect(h.server)
    const result = parse<{ ok: boolean }>(
      await client.callTool({
        name: 'replace_text',
        arguments: { docId: h.docId, blockId: h.blockId, locator: { find: 'quick' }, text: 'slow' }
      })
    )
    expect(result.ok).toBe(true)
    const hub = h.registry.get(h.docId)!.hub
    const ana = human(hub, 'ana')
    expect(textOf(ana, h.blockId)).toBe('The slow brown fox jumps.')
    const author = Object.values(readAuthors(hub.doc)).find((a) => a.actorId === 'mcp:claude_code')
    expect(author).toMatchObject({ name: 'Claude Code', role: 'agent' })
    const last = listHistory(hub.doc).at(-1)!
    expect(last.author.actorId).toBe('mcp:claude_code')
  })

  it('a reviewer client only sees REVIEWER_TOOLS and gets forbidden on a write by name', async () => {
    const h = await harness()
    await h.server.setClientRole('Codex', 'reviewer')
    const client = await connect(h.server, { name: 'Codex' })
    const { tools } = await client.listTools()
    const names = tools.map((t) => t.name).filter((n) => n !== 'list_documents' && n !== 'whoami')
    expect(names.sort()).toEqual([...REVIEWER_TOOLS].sort())
    const forged = await client.callTool({
      name: 'replace_text',
      arguments: { docId: h.docId, blockId: h.blockId, locator: { find: 'quick' }, text: 'x' }
    })
    expect(forged.isError).toBe(true)
    expect(parse<{ error: string }>(forged).error).toBe('forbidden')
  })

  it('a writer client sees WRITER_TOOLS, each with an optional docId', async () => {
    const h = await harness()
    await h.server.setClientRole('Claude Code', 'writer')
    const client = await connect(h.server)
    const { tools } = await client.listTools()
    const names = tools.map((t) => t.name).filter((n) => n !== 'list_documents' && n !== 'whoami')
    expect(names.sort()).toEqual([...WRITER_TOOLS].sort())
    const replace = tools.find((t) => t.name === 'replace_text')!
    expect((replace.inputSchema.properties as Record<string, unknown>).docId).toBeDefined()
    expect(replace.inputSchema.required).not.toContain('docId')
  })
})

describe('DocumentMcpServer · consent (AC-16.4)', () => {
  it('an unknown client gets "awaiting approval" until the user chooses; the choice persists', async () => {
    const h = await harness()
    const pending: string[] = []
    const server = new DocumentMcpServer({
      registry: h.registry,
      userData: h.dir,
      onPending: (name) => pending.push(name)
    })
    await server.init()
    await server.start()
    cleanups.push(() => server.stop())
    const client = await connect(server, { name: 'Grok' })
    const first = await client.callTool({ name: 'get_document', arguments: { docId: h.docId } })
    expect(first.isError).toBe(true)
    expect(parse<{ message: string }>(first).message).toMatch(/awaiting approval/i)
    expect(pending).toEqual(['Grok'])
    expect(server.state().pending).toEqual(['Grok'])

    await server.setClientRole('Grok', 'reviewer')
    const second = await client.callTool({ name: 'get_document', arguments: { docId: h.docId } })
    expect(second.isError).toBeFalsy()
    const raw = JSON.parse(await readFile(join(h.dir, 'mcp.json'), 'utf8')) as {
      clients: Record<string, string>
    }
    expect(raw.clients.Grok).toBe('reviewer')

    await server.setClientRole('Grok', 'blocked')
    const third = await client.callTool({ name: 'get_document', arguments: { docId: h.docId } })
    expect(parse<{ message: string }>(third).message).toMatch(/blocked/i)
  })

  it('resources need the same consent as tools: nothing is listed or readable before approval', async () => {
    const h = await harness()
    const client = await connect(h.server, { name: 'Codex' })
    const uri = `collabdoc://doc/${h.docId}`
    expect((await client.listResources()).resources).toEqual([])
    await expect(client.readResource({ uri })).rejects.toThrow(/awaiting approval/i)
    expect(h.server.state().pending).toEqual(['Codex'])

    await h.server.setClientRole('Codex', 'reviewer')
    expect((await client.listResources()).resources.map((r) => r.uri)).toEqual([
      uri,
      `${uri}/outline`
    ])
    expect((await client.readResource({ uri })).contents[0]).toMatchObject({
      mimeType: 'text/markdown'
    })

    await h.server.setClientRole('Codex', 'blocked')
    expect((await client.listResources()).resources).toEqual([])
    await expect(client.readResource({ uri })).rejects.toThrow(/blocked/i)
  })
})

describe('DocumentMcpServer · runs (17)', () => {
  it('a registered run acts as the persona, records steps, and releasing it closes its sessions', async () => {
    const h = await harness()
    const steps: RunStep[] = []
    const headers = h.server.registerRun({
      runId: 'run_1',
      docId: h.docId,
      actor: {
        actorId: 'agent_writer',
        name: 'Nova',
        color: '#2563eb',
        role: 'agent',
        handle: 'nova'
      },
      role: 'writer',
      onStep: (step) => steps.push(step)
    })
    // No consent needed: the person invited the persona and asked for the run.
    const client = await connect(h.server, { headers, name: 'claude-code' })
    const who = parse<{ actorId: string; name: string; role: string }>(
      await client.callTool({ name: 'whoami', arguments: {} })
    )
    expect(who).toMatchObject({ actorId: 'agent_writer', name: 'Nova', role: 'writer' })
    // docId may be omitted: the run is bound to its document.
    const result = parse<{ ok: boolean }>(
      await client.callTool({
        name: 'insert_blocks',
        arguments: {
          at: { relation: 'inside_end' },
          blocks: [{ type: 'paragraph', text: 'Drafted.' }]
        }
      })
    )
    expect(result.ok).toBe(true)
    const hub = h.registry.get(h.docId)!.hub
    expect(listHistory(hub.doc).at(-1)!.author).toMatchObject({
      actorId: 'agent_writer',
      name: 'Nova'
    })
    // whoami is not a document tool; only document calls become run steps.
    expect(steps).toHaveLength(1)
    expect(steps[0]).toMatchObject({ tool: 'insert_blocks', ok: true })
    expect(steps[0].args).toMatchObject({ at: { relation: 'inside_end' } })

    expect(h.server.sessionsForRun('run_1')).toBe(1)
    await h.server.releaseRun('run_1')
    expect(h.server.sessionsForRun('run_1')).toBe(0)
    expect(h.server.state().connected).toHaveLength(0)
  })

  it('a reviewer run cannot write: forbidden is recorded in the run steps (AC-17.4)', async () => {
    const h = await harness()
    const steps: RunStep[] = []
    const headers = h.server.registerRun({
      runId: 'run_2',
      docId: h.docId,
      actor: { actorId: 'agent_reviewer', name: 'Rex', color: '#db2777', role: 'agent' },
      role: 'reviewer',
      onStep: (step) => steps.push(step)
    })
    const client = await connect(h.server, { headers })
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name)).not.toContain('replace_text')
    const forged = await client.callTool({
      name: 'replace_text',
      arguments: { blockId: h.blockId, locator: { find: 'quick' }, text: 'x' }
    })
    expect(forged.isError).toBe(true)
    expect(steps.at(-1)).toMatchObject({ tool: 'replace_text', ok: false, error: 'forbidden' })
  })

  it('a run stays inside its own document: another open docId is refused for tools and resources', async () => {
    const h = await harness()
    const other = h.registry.create({ title: 'Other plan' })
    addParagraph(human(other.hub, 'bo'), 'Private notes.')
    const steps: RunStep[] = []
    const headers = h.server.registerRun({
      runId: 'run_3',
      docId: h.docId,
      actor: { actorId: 'agent_writer', name: 'Nova', color: '#2563eb', role: 'agent' },
      role: 'writer',
      onStep: (step) => steps.push(step)
    })
    const client = await connect(h.server, { headers })
    const before = listHistory(other.hub.doc).length
    const foreign = await client.callTool({
      name: 'insert_blocks',
      arguments: {
        docId: other.docId,
        at: { relation: 'inside_end' },
        blocks: [{ type: 'paragraph', text: 'Sneaked in.' }]
      }
    })
    expect(foreign.isError).toBe(true)
    expect(parse<{ error: string; message: string }>(foreign)).toMatchObject({
      error: 'not_found',
      message: expect.stringMatching(/bound to document/)
    })
    expect(listHistory(other.hub.doc)).toHaveLength(before)
    expect(steps).toHaveLength(0)
    // Naming its own document explicitly is fine.
    const own = await client.callTool({ name: 'get_document', arguments: { docId: h.docId } })
    expect(own.isError).toBeFalsy()
    // Resources: only the bound document is listed or readable.
    expect((await client.listResources()).resources.map((r) => r.uri)).toEqual([
      `collabdoc://doc/${h.docId}`,
      `collabdoc://doc/${h.docId}/outline`
    ])
    await expect(client.readResource({ uri: `collabdoc://doc/${other.docId}` })).rejects.toThrow(
      /bound to document/
    )
  })

  it('an unknown run header is refused and a mismatched one cannot reuse a session', async () => {
    const h = await harness()
    await expect(
      connect(h.server, { headers: { 'X-CollabDoc-Run': 'run_nope' } })
    ).rejects.toThrow()
  })
})

describe('DocumentMcpServer · limits and lifecycle (AC-16.6, AC-16.7, AC-16.9)', () => {
  it('more than 20 writes in a second return limit and the document has at most 20 commits', async () => {
    const h = await harness()
    await h.server.setClientRole('Claude Code', 'writer')
    const client = await connect(h.server)
    const hub = h.registry.get(h.docId)!.hub
    const before = listHistory(hub.doc).length
    const results: Array<{ ok: boolean; error?: string }> = []
    for (let i = 0; i < 30; i += 1) {
      results.push(
        parse(
          await client.callTool({
            name: 'insert_blocks',
            arguments: {
              at: { relation: 'inside_end' },
              blocks: [{ type: 'paragraph', text: `p${i}` }]
            }
          })
        )
      )
    }
    const limited = results.filter((r) => r.error === 'limit')
    expect(limited.length).toBeGreaterThanOrEqual(10)
    expect(listHistory(hub.doc).length - before).toBeLessThanOrEqual(20)
    expect(h.server.state().connected[0].rateLimited).toBe(true)
  })

  it('the "rate limited" mark clears once the burst is over', async () => {
    const h = await harness()
    const states: boolean[] = []
    const server = new DocumentMcpServer({
      registry: h.registry,
      userData: h.dir,
      rateLimitFlagMs: 150,
      onState: (state) => states.push(state.connected[0]?.rateLimited ?? false)
    })
    await server.init()
    await server.start()
    cleanups.push(() => server.stop())
    await server.setClientRole('Claude Code', 'writer')
    const client = await connect(server)
    for (let i = 0; i < 25; i += 1) {
      await client.callTool({
        name: 'insert_blocks',
        arguments: { at: { relation: 'inside_end' }, blocks: [{ type: 'paragraph', text: 'p' }] }
      })
    }
    expect(server.state().connected[0].rateLimited).toBe(true)
    await new Promise((r) => setTimeout(r, 300))
    expect(server.state().connected[0].rateLimited).toBe(false)
    // Settings was told both when it started and when it lapsed.
    expect(states.at(-1)).toBe(false)
    expect(states).toContain(true)
  })

  it('closing the document makes calls return not_found without disconnecting the client', async () => {
    const h = await harness()
    await h.server.setClientRole('Claude Code', 'writer')
    const client = await connect(h.server)
    await client.callTool({ name: 'get_document', arguments: { docId: h.docId } })
    h.registry.close(h.docId)
    const after = await client.callTool({ name: 'get_document', arguments: { docId: h.docId } })
    expect(after.isError).toBe(true)
    expect(parse<{ error: string }>(after).error).toBe('not_found')
    const docs = parse<{ documents: unknown[] }>(
      await client.callTool({ name: 'list_documents', arguments: {} })
    )
    expect(docs.documents).toEqual([])
    expect(h.server.state().connected).toHaveLength(1)
  })

  it('rotating the token disconnects clients and the old token is refused', async () => {
    const h = await harness()
    await h.server.setClientRole('Claude Code', 'writer')
    const old = h.server.token!
    const client = await connect(h.server)
    await client.callTool({ name: 'list_documents', arguments: {} })
    await h.server.rotateToken()
    expect(h.server.token).not.toBe(old)
    expect(h.server.state().connected).toHaveLength(0)
    await expect(connect(h.server, { token: old })).rejects.toThrow()
    expect(h.server.setupCommand('claude-code')).toContain(h.server.token!)
    expect(h.server.setupCommand('claude-code')).not.toContain(old)
  })

  it('serves the document as a Markdown resource and an outline', async () => {
    const h = await harness()
    await h.server.setClientRole('Claude Code', 'writer')
    const client = await connect(h.server)
    const { resources } = await client.listResources()
    expect(resources.map((r) => r.uri)).toEqual([
      `collabdoc://doc/${h.docId}`,
      `collabdoc://doc/${h.docId}/outline`
    ])
    const md = await client.readResource({ uri: `collabdoc://doc/${h.docId}` })
    expect((md.contents[0] as { text: string }).text).toBe(
      '# Launch plan\n\nThe quick brown fox jumps.\n'
    )
    const { prompts } = await client.listPrompts()
    expect(prompts.map((p) => p.name).sort()).toEqual(['draft-section', 'review-document'])
  })
})
