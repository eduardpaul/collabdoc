import { randomUUID } from 'crypto'
import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse
} from 'http'
import type { AddressInfo } from 'net'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  isInitializeRequest,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  type CallToolResult,
  type Tool
} from '@modelcontextprotocol/sdk/types.js'
import { readMeta } from '../../core/document'
import { documentToMarkdown } from '../../core/markdown'
import type { DocumentRegistry } from '../../core/registry'
import type { SyncHub } from '../../core/hub'
import { DocumentSession } from '../../core/session'
import { outline } from '../../core/tree'
import type {
  BackendId,
  McpClientRole,
  McpConnectedClient,
  McpServerState,
  RunStep
} from '../../shared/agents'
import { RUN_LIMITS, slugify } from '../../shared/agents'
import { colorForId } from '../../shared/actors'
import { DOCUMENT_WRITE_TOOLS, TOOL_DEFINITIONS, toolsForRole } from '../../shared/tools'
import type { ActorProfile, MutationErrorKind, ToolName } from '../../shared/types'
import { isMutationResult } from '../../core/tools/context'
import { newToken, readMcpConfig, writeMcpConfig, type McpConfig } from './config'

export const MCP_PATH = '/mcp'
export const RUN_HEADER = 'x-collabdoc-run'
export const SERVER_NAME = 'collabdoc'
export const SERVER_VERSION = '0.1.0'

/** An agent run (17) the runtime announced before launching its CLI. */
export type RunBinding = {
  runId: string
  docId: string
  actor: ActorProfile
  role: 'writer' | 'reviewer'
  onStep?: (step: RunStep) => void
}

type McpSessionEntry = {
  sessionId: string
  transport: StreamableHTTPServerTransport
  server: Server
  /** Bound at initialize; external clients are identified by `clientInfo.name`. */
  identity: SessionIdentity
  /** One document session per (client, document). */
  docs: Map<string, DocumentSession>
  connectedAt: number
  calls: number
  writeStamps: number[]
  rateLimited: boolean
}

type SessionIdentity =
  { kind: 'run'; binding: RunBinding } | { kind: 'external'; name: string; actorId: string }

export type DocumentMcpServerOptions = {
  registry: DocumentRegistry
  userData: string
  onState?: (state: McpServerState) => void
  /** Called when a client not yet approved calls in (AC-16.4). */
  onPending?: (clientName: string) => void
  log?: (message: string, detail?: unknown) => void
}

const TOOL_LIMITS = { maxWritesPerSecond: RUN_LIMITS.maxWritesPerSecond }

/**
 * The open documents' tool surface as an MCP server (16).
 *
 * Streamable HTTP on loopback with a per-launch bearer token; each MCP
 * session is one actor with its own `DocumentSession` per document, so
 * attribution, role gating, undo and rate limits fall out of the core.
 * Agent runs (17) pre-register a binding and identify themselves with a run
 * header; everything else is an external client (the user's own Claude
 * Code, Codex, grok…) that needs the user's consent once per client name.
 */
export class DocumentMcpServer {
  private readonly registry: DocumentRegistry
  private readonly userData: string
  private readonly onState?: (state: McpServerState) => void
  private readonly onPending?: (clientName: string) => void
  private readonly log: (message: string, detail?: unknown) => void
  private config: McpConfig | null = null
  private http: HttpServer | null = null
  private port: number | null = null
  private error: string | null = null
  private readonly sessions = new Map<string, McpSessionEntry>()
  private readonly runs = new Map<string, RunBinding>()
  private readonly pending = new Set<string>()
  /** Which hub each document session was built on, to notice a reopened document. */
  private readonly hubs = new WeakMap<DocumentSession, SyncHub>()

  constructor(options: DocumentMcpServerOptions) {
    this.registry = options.registry
    this.userData = options.userData
    this.onState = options.onState
    this.onPending = options.onPending
    this.log = options.log ?? (() => {})
  }

  /** Load the persisted switch and start when it is on. */
  async init(): Promise<McpServerState> {
    this.config = await readMcpConfig(this.userData)
    if (this.config.enabled) await this.start()
    return this.state()
  }

  async setEnabled(enabled: boolean): Promise<McpServerState> {
    const config = await this.loaded()
    config.enabled = enabled
    await writeMcpConfig(this.userData, config)
    if (enabled) await this.start()
    else await this.stop()
    return this.state()
  }

