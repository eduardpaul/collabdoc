/**
 * Agent backends (17), the document MCP server (16) and external MCP
 * sources (18): the shapes that cross IPC between main and the renderer.
 *
 * Compiled for Node and the browser: no Node, Electron or React imports.
 */
import type { MutationErrorKind } from './types'

// ---- Backends (17) ---------------------------------------------------------

/**
 * A backend is a way to execute a run. Every built-in is a locally installed
 * CLI agent launched headlessly for one turn with CollabDoc's MCP server as
 * its only document access; `custom-cli` is a user-supplied command template.
 */
export type BackendId = 'claude-code' | 'codex' | 'grok' | 'antigravity' | 'gemini' | 'custom-cli'

export const BACKEND_IDS: readonly BackendId[] = [
  'claude-code',
  'codex',
  'grok',
  'antigravity',
  'gemini',
  'custom-cli'
]

export function isBackendId(value: unknown): value is BackendId {
  return typeof value === 'string' && (BACKEND_IDS as readonly string[]).includes(value)
}

export type AuthStatus = 'ok' | 'missing' | 'unknown'

/** What Detect found. `available` is "binary found, version accepted, auth not known bad". */
export type BackendAvailability = {
  id: BackendId
  label: string
  available: boolean
  path: string | null
  version: string | null
  minVersion: string | null
  auth: AuthStatus
  /** What the user should see when it is not available. */
  reason: string | null
  /** How to install when the binary is missing. */
  installHint: string
  /** Verified against a real binary at implementation time; false = flags are best knowledge. */
  verified: boolean
  checkedAt: number
}

/** The user's own command line for the `custom-cli` backend. */
export type CustomCliConfig = {
  /** Space-separated template; placeholders: {prompt} {systemPrompt} {mcpUrl} {mcpToken} {mcpConfigFile} {cwd} {maxTurns}. */
  command: string
  /** How to read stdout: `messages` (Claude/grok stream-json shape), `antigravity`, `codex`, or plain text. */
  parser: 'messages' | 'antigravity' | 'codex' | 'plain'
  /** Where the MCP server should be written for the process, if the CLI reads a file. */
  mcpConfigFormat: 'claude-json' | 'gemini-settings' | 'grok-toml' | 'none'
}

export const DEFAULT_CUSTOM_CLI: CustomCliConfig = {
  command: '',
  parser: 'plain',
  mcpConfigFormat: 'claude-json'
}

// ---- Runs (12 shell + 17) --------------------------------------------------

export type RunKind = 'ask' | 'mention' | 'review'

/** The persona a run acts as. Persisted in the renderer roster (13 will move it to main). */
export type RunPersona = {
  id: string
  name: string
  handle: string
  role: 'writer' | 'reviewer'
  color: string
  instructions: string
  skills: string[]
}

export type RunRequest = {
  docId: string
  docTitle: string
  kind: RunKind
  persona: RunPersona
  backendId: BackendId
  prompt: string
  /** External MCP sources (18) attached to the persona, by id. */
  sourceIds: string[]
  /** Optional context for mention/comment requests. */
  context?: { blockId?: string; threadId?: string; requestId?: string }
}

export type RunStatus = 'queued' | 'working' | 'done' | 'error' | 'cancelled' | 'limit'

/**
 * One tool call as the document saw it. Recorded by the MCP server when the
 * run's session handles `tools/call`, so it is complete no matter what the
 * CLI prints. External-source calls (18) are not visible here.
 */
export type RunStep = {
  at: number
  tool: string
  args: Record<string, unknown>
  ok: boolean
  error?: MutationErrorKind | 'unknown_tool' | 'rate_limited'
  summary: string
}

export type RunErrorKind =
  | 'not_available'
  | 'auth'
  | 'spawn'
  | 'exit'
  | 'timeout'
  | 'parse'
  | 'cancelled'
  | 'rejected'
  | 'unknown'

export type RunError = {
  kind: RunErrorKind
  message: string
  /** Last lines of stderr, newest last. */
  stderrTail: string[]
  exitCode: number | null
}

