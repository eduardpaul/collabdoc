// @vitest-environment node
import { mkdtemp, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { LOCAL_FOLDER_READ_TOOLS, MICROSOFT_LEARN_URL } from '../../shared/agents'
import { TOOL_NAMES } from '../../shared/tools'
import { CLI_PROFILES, type LaunchContext } from './cli-profiles'
import { SecretStore, plainCipher } from './secrets'
import { McpSourceStore } from './sources'

const FAKE_SERVER = resolve(__dirname, '../../../resources/test/fake-mcp-server.js')

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function store(): Promise<{ sources: McpSourceStore; secrets: SecretStore; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'collabdoc-sources-'))
  dirs.push(dir)
  const secrets = new SecretStore(dir, plainCipher)
  const sources = new McpSourceStore({ userData: dir, secrets, probeTimeoutMs: 15_000 })
  await sources.load()
  return { sources, secrets, dir }
}

function launchCtx(sources: LaunchContext['sources']): LaunchContext {
  return {
    prompt: 'p',
    systemPrompt: 's',
    maxTurns: 6,
    timeoutMs: 1000,
    cwd: '/scratch',
    doc: { url: 'http://127.0.0.1:1/mcp', headers: { Authorization: 'Bearer t' } },
    sources
  }
}

describe('McpSourceStore · configuration and secrets (AC-18.4, AC-18.8)', () => {
  it('stores presets; Microsoft Learn is pinned to its URL and Local folder to the read tools', async () => {
    const { sources } = await store()
    const learn = await sources.upsert({
      label: 'Microsoft Learn',
      preset: 'microsoft-learn',
      transport: 'http',
      enabled: true
    })
    expect(learn).toMatchObject({
      transport: 'http',
      url: MICROSOFT_LEARN_URL,
      slug: 'microsoft_learn',
      enabled: true
    })
    const folder = await sources.upsert({
      label: 'Notes',
      preset: 'local-folder',
      transport: 'stdio',
      args: ['/home/me/notes']
    })
    expect(folder.command).toBe('npx')
    expect(folder.args).toEqual(['-y', '@modelcontextprotocol/server-filesystem', '/home/me/notes'])
    expect(folder.toolAllowlist).toEqual(LOCAL_FOLDER_READ_TOOLS)
    // Someone editing the allowlist cannot widen a Local folder source to writes.
    const widened = await sources.upsert({
      id: folder.id,
      label: 'Notes',
      preset: 'local-folder',
      transport: 'stdio',
      toolAllowlist: ['write_file']
    })
    expect(widened.toolAllowlist).toEqual(LOCAL_FOLDER_READ_TOOLS)
  })

  it('secrets never come back to the caller and never land in mcp-sources.json', async () => {
    const { sources, secrets, dir } = await store()
    const source = await sources.upsert({
      label: 'Private API',
      preset: 'custom',
      transport: 'http',
      url: 'https://example.test/mcp',
      headers: { Authorization: 'Bearer super-secret-value-1234' },
      enabled: true
    })
    expect(source.headers.Authorization).toEqual({ hasValue: true, masked: '…1234' })
    const onDisk = await readFile(join(dir, 'mcp-sources.json'), 'utf8')
    expect(onDisk).not.toContain('super-secret')
    expect(secrets.get(`source:${source.id}:header:Authorization`)).toBe(
      'Bearer super-secret-value-1234'
    )
    // The run gets the real value.
    const resolved = sources.resolveForRun([source.id])
    expect(resolved.entries[0].headers).toEqual({ Authorization: 'Bearer super-secret-value-1234' })
    // Removing the source removes its secrets.
    await sources.remove(source.id)
    expect(secrets.keys('source:')).toEqual([])
  })

  it('a disabled source contributes nothing; enabling it takes effect on the next resolve', async () => {
    const { sources } = await store()
    const source = await sources.upsert({
      label: 'Docs',
      preset: 'custom',
      transport: 'http',
      url: 'https://d.test/mcp'
    })
    expect(sources.resolveForRun([source.id])).toEqual({
      entries: [],
      unavailable: [{ id: source.id, label: 'Docs', reason: 'source is disabled' }]
    })
    await sources.upsert({
      id: source.id,
      label: 'Docs',
      preset: 'custom',
      transport: 'http',
      enabled: true
    })
    expect(sources.resolveForRun([source.id]).entries).toHaveLength(1)
    expect(sources.resolveForRun(['gone']).unavailable[0].reason).toMatch(/no longer exists/)
  })

  it('persists across a reload', async () => {
    const { sources, dir } = await store()
    await sources.upsert({
      label: 'Docs',
      preset: 'custom',
      transport: 'http',
      url: 'https://d.test/mcp',
      enabled: true
    })
    const again = new McpSourceStore({ userData: dir, secrets: new SecretStore(dir, plainCipher) })
    await again.load()
    expect(again.list()).toHaveLength(1)
    expect(again.list()[0]).toMatchObject({
      label: 'Docs',
      url: 'https://d.test/mcp',
      enabled: true
    })
  })
})

