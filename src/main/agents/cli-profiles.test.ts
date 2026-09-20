// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { BACKEND_IDS } from '../../shared/agents'
import {
  CLI_PROFILES,
  customProfile,
  splitCommandTemplate,
  type LaunchContext
} from './cli-profiles'
import { redact } from './CliBackend'

const TOKEN = 'a'.repeat(64)

function ctx(overrides: Partial<LaunchContext> = {}): LaunchContext {
  return {
    prompt: 'Draft the intro.',
    systemPrompt: 'You are Nova.',
    maxTurns: 12,
    timeoutMs: 180_000,
    cwd: '/userData/agents/agent_writer/work',
    doc: {
      url: 'http://127.0.0.1:4242/mcp',
      headers: { Authorization: `Bearer ${TOKEN}`, 'X-CollabDoc-Run': 'run_1' }
    },
    sources: [],
    ...overrides
  }
}

describe('CLI profiles · launch plans', () => {
  it('every built-in backend has a profile with a version probe and an install hint', () => {
    for (const id of BACKEND_IDS) {
      if (id === 'custom-cli') continue
      const profile = CLI_PROFILES[id]
      expect(profile.id).toBe(id)
      expect(profile.binary.length).toBeGreaterThan(0)
      expect(profile.versionArgs.length).toBeGreaterThan(0)
      expect(profile.installHint.length).toBeGreaterThan(10)
      expect(profile.sandboxNote.length).toBeGreaterThan(10)
    }
  })

  it('claude-code: headless stream-json, no built-in tools, only the document server allowed, strict MCP config', () => {
    const plan = CLI_PROFILES['claude-code'].launch(ctx())
    expect(plan.args.slice(0, 2)).toEqual(['-p', 'Draft the intro.'])
    expect(plan.args).toContain('--strict-mcp-config')
    expect(plan.args).toContain('--no-session-persistence')
    expect(plan.args[plan.args.indexOf('--tools') + 1]).toBe('')
    expect(plan.args[plan.args.indexOf('--allowedTools') + 1]).toBe('mcp__collabdoc')
    expect(plan.args[plan.args.indexOf('--append-system-prompt') + 1]).toBe('You are Nova.')
    expect(plan.args[plan.args.indexOf('--max-turns') + 1]).toBe('12')
    // Nested-session guard: a CollabDoc started from a Claude Code terminal still works.
    expect(plan.env).toEqual({ CLAUDECODE: undefined, CLAUDE_CODE_ENTRYPOINT: undefined })
    const config = JSON.parse(plan.files[0].content) as {
      mcpServers: Record<string, { type: string; url: string; headers: Record<string, string> }>
    }
    expect(plan.files[0].path).toBe('mcp.json')
    expect(config.mcpServers.collabdoc).toEqual({
      type: 'http',
      url: 'http://127.0.0.1:4242/mcp',
      headers: { Authorization: `Bearer ${TOKEN}`, 'X-CollabDoc-Run': 'run_1' }
    })
  })

  it('grok: trusts the scratch folder, keeps one harmless built-in, writes the project TOML', () => {
    const plan = CLI_PROFILES.grok.launch(ctx())
    expect(plan.args[0]).toBe('--trust')
    expect(plan.args[plan.args.indexOf('--output-format') + 1]).toBe('streaming-messages-json')
    expect(plan.args[plan.args.indexOf('--cwd') + 1]).toBe('/userData/agents/agent_writer/work')
    expect(plan.args[plan.args.indexOf('--tools') + 1]).toBe('todo_write')
    expect(plan.args).toContain('--no-subagents')
    expect(plan.args[plan.args.indexOf('--rules') + 1]).toBe('You are Nova.')
    expect(plan.files[0].path).toBe('.grok/config.toml')
    expect(plan.files[0].content).toContain('[mcp_servers.collabdoc]')
    expect(plan.files[0].content).toContain('url = "http://127.0.0.1:4242/mcp"')
    expect(plan.files[0].content).toContain(`Authorization = "Bearer ${TOKEN}"`)
    expect(plan.files[0].content).toContain('X-CollabDoc-Run = "run_1"')
  })

  it('antigravity: registers the server globally before the run and removes it after; system prompt folded in', () => {
    const plan = CLI_PROFILES.antigravity.launch(ctx())
    expect(plan.files).toEqual([])
    expect(plan.preRun).toEqual([
      [
        'mcp',
        'add',
        '--type',
        'http',
        '--header',
        `Authorization: Bearer ${TOKEN}`,
        '--header',
        'X-CollabDoc-Run: run_1',
        'collabdoc',
        'http://127.0.0.1:4242/mcp'
      ]
    ])
    expect(plan.postRun).toEqual([['mcp', 'remove', 'collabdoc']])
    expect(plan.args[plan.args.indexOf('--output-format') + 1]).toBe('stream-json')
    expect(plan.args[plan.args.indexOf('--print-timeout') + 1]).toBe('180s')
    expect(plan.args).toContain('--sandbox')
    expect(plan.args[1]).toContain('You are Nova.')
    expect(plan.args[1]).toContain('Draft the intro.')
  })

  it('gemini: project settings with the servers and no core tools; trusted workspace env', () => {
    const plan = CLI_PROFILES.gemini.launch(ctx())
    expect(plan.files[0].path).toBe('.gemini/settings.json')
    const settings = JSON.parse(plan.files[0].content) as {
      mcpServers: Record<string, unknown>
      tools: { core: string[] }
    }
    expect(Object.keys(settings.mcpServers)).toEqual(['collabdoc'])
    expect(settings.tools.core).toEqual([])
    expect(plan.args[plan.args.indexOf('--allowed-mcp-server-names') + 1]).toBe('collabdoc')
    expect(plan.env).toEqual({ GEMINI_CLI_TRUST_WORKSPACE: 'true' })
    expect(CLI_PROFILES.gemini.verified).toBe(false)
  })

  it('codex: exec --json read-only sandbox with -c overrides for the servers', () => {
    const plan = CLI_PROFILES.codex.launch(ctx())
    expect(plan.args.slice(0, 5)).toEqual([
      'exec',
      '--json',
      '--sandbox',
      'read-only',
      '--skip-git-repo-check'
    ])
    const overrides = plan.args.filter((_, i) => plan.args[i - 1] === '-c')
    expect(overrides[0]).toBe('mcp_servers.collabdoc.url="http://127.0.0.1:4242/mcp"')
    expect(overrides[1]).toContain(`Authorization = "Bearer ${TOKEN}"`)
    expect(CLI_PROFILES.codex.verified).toBe(false)
  })

  it('sources ride along as extra servers in every dialect', () => {
    const sources = [
      {
        name: 'src_learn',
        transport: 'http' as const,
        url: 'https://learn.microsoft.com/api/mcp',
        headers: {},
        toolAllowlist: null
      },
      {
        name: 'src_notes',
        transport: 'stdio' as const,
        command: 'npx',
        args: ['-y', 'fs-server', '/notes'],
        env: { KEY: 'v' },
        toolAllowlist: ['read_file']
      }
    ]
    const claude = JSON.parse(
      CLI_PROFILES['claude-code'].launch(ctx({ sources })).files[0].content
    ) as { mcpServers: Record<string, unknown> }
    expect(Object.keys(claude.mcpServers)).toEqual(['collabdoc', 'src_learn', 'src_notes'])
    expect(claude.mcpServers.src_notes).toEqual({
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'fs-server', '/notes'],
      env: { KEY: 'v' }
    })
    const grok = CLI_PROFILES.grok.launch(ctx({ sources })).files[0].content
    expect(grok).toContain(
      '[mcp_servers.src_notes]\ncommand = "npx"\nargs = ["-y", "fs-server", "/notes"]'
    )
    expect(grok).toContain('[mcp_servers.src_notes.env]\nKEY = "v"')
    const agy = CLI_PROFILES.antigravity.launch(ctx({ sources }))
    expect(agy.preRun).toHaveLength(3)
    expect(agy.preRun[2]).toEqual([
      'mcp',
      'add',
      '--type',
      'stdio',
      '--env',
      'KEY=v',
      'src_notes',
      '--',
      'npx',
      '-y',
      'fs-server',
      '/notes'
    ])
    expect(agy.postRun.map((a) => a[2])).toEqual(['collabdoc', 'src_learn', 'src_notes'])
  })
})