export type RunRecord = {
  runId: string
  docId: string
  agentId: string
  personaName: string
  backendId: BackendId
  kind: RunKind
  input: string
  startedAt: number
  endedAt: number | null
  status: RunStatus
  steps: RunStep[]
  writes: number
  /** The CLI's final assistant text. */
  summary: string
  /** Assistant text as it streams, newest last; capped. */
  transcript: string[]
  error: RunError | null
  /** What was launched, for the run log. Secrets redacted. */
  command: string
}

export type RunEvent =
  | { type: 'run'; record: RunRecord }
  | { type: 'text'; runId: string; text: string }
  | { type: 'step'; runId: string; step: RunStep }
  | { type: 'warning'; runId: string; message: string }

// ---- Document MCP server (16) ---------------------------------------------

export type McpClientRole = 'writer' | 'reviewer' | 'blocked'

export type McpConnectedClient = {
  sessionId: string
  name: string
  actorId: string
  role: 'writer' | 'reviewer'
  /** Set when the client is one of our own backend runs. */
  runId: string | null
  connectedAt: number
  calls: number
  rateLimited: boolean
}

export type McpServerState = {
  enabled: boolean
  running: boolean
  port: number | null
  url: string | null
  token: string | null
  error: string | null
  /** Client name → persisted consent. */
  clients: Record<string, McpClientRole>
  /** Clients that called in and are waiting for the user's choice. */
  pending: string[]
  connected: McpConnectedClient[]
}

// ---- External MCP sources (18) --------------------------------------------

export type McpSourceTransport = 'stdio' | 'http'

export type McpSourcePreset = 'microsoft-learn' | 'local-folder' | 'custom'

export type McpSourceTool = { name: string; description: string }

export type McpSourceHealth =
  | { status: 'unknown' }
  | { status: 'ok'; tools: McpSourceTool[]; checkedAt: number }
  | { status: 'error'; message: string; checkedAt: number }

/**
 * An external MCP server a persona may use. Header and env values are stored
 * as secrets in main; the renderer only ever sees `hasValue` / `masked`.
 */
export type McpSource = {
  id: string
  slug: string
  label: string
  preset: McpSourcePreset
  transport: McpSourceTransport
  command: string
  args: string[]
  /** Env names → masked value (main) / value (write only). */
  env: Record<string, SecretField>
  url: string
  headers: Record<string, SecretField>
  enabled: boolean
  /** When set, only these tools are exposed to agents. */
  toolAllowlist: string[] | null
  health: McpSourceHealth
}

export type SecretField = { hasValue: boolean; masked: string }

/** What the renderer sends when creating or editing a source. */
export type McpSourceInput = {
  id?: string
  label: string
  preset: McpSourcePreset
  transport: McpSourceTransport
  command?: string
  args?: string[]
  /** Values given here replace the stored secret; omit a key to keep it. */
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  enabled?: boolean
  toolAllowlist?: string[] | null
}

export const SOURCE_TOOL_PREFIX = 'src_'

/** The tool names a Local folder source may expose: reads only (AC-18.2). */
export const LOCAL_FOLDER_READ_TOOLS = [
  'read_file',
  'read_text_file',
  'list_directory',
  'search_files'
]

export const MICROSOFT_LEARN_URL = 'https://learn.microsoft.com/api/mcp'

/** Per-run limits the runtime enforces (12). */
export const RUN_LIMITS = {
  /** Wall clock for one run. */
  timeoutMs: 3 * 60 * 1000,
  /** Model/tool turns the CLI may take. */
  maxTurns: { writer: 24, reviewer: 12 },
  /** Write tool calls per run; the document keeps what was written. */
  maxWrites: 40,
  /** Assistant text kept in the run record. */
  maxTranscriptChars: 20_000,
  /** stderr lines kept on failure. */
  stderrTailLines: 20,
  /** Per-agent queue depth (AC-12.4). */
  maxQueue: 8,
  /** Global in-flight runs (AC-12.3). */
  maxParallel: 2,
  /** How fast a run may write before calls return `limit` (16). */
  maxWritesPerSecond: 20
} as const

export function slugify(label: string): string {
  let slug = ''
  for (const char of label.trim().toLowerCase()) {
    const ok = (char >= 'a' && char <= 'z') || (char >= '0' && char <= '9')
    if (ok) slug += char
    else if (!slug.endsWith('_') && slug.length > 0) slug += '_'
  }
  while (slug.endsWith('_')) slug = slug.slice(0, -1)
  return slug.slice(0, 24) || 'source'
}
