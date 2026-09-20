import { BrowserWindow, ipcMain } from 'electron'
import { isBackendId, type McpServerState } from '../../shared/agents'
import type { DocumentMcpServer } from './DocumentMcpServer'

export const MCP_STATE_CHANNEL = 'mcp:state'

export function broadcastMcpState(state: McpServerState): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(MCP_STATE_CHANNEL, state)
}

function fail(error: unknown): { ok: false; error: string } {
  return { ok: false, error: error instanceof Error ? error.message : 'Something went wrong' }
}

export function registerMcpIpc(server: DocumentMcpServer): void {
  ipcMain.handle('mcp:getState', () => ({ ok: true, state: server.state() }))

  ipcMain.handle('mcp:setEnabled', async (_event, enabled: unknown) => {
    try {
      return { ok: true, state: await server.setEnabled(enabled === true) }
    } catch (error) {
      return fail(error)
    }
  })

  ipcMain.handle('mcp:rotateToken', async () => {
    try {
      return { ok: true, state: await server.rotateToken() }
    } catch (error) {
      return fail(error)
    }
  })

  ipcMain.handle('mcp:setClientRole', async (_event, payload: unknown) => {
    const rec = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
    if (typeof rec.name !== 'string' || !rec.name) return fail(new Error('Client name is required'))
    if (rec.role !== 'writer' && rec.role !== 'reviewer' && rec.role !== 'blocked') {
      return fail(new Error('Role must be writer, reviewer or blocked'))
    }
    try {
      return { ok: true, state: await server.setClientRole(rec.name, rec.role) }
    } catch (error) {
      return fail(error)
    }
  })

  ipcMain.handle('mcp:forgetClient', async (_event, name: unknown) => {
    if (typeof name !== 'string' || !name) return fail(new Error('Client name is required'))
    try {
      return { ok: true, state: await server.forgetClient(name) }
    } catch (error) {
      return fail(error)
    }
  })

  ipcMain.handle('mcp:disconnectClient', async (_event, sessionId: unknown) => {
    if (typeof sessionId !== 'string' || !sessionId)
      return fail(new Error('Session id is required'))
    try {
      return { ok: true, state: await server.disconnectClient(sessionId) }
    } catch (error) {
      return fail(error)
    }
  })

  ipcMain.handle('mcp:setupCommand', (_event, backendId: unknown) => {
    if (!isBackendId(backendId)) return fail(new Error('Unknown backend'))
    return { ok: true, command: server.setupCommand(backendId) }
  })
}