  /** Bind now regardless of the persisted switch (runs need the server up). */
  async start(): Promise<McpServerState> {
    await this.loaded()
    if (this.http) return this.state()
    this.error = null
    const server = createServer((req, res) => {
      void this.handle(req, res).catch((error) => {
        this.log('mcp request failed', error)
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' })
          res.end(JSON.stringify(rpcError(-32603, 'Internal error')))
        }
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', (error) => {
        this.error = error.message
        reject(error)
      })
      server.listen(0, '127.0.0.1', () => resolve())
    })
    this.http = server
    this.port = (server.address() as AddressInfo).port
    this.log(`mcp server listening on 127.0.0.1:${this.port}`)
    this.emit()
    return this.state()
  }

  async stop(): Promise<void> {
    for (const entry of [...this.sessions.values()]) await this.closeSession(entry)
    const server = this.http
    this.http = null
    this.port = null
    if (server) {
      await new Promise<void>((resolve) => {
        server.closeAllConnections?.()
        server.close(() => resolve())
      })
    }
    this.emit()
  }

  get running(): boolean {
    return this.http !== null
  }

  get url(): string | null {
    return this.port ? `http://127.0.0.1:${this.port}${MCP_PATH}` : null
  }

  get token(): string | null {
    return this.config?.token ?? null
  }

  async rotateToken(): Promise<McpServerState> {
    const config = await this.loaded()
    config.token = newToken()
    await writeMcpConfig(this.userData, config)
    for (const entry of [...this.sessions.values()]) await this.closeSession(entry)
    this.emit()
    return this.state()
  }

  async setClientRole(name: string, role: McpClientRole): Promise<McpServerState> {
    const config = await this.loaded()
    config.clients[name] = role
    await writeMcpConfig(this.userData, config)
    this.pending.delete(name)
    // Existing sessions of that client pick the new role up on their next call.
    for (const entry of this.sessions.values()) {
      if (entry.identity.kind === 'external' && entry.identity.name === name) {
        for (const session of entry.docs.values()) session.dispose()
        entry.docs.clear()
      }
    }
    this.emit()
    return this.state()
  }

  async forgetClient(name: string): Promise<McpServerState> {
    const config = await this.loaded()
    delete config.clients[name]
    await writeMcpConfig(this.userData, config)
    this.emit()
    return this.state()
  }

  /** Announce a run so its CLI can identify itself with `RUN_HEADER`. Returns the headers. */
  registerRun(binding: RunBinding): Record<string, string> {
    this.runs.set(binding.runId, binding)
    return {
      Authorization: `Bearer ${this.config?.token ?? ''}`,
      'X-CollabDoc-Run': binding.runId
    }
  }

  /** End a run: drop its binding and every MCP session that used it (AC-17.5). */
  async releaseRun(runId: string): Promise<void> {
    this.runs.delete(runId)
    for (const entry of [...this.sessions.values()]) {
      if (entry.identity.kind === 'run' && entry.identity.binding.runId === runId) {
        await this.closeSession(entry)
      }
    }
    this.emit()
  }

  /** MCP sessions currently bound to a run — should be 0 after release. */
  sessionsForRun(runId: string): number {
    let n = 0
    for (const entry of this.sessions.values()) {
      if (entry.identity.kind === 'run' && entry.identity.binding.runId === runId) n += 1
    }
    return n
  }

  async disconnectClient(sessionId: string): Promise<McpServerState> {
    const entry = this.sessions.get(sessionId)
    if (entry) await this.closeSession(entry)
    this.emit()
    return this.state()
  }

  state(): McpServerState {
    const connected: McpConnectedClient[] = [...this.sessions.values()].map((entry) => ({
      sessionId: entry.sessionId,
      name: entry.identity.kind === 'run' ? entry.identity.binding.actor.name : entry.identity.name,
      actorId:
        entry.identity.kind === 'run'
          ? entry.identity.binding.actor.actorId
          : entry.identity.actorId,
      role: this.roleOf(entry) ?? 'writer',
      runId: entry.identity.kind === 'run' ? entry.identity.binding.runId : null,
      connectedAt: entry.connectedAt,
      calls: entry.calls,
      rateLimited: entry.rateLimited
    }))
    return {
      enabled: this.config?.enabled ?? false,
      running: this.running,
      port: this.port,
      url: this.url,
      token: this.config?.token ?? null,
      error: this.error,
      clients: { ...(this.config?.clients ?? {}) },
      pending: [...this.pending],
      connected
    }
  }

  /** The one-liner a user pastes to connect their own CLI to this server (16). */
  setupCommand(backend: BackendId): string {
    const url = this.url ?? 'http://127.0.0.1:<port>/mcp'
    const token = this.config?.token ?? '<token>'
    const header = `Authorization: Bearer ${token}`
    switch (backend) {
      case 'claude-code':
        return `claude mcp add --transport http collabdoc ${url} --header "${header}"`
      case 'codex':
        return `codex mcp add collabdoc --url ${url} --bearer-token ${token}`
      case 'grok':
        return `grok mcp add --transport http -H "${header}" collabdoc ${url}`
      case 'antigravity':
        return `agy mcp add --type http --header "${header}" collabdoc ${url}`
      case 'gemini':
        return `gemini mcp add --scope user --transport http -H "${header}" collabdoc ${url}`
      default:
        return `${url}\n${header}`
    }
  }

  // ---- HTTP -----------------------------------------------------------------

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname !== MCP_PATH) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify(rpcError(-32000, 'Not found')))
      return
    }
    if (!this.authorized(req)) {
      res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer' })
      res.end(JSON.stringify(rpcError(-32001, 'Unauthorized: missing or invalid bearer token')))
      return
    }
    const sessionId = header(req, 'mcp-session-id')
    if (sessionId) {
      const entry = this.sessions.get(sessionId)
      if (!entry) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify(rpcError(-32001, 'Session not found')))
        return
      }
      if (
        entry.identity.kind === 'run' &&
        header(req, RUN_HEADER) !== entry.identity.binding.runId
      ) {
        res.writeHead(403, { 'content-type': 'application/json' })
        res.end(JSON.stringify(rpcError(-32001, 'Run header does not match this session')))
        return
      }
      await entry.transport.handleRequest(req, res)
      return
    }
    if (req.method !== 'POST') {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify(rpcError(-32000, 'Bad request: no session')))
      return
    }
    const body = await readJson(req)
    if (!isInitializeRequest(body)) {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify(rpcError(-32000, 'Bad request: expected initialize')))
      return
    }
    const runId = header(req, RUN_HEADER)
    let identity: SessionIdentity
    if (runId) {
      const binding = this.runs.get(runId)
      if (!binding) {
        res.writeHead(403, { 'content-type': 'application/json' })
        res.end(JSON.stringify(rpcError(-32001, 'Unknown run')))
        return
      }
      identity = { kind: 'run', binding }
    } else {
      const name = clientNameOf(body)
      identity = { kind: 'external', name, actorId: `mcp:${slugify(name)}` }
    }
    const entry = this.createSession(identity)
    await entry.transport.handleRequest(req, res, body)
  }

  private authorized(req: IncomingMessage): boolean {
    const token = this.config?.token
    if (!token) return false
    const value = (header(req, 'authorization') ?? '').trim()
    if (!/^bearer /i.test(value)) return false
    return timingSafeEqual(value.slice('bearer '.length).trim(), token)
  }

  private createSession(identity: SessionIdentity): McpSessionEntry {
    const entry: McpSessionEntry = {
      sessionId: '',
      transport: null as unknown as StreamableHTTPServerTransport,
      server: null as unknown as Server,
      identity,
      docs: new Map(),
      connectedAt: Date.now(),
      calls: 0,
      writeStamps: [],
      rateLimited: false
    }
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId) => {
        entry.sessionId = sessionId
        this.sessions.set(sessionId, entry)
        this.emit()
      },
      onsessionclosed: () => {
        void this.closeSession(entry)
      }
    })
    transport.onclose = () => {
      if (entry.sessionId) this.sessions.delete(entry.sessionId)
      for (const session of entry.docs.values()) session.dispose()
      entry.docs.clear()
      this.emit()
    }
    const server = new Server(
      { name: SERVER_NAME, version: SERVER_VERSION },
      {
        capabilities: { tools: {}, resources: {}, prompts: {} },
        instructions: this.instructions(identity)
      }
    )
    server.oninitialized = () => {
      // The client name is only known after initialize; refine the identity.
      if (entry.identity.kind === 'external') {
        const name = server.getClientVersion()?.name?.trim() || entry.identity.name
        entry.identity = { kind: 'external', name, actorId: `mcp:${slugify(name)}` }
      }
      this.emit()
    }
    this.install(server, entry)
    entry.transport = transport
    entry.server = server
    void server.connect(transport)
    return entry
  }

  private async closeSession(entry: McpSessionEntry): Promise<void> {
    if (entry.sessionId) this.sessions.delete(entry.sessionId)
    for (const session of entry.docs.values()) session.dispose()
    entry.docs.clear()
    try {
      await entry.transport.close()
    } catch {
      /* already closed */
    }
  }

  // ---- MCP handlers -----------------------------------------------------------

  private install(server: Server, entry: McpSessionEntry): void {
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: this.toolsFor(entry)
    }))

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: rawArgs } = request.params
      const args = (rawArgs ?? {}) as Record<string, unknown>
      entry.calls += 1
      return this.callTool(entry, name, args)
    })

    server.setRequestHandler(ListResourcesRequestSchema, async () => ({
      resources: this.openDocs().flatMap((doc) => [
        {
          uri: `collabdoc://doc/${doc.docId}`,
          name: doc.title || 'Untitled',
          description: 'The document as Markdown (read-only).',
          mimeType: 'text/markdown'
        },
        {
          uri: `collabdoc://doc/${doc.docId}/outline`,
          name: `${doc.title || 'Untitled'} — outline`,
          description: 'Block ids, types and previews.',
          mimeType: 'application/json'
        }
      ])
    }))

    server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const match = /^collabdoc:\/\/doc\/([^/]+)(\/outline)?$/.exec(request.params.uri)
      const doc = match ? this.registry.get(match[1]) : undefined
      if (!match || !doc) throw new Error(`Unknown resource: ${request.params.uri}`)
      if (match[2]) {
        return {
          contents: [
            {
              uri: request.params.uri,
              mimeType: 'application/json',
              text: JSON.stringify({ blocks: outline(doc.hub.doc) }, null, 2)
            }
          ]
        }
      }
      return {
        contents: [
          {
            uri: request.params.uri,
            mimeType: 'text/markdown',
            text: documentToMarkdown(doc.hub.doc)
          }
        ]
      }
    })

    server.setRequestHandler(ListPromptsRequestSchema, async () => ({
      prompts: [
        {
          name: 'review-document',
          description: 'Read the open document and leave comments on structure, claims and tone.',
          arguments: [{ name: 'docId', description: 'Document id (optional when one is open)' }]
        },
        {
          name: 'draft-section',
          description: 'Draft a new section in the open document from a short brief.',
          arguments: [
            { name: 'brief', description: 'What the section should cover', required: true },
            { name: 'docId', description: 'Document id (optional when one is open)' }
          ]
        }
      ]
    }))

    server.setRequestHandler(GetPromptRequestSchema, async (request) => {
      const args = request.params.arguments ?? {}
      const docHint = args.docId ? ` Document id: ${args.docId}.` : ''
      if (request.params.name === 'review-document') {
        return {
          messages: [
            {
              role: 'user',
              content: {
                type: 'text',
                text:
                  'Review the open CollabDoc document. Call get_document, read the blocks you ' +
                  'want to comment on with get_blocks, then use add_comment (quoting the exact ' +
                  'phrase) for each issue. Do not rewrite text.' +
                  docHint
              }
            }
          ]
        }
      }
      if (request.params.name === 'draft-section') {
        return {
          messages: [
            {
              role: 'user',
              content: {
                type: 'text',
                text:
                  `Draft a section covering: ${args.brief ?? ''}. Call get_document first, then ` +
                  'insert_blocks after the right block. Keep to schema-valid node types.' +
                  docHint
              }
            }
          ]
        }
      }
      throw new Error(`Unknown prompt: ${request.params.name}`)
    })
  }

  private toolsFor(entry: McpSessionEntry): Tool[] {
    const role = this.roleOf(entry) ?? 'writer'
    const allowed = new Set<string>(toolsForRole(role))
    const docTools: Tool[] = TOOL_DEFINITIONS.filter((t) => allowed.has(t.name)).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: withDocId(t.parameters)
    }))
    return [
      {
        name: 'list_documents',
        description:
          'List the documents open in CollabDoc: id and title. Call this first if you do not know the docId.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false }
      },
      {
        name: 'whoami',
        description: 'Who you are in the document: your actor id, name, handle and role.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false }
      },
      ...docTools
    ]
  }

  private async callTool(
    entry: McpSessionEntry,
    name: string,
    args: Record<string, unknown>
  ): Promise<CallToolResult> {
    if (name === 'list_documents') {
      return json({ documents: this.openDocs() })
    }
    const consent = this.consentOf(entry)
    if (consent === 'pending') {
      return json(
        {
          ok: false,
          error: 'forbidden',
          message:
            'Awaiting approval in CollabDoc. Ask the person to allow this client, then retry.'
        },
        true
      )
    }
    if (consent === 'blocked') {
      return json(
        { ok: false, error: 'forbidden', message: 'This client is blocked in CollabDoc.' },
        true
      )
    }
    if (name === 'whoami') {
      const actor = this.actorOf(entry)
      return json({ ...actor, role: this.roleOf(entry) })
    }
    const { docId, ...rest } = args
    const resolved = this.resolveDocId(entry, typeof docId === 'string' ? docId : undefined)
    if (!resolved.ok)
      return json({ ok: false, error: 'not_found', message: resolved.message }, true)
    const session = this.sessionFor(entry, resolved.docId)
    if (!session) {
      return json(
        { ok: false, error: 'not_found', message: `Document ${resolved.docId} is not open.` },
        true
      )
    }
    const isWrite = DOCUMENT_WRITE_TOOLS.has(name as ToolName)
    if (isWrite && this.overRate(entry)) {
      const step: RunStep = {
        at: Date.now(),
        tool: name,
        args: rest,
        ok: false,
        error: 'rate_limited',
        summary: `rate limit: more than ${TOOL_LIMITS.maxWritesPerSecond} writes/s`
      }
      this.record(entry, step)
      return json({ ok: false, error: 'limit', message: step.summary }, true)
    }
    const result = session.call(name, rest)
    const mutation = isMutationResult(result) ? result : null
    const ok = mutation ? mutation.ok : true
    const step: RunStep = {
      at: Date.now(),
      tool: name,
      args: rest,
      ok,
      error: mutation && !mutation.ok ? (mutation.error as MutationErrorKind) : undefined,
      summary: summarize(name, result)
    }
    this.record(entry, step)
    return json(result, !ok)
  }

  private record(entry: McpSessionEntry, step: RunStep): void {
    if (entry.identity.kind === 'run') entry.identity.binding.onStep?.(step)
  }

  private overRate(entry: McpSessionEntry): boolean {
    const now = Date.now()
    entry.writeStamps = entry.writeStamps.filter((t) => now - t < 1000)
    if (entry.writeStamps.length >= TOOL_LIMITS.maxWritesPerSecond) {
      if (!entry.rateLimited) {
        entry.rateLimited = true
        this.emit()
      }
      return true
    }
    entry.writeStamps.push(now)
    return false
  }

  private resolveDocId(
    entry: McpSessionEntry,
    docId: string | undefined
  ): { ok: true; docId: string } | { ok: false; message: string } {
    if (docId) return { ok: true, docId }
    if (entry.identity.kind === 'run') return { ok: true, docId: entry.identity.binding.docId }
    const open = this.registry.list()
    if (open.length === 1) return { ok: true, docId: open[0] }
    if (open.length === 0) return { ok: false, message: 'No document is open in CollabDoc.' }
    return {
      ok: false,
      message: `Pass docId. Open documents: ${this.openDocs()
        .map((d) => `${d.docId} (${d.title || 'Untitled'})`)
        .join(', ')}`
    }
  }

  /** The `DocumentSession` for this client and document; recreated if the doc was reopened. */
  private sessionFor(entry: McpSessionEntry, docId: string): DocumentSession | null {
    const doc = this.registry.get(docId)
    const cached = entry.docs.get(docId)
    if (cached && doc && this.hubs.get(cached) === doc.hub) return cached
    if (cached) {
      // The document was closed (and maybe reopened as a new hub): start over.
      cached.dispose()
      entry.docs.delete(docId)
    }
    if (!doc) return null
    const role = this.roleOf(entry) ?? 'writer'
    const session = new DocumentSession(doc.hub, this.actorOf(entry), {
      allowedTools: toolsForRole(role),
      enforceClaims: true
    })
    entry.docs.set(docId, session)
    this.hubs.set(session, doc.hub)
    return session
  }

  private actorOf(entry: McpSessionEntry): ActorProfile {
    if (entry.identity.kind === 'run') return entry.identity.binding.actor
    return {
      actorId: entry.identity.actorId,
      name: entry.identity.name,
      color: colorForId(entry.identity.actorId),
      role: 'agent',
      handle: slugify(entry.identity.name).replace(/_/g, '-').slice(0, 20)
    }
  }

  private roleOf(entry: McpSessionEntry): 'writer' | 'reviewer' | null {
    if (entry.identity.kind === 'run') return entry.identity.binding.role
    const stored = this.config?.clients[entry.identity.name]
    if (stored === 'writer' || stored === 'reviewer') return stored
    return null
  }

  private consentOf(entry: McpSessionEntry): 'ok' | 'pending' | 'blocked' {
    if (entry.identity.kind === 'run') return 'ok'
    const stored = this.config?.clients[entry.identity.name]
    if (stored === 'blocked') return 'blocked'
    if (stored === 'writer' || stored === 'reviewer') return 'ok'
    if (!this.pending.has(entry.identity.name)) {
      this.pending.add(entry.identity.name)
      this.onPending?.(entry.identity.name)
      this.emit()
    }
    return 'pending'
  }

  private openDocs(): Array<{ docId: string; title: string }> {
    return this.registry.list().map((docId) => {
      const entry = this.registry.get(docId)
      return { docId, title: entry ? readMeta(entry.hub.doc).title : '' }
    })
  }

  private instructions(identity: SessionIdentity): string {
    const who =
      identity.kind === 'run'
        ? `You are acting in CollabDoc as "${identity.binding.actor.name}" (${identity.binding.role}). Your document is ${identity.binding.docId}; docId can be omitted.`
        : 'You are an external agent editing a CollabDoc document. Call list_documents (or whoami) first; pass docId on every tool when more than one document is open.'
    return (
      `${who}\n\n` +
      'Workflow: get_document (outline with block ids) → get_blocks for the blocks you will ' +
      'touch → edit with locators (insert_text / replace_text / insert_blocks / update_block / ' +
      'delete_blocks) or comment (add_comment / reply_comment / resolve_comment). Every call is ' +
      'attributed to you and undoable by you (undo). Re-read a block before replacing text in it; ' +
      'a stale `view` or locator is refused with `conflict` / `invalid_locator`, not applied. ' +
      'Reviewers can only read and comment. Keep to schema-valid node types.'
    )
  }

  private emit(): void {
    this.onState?.(this.state())
  }

  private async loaded(): Promise<McpConfig> {
    if (!this.config) this.config = await readMcpConfig(this.userData)
    return this.config
  }
}

