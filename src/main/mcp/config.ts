import { randomBytes } from 'crypto'
import { mkdir, readFile, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import type { McpClientRole } from '../../shared/agents'

/** `userData/mcp.json`: the server switch, its bearer token and per-client consent (16). */
export type McpConfig = {
  enabled: boolean
  token: string
  clients: Record<string, McpClientRole>
}

export function mcpConfigPath(userData: string): string {
  return join(userData, 'mcp.json')
}

export function newToken(): string {
  return randomBytes(32).toString('hex')
}

export function defaultMcpConfig(): McpConfig {
  return { enabled: false, token: newToken(), clients: {} }
}

export function sanitizeMcpConfig(raw: unknown): McpConfig {
  const fallback = defaultMcpConfig()
  if (!raw || typeof raw !== 'object') return fallback
  const rec = raw as Record<string, unknown>
  const clients: Record<string, McpClientRole> = {}
  if (rec.clients && typeof rec.clients === 'object') {
    for (const [name, role] of Object.entries(rec.clients as Record<string, unknown>)) {
      if (role === 'writer' || role === 'reviewer' || role === 'blocked') clients[name] = role
    }
  }
  return {
    enabled: rec.enabled === true,
    token:
      typeof rec.token === 'string' && /^[a-f0-9]{64}$/.test(rec.token)
        ? rec.token
        : fallback.token,
    clients
  }
}

export async function readMcpConfig(userData: string): Promise<McpConfig> {
  try {
    return sanitizeMcpConfig(JSON.parse(await readFile(mcpConfigPath(userData), 'utf8')))
  } catch {
    return defaultMcpConfig()
  }
}

export async function writeMcpConfig(userData: string, config: McpConfig): Promise<void> {
  const file = mcpConfigPath(userData)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(config, null, 2), { encoding: 'utf8', mode: 0o600 })
}