describe('McpSourceStore · health (AC-18.1, AC-18.6)', () => {
  it("Refresh lists a stdio server's tools with descriptions", async () => {
    const { sources } = await store()
    const source = await sources.upsert({
      label: 'Fake',
      preset: 'custom',
      transport: 'stdio',
      command: process.execPath,
      args: [FAKE_SERVER],
      env: { FAKE_SECRET: 'shh' },
      enabled: true
    })
    const refreshed = await sources.refresh(source.id)
    expect(refreshed.health.status).toBe('ok')
    if (refreshed.health.status !== 'ok') return
    expect(refreshed.health.tools.map((t) => t.name).sort()).toEqual([
      'list_directory',
      'read_file',
      'replace_text',
      'search_files',
      'write_file'
    ])
    expect(refreshed.health.tools.find((t) => t.name === 'read_file')?.description).toBe(
      'Read a file'
    )
  }, 30_000)

  it('a server that fails to start shows the error and is reported unavailable to runs', async () => {
    const { sources } = await store()
    const source = await sources.upsert({
      label: 'Broken',
      preset: 'custom',
      transport: 'stdio',
      command: process.execPath,
      args: [FAKE_SERVER],
      env: { FAKE_MCP_FAIL: '1' },
      enabled: true
    })
    const refreshed = await sources.refresh(source.id)
    expect(refreshed.health.status).toBe('error')
    const resolved = sources.resolveForRun([source.id])
    expect(resolved.entries).toEqual([])
    expect(resolved.unavailable[0].reason).toMatch(/last check failed/)
  }, 30_000)

  it('an unreachable URL is an error, not a hang', async () => {
    const { sources } = await store()
    const source = await sources.upsert({
      label: 'Nowhere',
      preset: 'custom',
      transport: 'http',
      url: 'http://127.0.0.1:9/mcp',
      enabled: true
    })
    const refreshed = await sources.refresh(source.id)
    expect(refreshed.health.status).toBe('error')
  }, 30_000)
})

describe('sources on a CLI backend run (AC-18.2, AC-18.3)', () => {
  it('sources are namespaced src_<slug>; a source tool named replace_text cannot shadow the document tool', async () => {
    const { sources } = await store()
    const source = await sources.upsert({
      label: 'Fake',
      preset: 'custom',
      transport: 'stdio',
      command: process.execPath,
      args: [FAKE_SERVER],
      enabled: true
    })
    const { entries } = sources.resolveForRun([source.id])
    expect(entries[0].name).toBe('src_fake')
    // In every CLI the source's tools live under its server name, never bare.
    const claude = CLI_PROFILES['claude-code'].launch(launchCtx(entries))
    const config = JSON.parse(claude.files[0].content) as { mcpServers: Record<string, unknown> }
    expect(Object.keys(config.mcpServers)).toEqual(['collabdoc', 'src_fake'])
    for (const tool of TOOL_NAMES) expect(Object.keys(config.mcpServers)).not.toContain(tool)
    const allowed = claude.args.slice(
      claude.args.indexOf('--allowedTools') + 1,
      claude.args.indexOf('--permission-mode')
    )
    expect(allowed).toEqual(['mcp__collabdoc', 'mcp__src_fake'])
  })

  it('a Local folder source is started on exactly the chosen directory and only read tools are allowed', async () => {
    const { sources } = await store()
    const folder = await sources.upsert({
      label: 'My notes',
      preset: 'local-folder',
      transport: 'stdio',
      args: ['/data/notes'],
      enabled: true
    })
    const { entries } = sources.resolveForRun([folder.id])
    expect(entries[0]).toMatchObject({
      name: 'src_my_notes',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/data/notes']
    })
    const claude = CLI_PROFILES['claude-code'].launch(launchCtx(entries))
    const allowed = claude.args.slice(
      claude.args.indexOf('--allowedTools') + 1,
      claude.args.indexOf('--permission-mode')
    )
    expect(allowed).toEqual([
      'mcp__collabdoc',
      ...LOCAL_FOLDER_READ_TOOLS.map((t) => `mcp__src_my_notes__${t}`)
    ])
    expect(allowed.join(' ')).not.toMatch(/write/)
    // grok gets the server too (its config has no per-tool allowlist; the note in the spec covers this).
    const grok = CLI_PROFILES.grok.launch(launchCtx(entries))
    expect(grok.files[0].content).toContain('[mcp_servers.src_my_notes]')
    expect(grok.files[0].content).toContain('"/data/notes"')
  })
})
