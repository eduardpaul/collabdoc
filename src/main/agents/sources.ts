import { mkdir, readFile, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import {
  StdioClientTransport,
  getDefaultEnvironment
} from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {
  LOCAL_FOLDER_READ_TOOLS,
  MICROSOFT_LEARN_URL,
  SOURCE_TOOL_PREFIX,
  slugify,
  type McpSource,
  type McpSourceHealth,
  type McpSourceInput,
  type McpSourceTool,
  type SecretField
} from '../../shared/agents'
import type { SourceEntry } from './cli-profiles'
import { maskSecret, type SecretStore } from './secrets'

/** What is written to disk: everything but secret values. */
type StoredSource = Omit<McpSource, 'env' | 'headers'> & {
  /** Names only; values live in the secret store. */
  envNames: string[]
  headerNames: string[]
}

export type SourceStoreOptions = {
  userData: string
  secrets: SecretStore
  probeTimeoutMs?: number
  log?: (message: string, detail?: unknown) => void
}

export type ResolvedSources = {
  entries: SourceEntry[]
  /** Sources that were asked for but cannot be used, for the run's warning steps (AC-18.6). */
  unavailable: Array<{ id: string; label: string; reason: string }>
}

const PROBE_TIMEOUT_MS = 20_000

/**
 * External MCP servers personas may use (18). Configured once, attached to
 * personas by id, and handed to a CLI backend run as extra MCP servers named
 * `src_<slug>` so their tools can never be confused with the document's.
 */
export class McpSourceStore {
  private readonly userData: string
  private readonly secrets: SecretStore
  private readonly probeTimeoutMs: number
  private readonly log: (message: string, detail?: unknown) => void
  private sources: StoredSource[] = []
  private loaded = false

  constructor(options: SourceStoreOptions) {
    this.userData = options.userData
    this.secrets = options.secrets
    this.probeTimeoutMs = options.probeTimeoutMs ?? PROBE_TIMEOUT_MS
    this.log = options.log ?? (() => {})
  }

  get file(): string {
    return join(this.userData, 'mcp-sources.json')
  }

  async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    await this.secrets.load()
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8')) as { sources?: unknown }
      this.sources = Array.isArray(raw.sources)
        ? raw.sources.map(sanitizeStored).filter((s): s is StoredSource => s !== null)
        : []
    } catch {
      this.sources = []
    }
  }

  list(): McpSource[] {
    return this.sources.map((s) => this.view(s))
  }

  get(id: string): McpSource | null {
    const stored = this.sources.find((s) => s.id === id)
    return stored ? this.view(stored) : null
  }

  async upsert(input: McpSourceInput): Promise<McpSource> {
    await this.load()
    const existing = input.id ? this.sources.find((s) => s.id === input.id) : undefined
    const id = existing?.id ?? input.id ?? `src_${crypto.randomUUID().slice(0, 8)}`
    const label = input.label.trim() || existing?.label || 'Source'
    const preset = input.preset
    const stored: StoredSource = {
      id,
      slug:
        existing?.slug ??
        uniqueSlug(
          slugify(label),
          this.sources.map((s) => s.slug)
        ),
      label,
      preset,
      transport: input.transport,
      command: input.command?.trim() ?? existing?.command ?? '',
      args: input.args ?? existing?.args ?? [],
      url: input.url?.trim() ?? existing?.url ?? '',
      enabled: input.enabled ?? existing?.enabled ?? false,
      toolAllowlist:
        input.toolAllowlist !== undefined
          ? input.toolAllowlist
          : (existing?.toolAllowlist ??
            (preset === 'local-folder' ? [...LOCAL_FOLDER_READ_TOOLS] : null)),
      health: existing?.health ?? { status: 'unknown' },
      envNames: existing?.envNames ?? [],
      headerNames: existing?.headerNames ?? []
    }
    // A Local folder source is always the filesystem server on exactly the chosen directory,
    // pinned to its read tools (AC-18.2).
    if (preset === 'local-folder') {
      stored.transport = 'stdio'
      stored.command = 'npx'
      const dir = input.args?.[0] ?? existing?.args?.at(-1) ?? ''
      stored.args = ['-y', '@modelcontextprotocol/server-filesystem', dir]
      stored.toolAllowlist = [...LOCAL_FOLDER_READ_TOOLS]
    }
    if (preset === 'microsoft-learn') {
      stored.transport = 'http'
      stored.url = MICROSOFT_LEARN_URL
    }
    if (input.env) {
      for (const [name, value] of Object.entries(input.env)) {
        if (value === '') {
          await this.secrets.delete(secretKey(id, 'env', name))
          stored.envNames = stored.envNames.filter((n) => n !== name)
        } else {
          await this.secrets.set(secretKey(id, 'env', name), value)
          if (!stored.envNames.includes(name)) stored.envNames.push(name)
        }
      }
    }
    if (input.headers) {
      for (const [name, value] of Object.entries(input.headers)) {
        if (value === '') {
          await this.secrets.delete(secretKey(id, 'header', name))
          stored.headerNames = stored.headerNames.filter((n) => n !== name)
        } else {
          await this.secrets.set(secretKey(id, 'header', name), value)
          if (!stored.headerNames.includes(name)) stored.headerNames.push(name)
        }
      }
    }
    // Any change to how it connects invalidates what we knew about its tools.
    if (
      existing &&
      (existing.command !== stored.command ||
        existing.url !== stored.url ||
        existing.transport !== stored.transport ||
        existing.args.join('\u0000') !== stored.args.join('\u0000'))
    ) {
      stored.health = { status: 'unknown' }
    }
    if (existing) this.sources = this.sources.map((s) => (s.id === id ? stored : s))
    else this.sources.push(stored)
    await this.save()
    return this.view(stored)
  }

  async remove(id: string): Promise<void> {
    await this.load()
    // Secrets first: when the secret store refuses (unreadable), the source stays listed.
    await this.secrets.deletePrefix(`source:${id}:`)
    this.sources = this.sources.filter((s) => s.id !== id)
    await this.save()
  }

  /** Connect once, list tools, disconnect: the Settings "Refresh tools" (AC-18.1, AC-18.6). */
  async refresh(id: string): Promise<McpSource> {
    await this.load()
    const stored = this.sources.find((s) => s.id === id)
    if (!stored) throw new Error('Unknown source')
    let health: McpSourceHealth
    try {
      const tools = await this.probe(stored)
      health = { status: 'ok', tools, checkedAt: Date.now() }
    } catch (error) {
      this.log(`source ${stored.label} failed its check`, error)
      health = {
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
        checkedAt: Date.now()
      }
    }
    stored.health = health
    await this.save()
    return this.view(stored)
  }

  /**
   * The MCP server entries a run should get for these source ids: enabled
   * ones with their real secret values; the rest explained in `unavailable`.
   */
  resolveForRun(ids: string[]): ResolvedSources {
    const entries: SourceEntry[] = []
    const unavailable: ResolvedSources['unavailable'] = []
    for (const id of ids) {
      const stored = this.sources.find((s) => s.id === id)
      if (!stored) {
        unavailable.push({ id, label: id, reason: 'source no longer exists' })
        continue
      }
      if (!stored.enabled) {
        unavailable.push({ id, label: stored.label, reason: 'source is disabled' })
        continue
      }
      if (stored.health.status === 'error') {
        unavailable.push({
          id,
          label: stored.label,
          reason: `last check failed: ${stored.health.message}`
        })
        continue
      }
      const name = `${SOURCE_TOOL_PREFIX}${stored.slug}`
      if (stored.transport === 'http') {
        if (!stored.url) {
          unavailable.push({ id, label: stored.label, reason: 'no URL configured' })
          continue
        }
        entries.push({
          name,
          transport: 'http',
          url: stored.url,
          headers: this.secretValues(stored.id, 'header', stored.headerNames),
          toolAllowlist: stored.toolAllowlist
        })
      } else {
        if (!stored.command) {
          unavailable.push({ id, label: stored.label, reason: 'no command configured' })
          continue
        }
        entries.push({
          name,
          transport: 'stdio',
          command: stored.command,
          args: stored.args,
          env: this.secretValues(stored.id, 'env', stored.envNames),
          toolAllowlist: stored.toolAllowlist
        })
      }
    }
    return { entries, unavailable }
  }

  private async probe(stored: StoredSource): Promise<McpSourceTool[]> {
    const client = new Client({ name: 'collabdoc', version: '0.1.0' })
    const transport =
      stored.transport === 'http'
        ? new StreamableHTTPClientTransport(new URL(stored.url), {
            requestInit: { headers: this.secretValues(stored.id, 'header', stored.headerNames) }
          })
        : new StdioClientTransport({
            command: stored.command,
            args: stored.args,
            env: {
              ...getDefaultEnvironment(),
              ...this.secretValues(stored.id, 'env', stored.envNames)
            },
            stderr: 'pipe'
          })
    const timer = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`No answer after ${this.probeTimeoutMs / 1000} s`)),
        this.probeTimeoutMs
      )
    )
    try {
      await Promise.race([client.connect(transport), timer])
      const { tools } = await Promise.race([client.listTools(), timer])
      return tools.map((t) => ({ name: t.name, description: t.description ?? '' }))
    } finally {
      await client.close().catch(() => undefined)
      await transport.close().catch(() => undefined)
    }
  }

  private secretValues(
    id: string,
    kind: 'env' | 'header',
    names: string[]
  ): Record<string, string> {
    const out: Record<string, string> = {}
    for (const name of names) {
      const value = this.secrets.get(secretKey(id, kind, name))
      if (value !== undefined) out[name] = value
    }
    return out
  }

  private view(stored: StoredSource): McpSource {
    const field = (kind: 'env' | 'header', name: string): SecretField => {
      const value = this.secrets.get(secretKey(stored.id, kind, name))
      return { hasValue: value !== undefined, masked: value ? maskSecret(value) : '' }
    }
    const { envNames, headerNames, ...rest } = stored
    return {
      ...rest,
      env: Object.fromEntries(envNames.map((n) => [n, field('env', n)])),
      headers: Object.fromEntries(headerNames.map((n) => [n, field('header', n)]))
    }
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true })
    await writeFile(this.file, JSON.stringify({ sources: this.sources }, null, 2), 'utf8')
  }
}

