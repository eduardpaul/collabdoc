import type { Agent, LlmProvider, McpConnection, RecentDocument } from '../types'

const KEY = 'collabdoc.v1'

export type Persisted = {
  provider: LlmProvider
  mcp: McpConnection[]
  agents: Agent[]
  recents: RecentDocument[]
}

export function loadPersisted(): Persisted | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) {
      return null
    }
    const parsed = JSON.parse(raw) as Persisted
    if (!parsed || typeof parsed !== 'object') {
      return null
    }
    // Earlier builds stored the full document in each recent; content now
    // lives in the host, so drop it and keep only the listing.
    parsed.recents = (parsed.recents ?? []).map((item) => {
      const { content: _content, ...rest } = item as RecentDocument & { content?: unknown }
      void _content
      return rest
    })
    return parsed
  } catch {
    return null
  }
}

export function savePersisted(data: Persisted): void {
  const sanitized: Persisted = {
    ...data,
    mcp: data.mcp.map((item) => ({
      ...item,
      status: 'disconnected',
      error: undefined
    })),
    agents: data.agents.map((agent) => ({ ...agent, status: 'idle', invited: false }))
  }
  localStorage.setItem(KEY, JSON.stringify(sanitized))
}
