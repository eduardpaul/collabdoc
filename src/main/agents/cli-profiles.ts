import type { AuthStatus, BackendId, CustomCliConfig } from '../../shared/agents'
import {
  claudeMcpJson,
  codexOverrides,
  geminiSettingsJson,
  grokConfigToml,
  type McpServerEntry
} from './mcp-config-files'

/** The MCP server name every CLI run sees for the document. */
export const DOC_SERVER_NAME = 'collabdoc'

export type StreamParserId = 'messages' | 'antigravity' | 'codex' | 'plain'

/** One external MCP source (18) as the run's CLI should see it. */
export type SourceEntry = McpServerEntry & { toolAllowlist: string[] | null }

export type LaunchContext = {
  prompt: string
  systemPrompt: string
  maxTurns: number
  timeoutMs: number
  /** The run's private scratch dir; also the process cwd. */
  cwd: string
  doc: { url: string; headers: Record<string, string> }
  sources: SourceEntry[]
}

export type LaunchPlan = {
  args: string[]
  /** Files to write under `cwd` before spawning. */
  files: Array<{ path: string; content: string }>
  /** Run before / after the CLI, with the same binary (e.g. `agy mcp add`). */
  preRun: string[][]
  postRun: string[][]
  /** Environment overrides; `undefined` removes a variable. */
  env: Record<string, string | undefined>
  /** Whether the prompt is passed as an argument or written to stdin. */
  stdin: string | null
}

export type CliProfile = {
  id: BackendId
  label: string
  binary: string
  installHint: string
  minVersion: string | null
  /** Flags checked against a real binary while implementing 17. */
  verified: boolean
  versionArgs: string[]
  /** How to tell the CLI is signed in; null = not knowable without a run. */
  authCheck: {
    args: string[]
    /** Decide from the probe's exit code and output. */
    status: (result: { code: number | null; stdout: string; stderr: string }) => AuthStatus
    /** What the user can run to fix `missing`. */
    fix: string
  } | null
  parser: StreamParserId
  /** Which flags keep the process away from the user's filesystem. */
  sandboxNote: string
  launch: (ctx: LaunchContext) => LaunchPlan
}

function entries(ctx: LaunchContext): McpServerEntry[] {
  return [
    { name: DOC_SERVER_NAME, transport: 'http', url: ctx.doc.url, headers: ctx.doc.headers },
    ...ctx.sources.map(asEntry)
  ]
}

/** The MCP server entry for a source; the allowlist is a CLI flag, not config. */
function asEntry(source: SourceEntry): McpServerEntry {
  return {
    name: source.name,
    transport: source.transport,
    url: source.url,
    headers: source.headers,
    command: source.command,
    args: source.args,
    env: source.env
  }
}

/** System prompt folded into the user prompt for CLIs without a system-prompt flag. */
function foldedPrompt(ctx: LaunchContext): string {
  return `${ctx.systemPrompt}\n\n---\n\nRequest:\n${ctx.prompt}`
}

const claudeCode: CliProfile = {
  id: 'claude-code',
  label: 'Claude Code',
  binary: 'claude',
  installHint: 'npm install -g @anthropic-ai/claude-code  (or see https://claude.com/claude-code)',
  minVersion: '2.0.0',
  verified: true,
  versionArgs: ['--version'],
  authCheck: {
    args: ['auth', 'status'],
    status: ({ code, stdout }) => {
      if (code !== 0) return 'missing'
      try {
        return (JSON.parse(stdout) as { loggedIn?: boolean }).loggedIn ? 'ok' : 'missing'
      } catch {
        return /logged\s*in|✓/i.test(stdout) ? 'ok' : 'unknown'
      }
    },
    fix: 'claude auth login'
  },
  parser: 'messages',
  sandboxNote:
    '--tools "" removes every built-in tool (no shell, no file access); --allowedTools limits ' +
    'the run to the document server and attached sources; --strict-mcp-config ignores the ' +
    "user's own MCP servers.",
  launch: (ctx) => {
    const allowed = [`mcp__${DOC_SERVER_NAME}`]
    for (const source of ctx.sources) {
      if (source.toolAllowlist) {
        for (const tool of source.toolAllowlist) allowed.push(`mcp__${source.name}__${tool}`)
      } else {
        allowed.push(`mcp__${source.name}`)
      }
    }
    return {
      args: [
        '-p',
        ctx.prompt,
        '--output-format',
        'stream-json',
        '--verbose',
        '--max-turns',
        String(ctx.maxTurns),
        '--no-session-persistence',
        '--mcp-config',
        'mcp.json',
        '--strict-mcp-config',
        '--tools',
        '',
        '--allowedTools',
        ...allowed,
        '--permission-mode',
        'default',
        '--append-system-prompt',
        ctx.systemPrompt
      ],
      files: [{ path: 'mcp.json', content: claudeMcpJson(entries(ctx)) }],
      preRun: [],
      postRun: [],
      // A CollabDoc launched from inside a Claude Code session would otherwise refuse to nest.
      env: { CLAUDECODE: undefined, CLAUDE_CODE_ENTRYPOINT: undefined },
      stdin: null
    }
  }
}

