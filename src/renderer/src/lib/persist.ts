import type { Agent, LlmProvider, McpConnection, RecentDocument } from '../types'

const KEY = 'collabdoc.v1'

export type Persisted = {
  provider: LlmProvider
  mcp: McpConnection[]
  agents: Agent[]
}

export type LegacyRecent = RecentDocument & { content?: string }

export function loadPersisted(): Persisted | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Persisted & { recents?: unknown }
    if (!parsed || typeof parsed !== 'object') return null
    return {
      provider: parsed.provider,
      mcp: parsed.mcp,
      agents: parsed.agents
    }
  } catch {
    return null
  }
}

export function savePersisted(data: Persisted): void {
  const sanitized: Persisted = {
    provider: data.provider,
    mcp: data.mcp.map((item) => ({
      ...item,
      status: 'disconnected',
      error: undefined
    })),
    agents: data.agents.map((agent) => ({ ...agent, status: 'idle', invited: false }))
  }
  localStorage.setItem(KEY, JSON.stringify(sanitized))
}

/** Recents that still carry inline document content from pre-04 builds. */
export function takeLegacyRecents(): LegacyRecent[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as { recents?: LegacyRecent[] }
    const recents = Array.isArray(parsed.recents) ? parsed.recents : []
    const leftover = recents.filter((item) => typeof item.content === 'string' || item.path)
    if (parsed.recents) {
      delete parsed.recents
      localStorage.setItem(KEY, JSON.stringify(parsed))
    }
    return leftover
  } catch {
    return []
  }
}

export function localStorageHasDocumentContent(): boolean {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return false
    if (raw.includes('"content"')) {
      const parsed = JSON.parse(raw) as { recents?: Array<{ content?: unknown }> }
      return Boolean(parsed.recents?.some((item) => typeof item.content === 'string'))
    }
    return false
  } catch {
    return false
  }
}
