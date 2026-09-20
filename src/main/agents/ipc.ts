import { BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron'
import {
  isBackendId,
  type CustomCliConfig,
  type McpSourceInput,
  type RunEvent,
  type RunRequest
} from '../../shared/agents'
import type { AgentRuntime } from './AgentRuntime'
import type { SecretStore } from './secrets'
import type { McpSourceStore } from './sources'

export const AGENT_EVENTS_CHANNEL = 'agents:event'
export const BACKEND_CHANNEL = 'agents:backend'
/** Renderer batches: at most one message per 100 ms during a busy run (AC-12.9). */
const BATCH_MS = 100

function fail(error: unknown): { ok: false; error: string } {
  return { ok: false, error: error instanceof Error ? error.message : 'Something went wrong' }
}

/** Collects run events and flushes them to every window in batches. */
export function createEventBroadcaster(): { push: (event: RunEvent) => void; flush: () => void } {
  let pending: RunEvent[] = []
  let timer: ReturnType<typeof setTimeout> | null = null
  const flush = (): void => {
    timer = null
    if (pending.length === 0) return
    const batch = pending
    pending = []
    for (const win of BrowserWindow.getAllWindows())
      win.webContents.send(AGENT_EVENTS_CHANNEL, batch)
  }
  return {
    push: (event) => {
      pending.push(event)
      if (!timer) timer = setTimeout(flush, BATCH_MS)
    },
    flush
  }
}

function asRunRequest(payload: unknown): RunRequest | null {
  if (!payload || typeof payload !== 'object') return null
  const rec = payload as Record<string, unknown>
  const persona = rec.persona as Record<string, unknown> | undefined
  if (
    typeof rec.docId !== 'string' ||
    typeof rec.prompt !== 'string' ||
    !isBackendId(rec.backendId) ||
    !persona ||
    typeof persona.id !== 'string' ||
    typeof persona.name !== 'string' ||
    (persona.role !== 'writer' && persona.role !== 'reviewer')
  ) {
    return null
  }
  const kind = rec.kind === 'mention' || rec.kind === 'review' ? rec.kind : 'ask'
  const context =
    rec.context && typeof rec.context === 'object'
      ? (rec.context as RunRequest['context'])
      : undefined
  return {
    docId: rec.docId,
    docTitle: typeof rec.docTitle === 'string' ? rec.docTitle : '',
    kind,
    persona: {
      id: persona.id,
      name: persona.name,
      handle: typeof persona.handle === 'string' ? persona.handle : persona.name.toLowerCase(),
      role: persona.role,
      color: typeof persona.color === 'string' ? persona.color : '#2563eb',
      instructions: typeof persona.instructions === 'string' ? persona.instructions : '',
      skills: Array.isArray(persona.skills)
        ? persona.skills.filter((s): s is string => typeof s === 'string')
        : []
    },
    backendId: rec.backendId,
    prompt: rec.prompt.slice(0, 20_000),
    sourceIds: Array.isArray(rec.sourceIds)
      ? rec.sourceIds.filter((s): s is string => typeof s === 'string')
      : [],
    context
  }
}

export function registerAgentIpc(
  runtime: AgentRuntime,
  sources: McpSourceStore,
  secrets: SecretStore
): void {
  ipcMain.handle('agents:listBackends', async (_event, force: unknown) => {
    try {
      const backends = await runtime.listBackends(force === true, (backend) => {
        for (const win of BrowserWindow.getAllWindows())
          win.webContents.send(BACKEND_CHANNEL, backend)
      })
      return { ok: true, backends }
    } catch (error) {
      return fail(error)
    }
  })

  ipcMain.handle('agents:detect', async (_event, id: unknown) => {
    if (!isBackendId(id)) return fail(new Error('Unknown backend'))
    try {
      return { ok: true, backend: await runtime.detect(id) }
    } catch (error) {
      return fail(error)
    }
  })

  ipcMain.handle('agents:getCustomCli', () => ({ ok: true, config: runtime.customCli }))

  ipcMain.handle('agents:setCustomCli', async (_event, payload: unknown) => {
    const rec = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
    const config: CustomCliConfig = {
      command: typeof rec.command === 'string' ? rec.command : '',
      parser:
        rec.parser === 'messages' || rec.parser === 'antigravity' || rec.parser === 'codex'
          ? rec.parser
          : 'plain',
      mcpConfigFormat:
        rec.mcpConfigFormat === 'gemini-settings' ||
        rec.mcpConfigFormat === 'grok-toml' ||
        rec.mcpConfigFormat === 'none'
          ? rec.mcpConfigFormat
          : 'claude-json'
    }
    try {
      await runtime.setCustomCli(config)
      return { ok: true, config: runtime.customCli, backend: await runtime.detect('custom-cli') }
    } catch (error) {
      return fail(error)
    }
  })

  ipcMain.handle('agents:run', (_event, payload: unknown) => {
    const request = asRunRequest(payload)
    if (!request) return fail(new Error('Invalid run request'))
    try {
      return { ok: true, record: runtime.run(request) }
    } catch (error) {
      return fail(error)
    }
  })

  ipcMain.handle('agents:cancel', (_event, runId: unknown) => {
    if (typeof runId !== 'string') return fail(new Error('Run id is required'))
    return { ok: true, cancelled: runtime.cancel(runId) }
  })

  ipcMain.handle('agents:cancelAgent', (_event, payload: unknown) => {
    const rec = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
    if (typeof rec.agentId !== 'string') return fail(new Error('Agent id is required'))
    runtime.cancelAgent(rec.agentId, typeof rec.docId === 'string' ? rec.docId : undefined)
    return { ok: true }
  })

  ipcMain.handle('agents:listRuns', (_event, docId: unknown) => ({
    ok: true,
    runs: runtime.listRuns(typeof docId === 'string' ? docId : undefined)
  }))

  ipcMain.handle('sources:list', async () => {
    await sources.load()
    return { ok: true, sources: sources.list(), secretsUnencrypted: secrets.unencrypted }
  })

  ipcMain.handle('sources:upsert', async (_event, payload: unknown) => {
    const input = asSourceInput(payload)
    if (!input) return fail(new Error('Invalid source'))
    try {
      return { ok: true, source: await sources.upsert(input) }
    } catch (error) {
      return fail(error)
    }
  })

  ipcMain.handle('sources:remove', async (_event, id: unknown) => {
    if (typeof id !== 'string') return fail(new Error('Source id is required'))
    await sources.remove(id)
    return { ok: true }
  })

  ipcMain.handle('sources:refresh', async (_event, id: unknown) => {
    if (typeof id !== 'string') return fail(new Error('Source id is required'))
    try {
      return { ok: true, source: await sources.refresh(id) }
    } catch (error) {
      return fail(error)
    }
  })

  ipcMain.handle('sources:pickFolder', async (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return fail(new Error('No window'))
    const picked = await dialog.showOpenDialog(win, {
      title: 'Choose a folder agents may read',
      properties: ['openDirectory']
    })
    if (picked.canceled || !picked.filePaths[0]) return { ok: true, path: null }
    return { ok: true, path: picked.filePaths[0] }
  })
}

function asSourceInput(payload: unknown): McpSourceInput | null {
  if (!payload || typeof payload !== 'object') return null
  const rec = payload as Record<string, unknown>
  if (typeof rec.label !== 'string') return null
  const preset =
    rec.preset === 'microsoft-learn' || rec.preset === 'local-folder' ? rec.preset : 'custom'
  const strings = (value: unknown): string[] | undefined =>
    Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : undefined
  const stringMap = (value: unknown): Record<string, string> | undefined => {
    if (!value || typeof value !== 'object') return undefined
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>))
      if (typeof v === 'string') out[k] = v
    return out
  }
  return {
    id: typeof rec.id === 'string' ? rec.id : undefined,
    label: rec.label,
    preset,
    transport: rec.transport === 'stdio' ? 'stdio' : 'http',
    command: typeof rec.command === 'string' ? rec.command : undefined,
    args: strings(rec.args),
    env: stringMap(rec.env),
    url: typeof rec.url === 'string' ? rec.url : undefined,
    headers: stringMap(rec.headers),
    enabled: typeof rec.enabled === 'boolean' ? rec.enabled : undefined,
    toolAllowlist: rec.toolAllowlist === null ? null : strings(rec.toolAllowlist)
  }
}