/**
 * grok keeps a few built-ins even with an empty `--tools`, so the allowlist
 * names one harmless tool; MCP tools are not built-ins and stay available.
 * Repo-local MCP servers only start in a trusted folder: `--trust` records
 * the scratch dir in ~/.grok/trusted_folders.toml.
 */
const GROK_HARMLESS_TOOL = 'todo_write'

const grok: CliProfile = {
  id: 'grok',
  label: 'Grok CLI',
  binary: 'grok',
  installHint: 'See https://docs.x.ai/grok-cli  (grok update to upgrade)',
  minVersion: '1.0.0',
  verified: true,
  versionArgs: ['--version'],
  authCheck: {
    args: ['models'],
    status: ({ code, stdout, stderr }) => {
      const text = `${stdout}\n${stderr}`
      if (/logged in/i.test(text)) return 'ok'
      if (/sign in|log in|not logged|login/i.test(text) || code !== 0) return 'missing'
      return 'unknown'
    },
    fix: 'grok login'
  },
  parser: 'messages',
  sandboxNote:
    `--tools ${GROK_HARMLESS_TOOL} leaves no shell or file tools (MCP tools are separate); ` +
    '--no-subagents, --disable-web-search; the project-scoped .grok/config.toml in the scratch ' +
    'dir supplies the MCP servers (--trust lets grok start them), on top of the user-level ones.',
  launch: (ctx) => ({
    args: [
      '--trust',
      '-p',
      ctx.prompt,
      '--output-format',
      'streaming-messages-json',
      '--cwd',
      ctx.cwd,
      '--max-turns',
      String(ctx.maxTurns),
      '--permission-mode',
      'bypassPermissions',
      '--no-subagents',
      '--disable-web-search',
      '--no-plan',
      '--tools',
      GROK_HARMLESS_TOOL,
      '--rules',
      ctx.systemPrompt
    ],
    files: [{ path: '.grok/config.toml', content: grokConfigToml(entries(ctx)) }],
    preRun: [],
    postRun: [],
    env: {},
    stdin: null
  })
}

const antigravity: CliProfile = {
  id: 'antigravity',
  label: 'Antigravity CLI (agy)',
  binary: 'agy',
  installHint: 'See https://antigravity.google  (agy update to upgrade)',
  minVersion: '1.2.0',
  verified: true,
  versionArgs: ['--version'],
  authCheck: {
    args: ['models'],
    status: ({ code, stdout, stderr }) => {
      const text = `${stdout}\n${stderr}`
      if (/sign in|login|not authenticated/i.test(text)) return 'missing'
      if (code === 0 && /\S/.test(stdout)) return 'ok'
      return code === 0 ? 'unknown' : 'missing'
    },
    fix: 'agy  (then sign in when prompted)'
  },
  parser: 'antigravity',
  sandboxNote:
    'agy has no per-run MCP config: the run registers its server in the user-level ' +
    'mcp_config.json before launching and removes it after. --sandbox restricts the terminal; ' +
    '--dangerously-skip-permissions is required for headless tool calls.',
  launch: (ctx) => {
    const list = entries(ctx)
    const add = (entry: McpServerEntry): string[] => {
      const args = ['mcp', 'add', '--type', entry.transport]
      for (const [k, v] of Object.entries(entry.headers ?? {})) args.push('--header', `${k}: ${v}`)
      for (const [k, v] of Object.entries(entry.env ?? {})) args.push('--env', `${k}=${v}`)
      args.push(entry.name)
      if (entry.transport === 'http') args.push(entry.url ?? '')
      else args.push('--', entry.command ?? '', ...(entry.args ?? []))
      return args
    }
    return {
      args: [
        '-p',
        foldedPrompt(ctx),
        '--output-format',
        'stream-json',
        '--print-timeout',
        `${Math.ceil(ctx.timeoutMs / 1000)}s`,
        '--disable-slash-commands',
        '--sandbox',
        '--dangerously-skip-permissions'
      ],
      files: [],
      preRun: list.map(add),
      postRun: list.map((entry) => ['mcp', 'remove', entry.name]),
      env: {},
      stdin: null
    }
  }
}

