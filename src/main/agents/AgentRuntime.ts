import { mkdir, readFile, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import type { DocumentRegistry } from '../../core/registry'
import { readMeta } from '../../core/document'
import {
  BACKEND_IDS,
  DEFAULT_CUSTOM_CLI,
  RUN_LIMITS,
  isBackendId,
  type BackendAvailability,
  type BackendId,
  type CustomCliConfig,
  type RunEvent,
  type RunRecord,
  type RunRequest,
  type RunStep
} from '../../shared/agents'
import { DOCUMENT_WRITE_TOOLS } from '../../shared/tools'
import type { ToolName } from '../../shared/types'
import type { DocumentMcpServer } from '../mcp/DocumentMcpServer'
import { CLI_PROFILES, DOC_SERVER_NAME, customProfile, type SourceEntry } from './cli-profiles'
import { CliBackend, type CliBackendOptions } from './CliBackend'
import { buildSystemPrompt } from './prompt'
import type { McpSourceStore } from './sources'

export type AgentRuntimeOptions = {
  registry: DocumentRegistry
  mcp: DocumentMcpServer
  sources: McpSourceStore
  userData: string
  onEvent: (event: RunEvent) => void
  backendOptions?: Partial<CliBackendOptions>
  limits?: Partial<typeof RUN_LIMITS>
  log?: (message: string, detail?: unknown) => void
}

type LiveRun = {
  record: RunRecord
  request: RunRequest
  controller: AbortController
  /** Set when the run stopped itself for a limit, to override the process outcome. */
  limitReason: string | null
}

/** Upper bound on how long quit waits for cancelled runs to exit and clean up. */
const DISPOSE_WAIT_MS = 3_000

/**
 * Runs personas on CLI backends (17) with 12's scheduling shell: a FIFO per
 * agent, a global in-flight cap, cancellation, limits and a run record
 * streamed to the renderer. The DeepAgents (in-process LLM) path plugs in
 * beside the CLI backends when 12 lands.
 */
export class AgentRuntime {
  private readonly registry: DocumentRegistry
  private readonly mcp: DocumentMcpServer
  private readonly sources: McpSourceStore
  private readonly userData: string
  private readonly onEvent: (event: RunEvent) => void
  private readonly backendOptions: Partial<CliBackendOptions>
  private readonly limits: typeof RUN_LIMITS
  private readonly log: (message: string, detail?: unknown) => void
  private readonly backends = new Map<BackendId, CliBackend>()
  private custom: CustomCliConfig = { ...DEFAULT_CUSTOM_CLI }
  private readonly runs = new Map<string, LiveRun>()
  private readonly queues = new Map<string, LiveRun[]>()
  /** Runs whose process may still be alive, so dispose can wait for them. */
  private readonly inFlightRuns = new Set<Promise<void>>()
  private inFlight = 0
  private disposed = false

  constructor(options: AgentRuntimeOptions) {
    this.registry = options.registry
    this.mcp = options.mcp
    this.sources = options.sources
    this.userData = options.userData
    this.onEvent = options.onEvent
    this.backendOptions = options.backendOptions ?? {}
    this.limits = { ...RUN_LIMITS, ...options.limits }
    this.log = options.log ?? (() => {})
    for (const id of BACKEND_IDS) {
      if (id === 'custom-cli') continue
      this.backends.set(
        id,
        new CliBackend(CLI_PROFILES[id], { userData: this.userData, ...this.backendOptions })
      )
    }
    this.backends.set(
      'custom-cli',
      new CliBackend(customProfile(this.custom), {
        userData: this.userData,
        ...this.backendOptions
      })
    )
  }

  async init(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.configFile, 'utf8')) as {
        custom?: Partial<CustomCliConfig>
      }
      if (raw.custom) this.setCustomCli({ ...DEFAULT_CUSTOM_CLI, ...raw.custom }, false)
    } catch {
      /* first launch */
    }
  }

  private get configFile(): string {
    return join(this.userData, 'backends.json')
  }

  get customCli(): CustomCliConfig {
    return { ...this.custom }
  }

  async setCustomCli(config: CustomCliConfig, persist = true): Promise<void> {
    this.custom = {
      command: config.command ?? '',
      parser: config.parser ?? 'plain',
      mcpConfigFormat: config.mcpConfigFormat ?? 'claude-json'
    }
    this.backends.set(
      'custom-cli',
      new CliBackend(customProfile(this.custom), {
        userData: this.userData,
        ...this.backendOptions
      })
    )
    if (persist) {
      await mkdir(dirname(this.configFile), { recursive: true })
      await writeFile(this.configFile, JSON.stringify({ custom: this.custom }, null, 2), 'utf8')
    }
  }

  /**
   * Detect every backend (cached for a minute unless forced). `onEach` fires
   * as soon as one answers, so a fast CLI shows up before a slow probe ends.
   */
  async listBackends(
    force = false,
    onEach?: (backend: BackendAvailability) => void
  ): Promise<BackendAvailability[]> {
    return Promise.all(
      [...this.backends.values()].map(async (b) => {
        const result = await b.detect(force)
        onEach?.(result)
        return result
      })
    )
  }

  async detect(id: BackendId, force = true): Promise<BackendAvailability> {
    const backend = this.backends.get(id)
    if (!backend) throw new Error(`Unknown backend ${id}`)
    return backend.detect(force)
  }

  /** Runs, newest first; optionally for one document. */
  listRuns(docId?: string): RunRecord[] {
    return [...this.runs.values()]
      .map((r) => snapshot(r.record))
      .filter((r) => !docId || r.docId === docId)
      .sort((a, b) => b.startedAt - a.startedAt)
  }

  getRun(runId: string): RunRecord | null {
    const live = this.runs.get(runId)
    return live ? snapshot(live.record) : null
  }

  /** Queue a run. Rejects (returns the record with `rejected`) when the agent's backlog is full. */
  run(request: RunRequest): RunRecord {
    if (this.disposed) throw new Error('Runtime disposed')
    if (!isBackendId(request.backendId))
      throw new Error(`Unknown backend ${String(request.backendId)}`)
    const runId = `run_${crypto.randomUUID().slice(0, 12)}`
    const record: RunRecord = {
      runId,
      docId: request.docId,
      agentId: request.persona.id,
      personaName: request.persona.name,
      backendId: request.backendId,
      kind: request.kind,
      input: request.prompt,
      startedAt: Date.now(),
      endedAt: null,
      status: 'queued',
      steps: [],
      writes: 0,
      summary: '',
      transcript: [],
      error: null,
      command: ''
    }
    const live: LiveRun = { record, request, controller: new AbortController(), limitReason: null }
    this.runs.set(runId, live)
    const queue = this.queues.get(request.persona.id) ?? []
    if (queue.length >= this.limits.maxQueue) {
      record.status = 'error'
      record.endedAt = Date.now()
      record.error = {
        kind: 'rejected',
        message: `${request.persona.name} already has ${queue.length} requests waiting. Try again later.`,
        stderrTail: [],
        exitCode: null
      }
      this.emit({ type: 'run', record })
      this.prune(record.docId)
      return snapshot(record)
    }
    queue.push(live)
    this.queues.set(request.persona.id, queue)
    this.emit({ type: 'run', record })
    this.pump()
    return snapshot(record)
  }

  cancel(runId: string): boolean {
    const live = this.runs.get(runId)
    if (!live) return false
    if (live.record.status === 'queued') {
      this.dequeue(live)
      this.finish(live, 'cancelled', {
        kind: 'cancelled',
        message: 'Cancelled before it started.',
        stderrTail: [],
        exitCode: null
      })
      return true
    }
    if (live.record.status === 'working') {
      live.controller.abort()
      return true
    }
    return false
  }

  /** Cancel every run of an agent (it was removed from the document, AC-12.10). */
  cancelAgent(agentId: string, docId?: string): void {
    for (const live of this.runs.values()) {
      if (live.record.agentId === agentId && (!docId || live.record.docId === docId)) {
        this.cancel(live.record.runId)
      }
    }
  }

  /**
   * Cancel everything and wait for the processes to be gone (AC-17.5). The
   * wait is bounded: SIGTERM, the kill grace, then SIGKILL, plus post-run steps.
   */
  async dispose(): Promise<void> {
    this.disposed = true
    for (const live of this.runs.values()) this.cancel(live.record.runId)
    const pending = [...this.inFlightRuns]
    if (pending.length === 0) return
    await Promise.race([
      Promise.allSettled(pending),
      new Promise<void>((resolve) => setTimeout(resolve, DISPOSE_WAIT_MS).unref?.())
    ])
  }

  // ---- scheduling ----------------------------------------------------------------

  private pump(): void {
    if (this.disposed) return
    while (this.inFlight < this.limits.maxParallel) {
      const next = this.nextQueued()
      if (!next) return
      this.dequeue(next)
      this.inFlight += 1
      const running = this.execute(next).finally(() => {
        this.inFlight -= 1
        this.inFlightRuns.delete(running)
        this.pump()
      })
      this.inFlightRuns.add(running)
    }
  }

  /** Oldest queued run whose agent has nothing in flight (one turn per agent at a time). */
  private nextQueued(): LiveRun | null {
    let best: LiveRun | null = null
    for (const [agentId, queue] of this.queues) {
      const head = queue[0]
      if (!head) continue
      if (this.agentBusy(agentId)) continue
      if (
        !best ||
        priority(head) < priority(best) ||
        (priority(head) === priority(best) && head.record.startedAt < best.record.startedAt)
      ) {
        best = head
      }
    }
    return best
  }

  private agentBusy(agentId: string): boolean {
    for (const live of this.runs.values()) {
      if (live.record.agentId === agentId && live.record.status === 'working') return true
    }
    return false
  }

  private dequeue(live: LiveRun): void {
    const queue = this.queues.get(live.record.agentId)
    if (!queue) return
    const index = queue.indexOf(live)
    if (index >= 0) queue.splice(index, 1)
    if (queue.length === 0) this.queues.delete(live.record.agentId)
  }

  private async execute(live: LiveRun): Promise<void> {
    const { record, request } = live
    const backend = this.backends.get(request.backendId)!
    record.status = 'working'
    record.startedAt = Date.now()
    this.emit({ type: 'run', record })

    const entry = this.registry.get(request.docId)
    if (!entry) {
      this.finish(live, 'error', {
        kind: 'unknown',
        message: 'The document is no longer open.',
        stderrTail: [],
        exitCode: null
      })
      return
    }
    try {
      await this.mcp.start()
    } catch (error) {
      this.finish(live, 'error', {
        kind: 'unknown',
        message: `The document MCP server could not start: ${error instanceof Error ? error.message : String(error)}`,
        stderrTail: [],
        exitCode: null
      })
      return
    }
    const persona = request.persona
    const headers = this.mcp.registerRun({
      runId: record.runId,
      docId: request.docId,
      actor: {
        actorId: persona.id,
        name: persona.name,
        color: persona.color,
        role: 'agent',
        handle: persona.handle
      },
      role: persona.role,
      onStep: (step) => this.onStep(live, step)
    })
    const resolved = this.sources.resolveForRun(request.sourceIds)
    for (const missing of resolved.unavailable) {
      this.emit({
        type: 'warning',
        runId: record.runId,
        message: `source ${missing.label} unavailable: ${missing.reason}`
      })
    }
    // A source pinned to some of its tools (AC-18.2) only goes to a CLI that can hold it to
    // them; otherwise it is left out rather than handed over with every tool.
    const usable = resolved.entries.filter((entry) => {
      if (!entry.toolAllowlist || backend.profile.restrictsSourceTools) return true
      this.emit({
        type: 'warning',
        runId: record.runId,
        message: `source ${labelOf(entry, this.sources)} skipped: ${backend.profile.label} cannot limit it to its allowed tools`
      })
      return false
    })
    // CLIs with one shared MCP config get per-run server names so the user's own entries survive.
    const suffix = backend.profile.runSuffix?.(record.runId) ?? ''
    const docServerName = `${DOC_SERVER_NAME}${suffix}`
    const sourceEntries: SourceEntry[] = usable.map((e) => ({ ...e, name: `${e.name}${suffix}` }))
    const sourceLabels = usable.map((e) => labelOf(e, this.sources))
    const maxTurns = this.limits.maxTurns[persona.role]
    const systemPrompt = buildSystemPrompt({
      persona,
      docTitle: request.docTitle || readMeta(entry.hub.doc).title || 'Untitled',
      docId: request.docId,
      serverName: docServerName,
      sources: sourceEntries.map((e, i) => ({
        name: e.name,
        label: sourceLabels[i],
        tools: e.toolAllowlist
      })),
      maxTurns
    })
    try {
      const outcome = await backend.run(
        {
          runId: record.runId,
          agentId: persona.id,
          prompt: request.prompt,
          systemPrompt,
          maxTurns,
          timeoutMs: this.limits.timeoutMs,
          doc: { name: docServerName, url: this.mcp.url!, headers },
          sources: sourceEntries,
          signal: live.controller.signal
        },
        {
          onSpawned: (_pid, command) => {
            record.command = command
            this.emit({ type: 'run', record })
          },
          onEvent: (event) => {
            if (event.type === 'text') {
              this.appendText(live, event.text, event.delta)
            } else if (event.type === 'result') {
              if (event.text) record.summary = event.text.trim().slice(0, 4000)
            } else if (event.type === 'tool_use' && !isDocumentTool(event.name, docServerName)) {
              // External tools (sources, or a CLI built-in that slipped through) are worth seeing.
              const step: RunStep = {
                at: Date.now(),
                tool: event.name,
                args: asRecord(event.input),
                ok: true,
                summary: 'external tool call'
              }
              record.steps.push(step)
              this.emit({ type: 'step', runId: record.runId, step })
            }
          },
          onStderr: (line) => this.log(`[${persona.name}] ${line}`)
        }
      )
      record.command = record.command || outcome.command
      if (live.limitReason) {
        this.finish(live, 'limit', {
          kind: 'unknown',
          message: live.limitReason,
          stderrTail: outcome.stderrTail,
          exitCode: outcome.exitCode
        })
      } else {
        this.finish(live, outcome.status, outcome.error)
      }
    } catch (error) {
      this.finish(live, 'error', {
        kind: 'unknown',
        message: error instanceof Error ? error.message : String(error),
        stderrTail: [],
        exitCode: null
      })
    } finally {
      await this.mcp.releaseRun(record.runId)
    }
  }

  private onStep(live: LiveRun, step: RunStep): void {
    const { record } = live
    record.steps.push(step)
    if (step.ok && DOCUMENT_WRITE_TOOLS.has(step.tool as ToolName)) {
      record.writes += 1
      if (record.writes >= this.limits.maxWrites && !live.limitReason) {
        live.limitReason = `Stopped after ${this.limits.maxWrites} writes in one run; the document keeps what was written.`
        live.controller.abort()
      }
    }
    this.emit({ type: 'step', runId: record.runId, step })
  }

  private appendText(live: LiveRun, text: string, delta: boolean): void {
    const { record } = live
    if (delta && record.transcript.length) {
      record.transcript[record.transcript.length - 1] += text
    } else {
      record.transcript.push(text)
    }
    let total = record.transcript.reduce((n, t) => n + t.length, 0)
    while (total > this.limits.maxTranscriptChars && record.transcript.length > 1) {
      total -= record.transcript.shift()!.length
    }
    this.emit({ type: 'text', runId: record.runId, text, delta })
  }

  private finish(live: LiveRun, status: RunRecord['status'], error: RunRecord['error']): void {
    const { record } = live
    if (record.endedAt !== null) return
    record.status = status
    record.endedAt = Date.now()
    record.error = status === 'done' ? null : error
    if (status === 'done' && !record.summary) {
      record.summary = record.transcript.at(-1)?.trim() ?? ''
    }
    this.emit({ type: 'run', record })
    this.prune(record.docId)
  }

  /** Keep the last `historyPerDocument` finished runs of a document; live ones always stay. */
  private prune(docId: string): void {
    const finished = [...this.runs.values()]
      .filter((r) => r.record.docId === docId && r.record.endedAt !== null)
      .sort((a, b) => b.record.endedAt! - a.record.endedAt!)
    for (const stale of finished.slice(this.limits.historyPerDocument)) {
      this.runs.delete(stale.record.runId)
    }
  }

  /** Events carry snapshots: batched IPC must not see later mutations of the live record. */
  private emit(event: RunEvent): void {
    this.onEvent(event.type === 'run' ? { type: 'run', record: snapshot(event.record) } : event)
  }
}

function snapshot(record: RunRecord): RunRecord {
  return {
    ...record,
    steps: record.steps.map((s) => ({ ...s, args: { ...s.args } })),
    transcript: [...record.transcript],
    error: record.error ? { ...record.error, stderrTail: [...record.error.stderrTail] } : null
  }
}

function priority(live: LiveRun): number {
  switch (live.request.kind) {
    case 'ask':
      return 0
    case 'mention':
      return 1
    default:
      return 2
  }
}

function isDocumentTool(name: string, serverName: string): boolean {
  return name.includes(`${serverName}__`) || name.startsWith(`${serverName}:`)
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function labelOf(entry: SourceEntry, sources: McpSourceStore): string {
  const slug = entry.name.replace(/^src_/, '')
  return sources.list().find((s) => s.slug === slug)?.label ?? entry.name
}