describe('custom CLI template', () => {
  it('splits on whitespace honouring quotes and substitutes placeholders', () => {
    expect(splitCommandTemplate(`mytool run -p "{prompt}" --url {mcpUrl}`)).toEqual([
      'mytool',
      'run',
      '-p',
      '{prompt}',
      '--url',
      '{mcpUrl}'
    ])
    const profile = customProfile({
      command:
        'mytool -p "{prompt}" --mcp {mcpConfigFile} --token {mcpToken} --sys "{systemPrompt}"',
      parser: 'plain',
      mcpConfigFormat: 'claude-json'
    })
    expect(profile.binary).toBe('mytool')
    const plan = profile.launch(ctx())
    expect(plan.args).toEqual([
      '-p',
      'Draft the intro.',
      '--mcp',
      'mcp.json',
      '--token',
      TOKEN,
      '--sys',
      'You are Nova.'
    ])
    expect(plan.files[0].path).toBe('mcp.json')
    const none = customProfile({
      command: 'other {mcpUrl}',
      parser: 'plain',
      mcpConfigFormat: 'none'
    }).launch(ctx())
    expect(none.files).toEqual([])
    expect(none.args).toEqual(['http://127.0.0.1:4242/mcp'])
  })
})

describe('redact', () => {
  it('hides the bearer token and source secrets, elides long args, quotes spaces', () => {
    const line = redact(
      [
        '/bin/claude',
        '-p',
        'x'.repeat(200),
        '--header',
        `Authorization: Bearer ${TOKEN}`,
        `--token=${TOKEN}`
      ],
      { Authorization: `Bearer ${TOKEN}` },
      [
        {
          name: 's',
          transport: 'http',
          headers: { 'X-Key': 'sourcesecret99' },
          toolAllowlist: null
        }
      ]
    )
    expect(line).not.toContain(TOKEN)
    expect(line).toContain('--token=•••')
    expect(line).toContain('"Authorization: Bearer •••"')
    expect(line).toMatch(/x{77}…/)
    expect(
      redact(['t', 'sourcesecret99'], {}, [
        {
          name: 's',
          transport: 'http',
          headers: { 'X-Key': 'sourcesecret99' },
          toolAllowlist: null
        }
      ])
    ).toBe('t •••')
  })
})