const gemini: CliProfile = {
  id: 'gemini',
  label: 'Gemini CLI',
  binary: 'gemini',
  installHint: 'npm install -g @google/gemini-cli',
  minVersion: '0.20.0',
  verified: false,
  versionArgs: ['--version'],
  authCheck: null,
  parser: 'messages',
  sandboxNote:
    'The scratch dir carries .gemini/settings.json with the MCP servers and an empty core tool ' +
    'list; --allowed-mcp-server-names limits MCP to the run servers. Output format not verified ' +
    'against a signed-in binary.',
  launch: (ctx) => ({
    args: [
      '-p',
      foldedPrompt(ctx),
      '-o',
      'stream-json',
      '--approval-mode',
      'yolo',
      '--allowed-mcp-server-names',
      ...entries(ctx).map((e) => e.name)
    ],
    files: [{ path: '.gemini/settings.json', content: geminiSettingsJson(entries(ctx)) }],
    preRun: [],
    postRun: [],
    env: { GEMINI_CLI_TRUST_WORKSPACE: 'true' },
    stdin: null
  })
}

const codex: CliProfile = {
  id: 'codex',
  label: 'Codex CLI',
  binary: 'codex',
  installHint: 'npm install -g @openai/codex',
  minVersion: '0.50.0',
  verified: false,
  versionArgs: ['--version'],
  authCheck: {
    args: ['login', 'status'],
    status: ({ code, stdout, stderr }) =>
      code === 0 && /logged in/i.test(`${stdout}${stderr}`)
        ? 'ok'
        : code === 0
          ? 'unknown'
          : 'missing',
    fix: 'codex login'
  },
  parser: 'codex',
  sandboxNote:
    '--sandbox read-only plus MCP servers passed as -c overrides; flag names taken from the ' +
    'Codex docs, not verified against an installed binary.',
  launch: (ctx) => ({
    args: [
      'exec',
      '--json',
      '--sandbox',
      'read-only',
      '--skip-git-repo-check',
      '-C',
      ctx.cwd,
      ...codexOverrides(entries(ctx)).flatMap((o) => ['-c', o]),
      foldedPrompt(ctx)
    ],
    files: [],
    preRun: [],
    postRun: [],
    env: {},
    stdin: null
  })
}

export const CLI_PROFILES: Record<Exclude<BackendId, 'custom-cli'>, CliProfile> = {
  'claude-code': claudeCode,
  grok,
  antigravity,
  gemini,
  codex
}

const PLACEHOLDERS = [
  '{prompt}',
  '{systemPrompt}',
  '{mcpUrl}',
  '{mcpToken}',
  '{mcpConfigFile}',
  '{cwd}',
  '{maxTurns}'
] as const

/** Split a command template on whitespace, honouring double quotes. */
export function splitCommandTemplate(template: string): string[] {
  const out: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  for (const match of template.matchAll(re)) out.push(match[1] ?? match[2] ?? match[3])
  return out
}

/** The user's own CLI: a template with placeholders, one of the known parsers. */
export function customProfile(config: CustomCliConfig): CliProfile {
  const parts = splitCommandTemplate(config.command)
  const binary = parts[0] ?? ''
  return {
    id: 'custom-cli',
    label: 'Custom CLI',
    binary,
    installHint: `Set a command template. Placeholders: ${PLACEHOLDERS.join(' ')}`,
    minVersion: null,
    verified: false,
    versionArgs: ['--version'],
    authCheck: null,
    parser: config.parser,
    sandboxNote: 'Whatever the template says; CollabDoc only sets the cwd to the scratch dir.',
    launch: (ctx) => {
      const token = ctx.doc.headers.Authorization?.replace(/^Bearer\s+/i, '') ?? ''
      const configFile =
        config.mcpConfigFormat === 'gemini-settings'
          ? '.gemini/settings.json'
          : config.mcpConfigFormat === 'grok-toml'
            ? '.grok/config.toml'
            : 'mcp.json'
      const replace = (arg: string): string =>
        arg
          .replaceAll('{prompt}', ctx.prompt)
          .replaceAll('{systemPrompt}', ctx.systemPrompt)
          .replaceAll('{mcpUrl}', ctx.doc.url)
          .replaceAll('{mcpToken}', token)
          .replaceAll('{mcpConfigFile}', configFile)
          .replaceAll('{cwd}', ctx.cwd)
          .replaceAll('{maxTurns}', String(ctx.maxTurns))
      const files: LaunchPlan['files'] = []
      const list = entries(ctx)
      if (config.mcpConfigFormat === 'claude-json')
        files.push({ path: configFile, content: claudeMcpJson(list) })
      if (config.mcpConfigFormat === 'gemini-settings')
        files.push({ path: configFile, content: geminiSettingsJson(list) })
      if (config.mcpConfigFormat === 'grok-toml')
        files.push({ path: configFile, content: grokConfigToml(list) })
      return {
        args: parts.slice(1).map(replace),
        files,
        preRun: [],
        postRun: [],
        env: {},
        stdin: null
      }
    }
  }
}

export function profileFor(id: BackendId, custom: CustomCliConfig): CliProfile {
  return id === 'custom-cli' ? customProfile(custom) : CLI_PROFILES[id]
}