// ---- helpers -----------------------------------------------------------------

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()]
  return Array.isArray(value) ? value[0] : value
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const text = Buffer.concat(chunks).toString('utf8')
  try {
    return text ? JSON.parse(text) : null
  } catch {
    return null
  }
}

function clientNameOf(body: unknown): string {
  const params = (body as { params?: { clientInfo?: { name?: unknown } } }).params
  const name = params?.clientInfo?.name
  return typeof name === 'string' && name.trim() ? name.trim() : 'mcp-client'
}

function rpcError(code: number, message: string): unknown {
  return { jsonrpc: '2.0', error: { code, message }, id: null }
}

function json(value: unknown, isError = false): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], isError }
}

/** Every document tool takes an optional `docId`; the run's document is the default. */
function withDocId(parameters: Record<string, unknown>): Tool['inputSchema'] {
  const properties = (parameters.properties ?? {}) as Record<string, unknown>
  return {
    ...parameters,
    type: 'object',
    properties: {
      docId: { type: 'string', description: 'Document id; optional when only one is open.' },
      ...properties
    }
  } as Tool['inputSchema']
}

function summarize(name: string, result: unknown): string {
  if (isMutationResult(result)) return result.ok ? result.applied : result.message
  const rec = (result ?? {}) as Record<string, unknown>
  if (Array.isArray(rec.blocks)) return `${rec.blocks.length} block(s)`
  if (Array.isArray(rec.hits)) return `${rec.hits.length} hit(s)`
  if (Array.isArray(rec.actors)) return `${rec.actors.length} participant(s)`
  if (Array.isArray(rec.threads)) return `${rec.threads.length} thread(s)`
  if (rec.thread) return 'comment added'
  if (rec.reply) return 'reply added'
  return name
}