function secretKey(id: string, kind: 'env' | 'header', name: string): string {
  return `source:${id}:${kind}:${name}`
}

function uniqueSlug(base: string, taken: string[]): string {
  if (!taken.includes(base)) return base
  for (let n = 2; n < 1000; n += 1) if (!taken.includes(`${base}_${n}`)) return `${base}_${n}`
  return `${base}_${Date.now()}`
}

function sanitizeStored(raw: unknown): StoredSource | null {
  if (!raw || typeof raw !== 'object') return null
  const rec = raw as Record<string, unknown>
  if (typeof rec.id !== 'string' || typeof rec.label !== 'string') return null
  const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
  const health = (rec.health ?? { status: 'unknown' }) as McpSourceHealth
  return {
    id: rec.id,
    slug: typeof rec.slug === 'string' ? rec.slug : slugify(rec.label),
    label: rec.label,
    preset:
      rec.preset === 'microsoft-learn' || rec.preset === 'local-folder' ? rec.preset : 'custom',
    transport: rec.transport === 'stdio' ? 'stdio' : 'http',
    command: typeof rec.command === 'string' ? rec.command : '',
    args: strings(rec.args),
    url: typeof rec.url === 'string' ? rec.url : '',
    enabled: rec.enabled === true,
    toolAllowlist: Array.isArray(rec.toolAllowlist) ? strings(rec.toolAllowlist) : null,
    health:
      health && typeof health === 'object' && 'status' in health ? health : { status: 'unknown' },
    envNames: strings(rec.envNames),
    headerNames: strings(rec.headerNames)
  }
}
