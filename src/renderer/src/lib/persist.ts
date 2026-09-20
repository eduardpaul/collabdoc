import { colorForId } from '@shared/actors'
import { isBackendId } from '@shared/agents'
import { handleFromName } from '@shared/handles'
import type { Agent, AgentProvider, LlmProvider, RecentDocument } from '../types'

const KEY = 'collabdoc.v1'

export type Persisted = {
  provider: LlmProvider
  agents: Agent[]
  /** Idle seconds before an agent request paragraph is sent on its own; 0 = off (10). */
  mentionAutoSendSeconds?: number
}

/** Pre-17 agents carried `routing: 'llm' | 'mcp'` and an `mcpId` naming a fake connection. */
type LegacyAgent = Partial<Agent> & {
  id?: string
  name?: string
  routing?: 'llm' | 'mcp'
  mcpId?: string | null
}

const LEGACY_MCP_BACKENDS: Record<string, AgentProvider> = {
  mcp_claude: { kind: 'backend', id: 'claude-code' },
  mcp_codex: { kind: 'backend', id: 'codex' }
}

function migrateProvider(agent: LegacyAgent): AgentProvider {
  const provider = agent.provider as AgentProvider | undefined
  if (provider?.kind === 'backend' && isBackendId(provider.id)) return provider
  if (provider?.kind === 'default') return provider
  if (agent.routing === 'mcp') return LEGACY_MCP_BACKENDS[agent.mcpId ?? ''] ?? { kind: 'default' }
  return { kind: 'default' }
}

/** Bring any stored agent up to the current shape (AC-17.10); drops unknown fields. */
export function migrateAgent(raw: unknown): Agent | null {
  if (!raw || typeof raw !== 'object') return null
  const agent = raw as LegacyAgent
  if (typeof agent.id !== 'string' || typeof agent.name !== 'string') return null
  return {
    id: agent.id,
    name: agent.name,
    handle:
      typeof agent.handle === 'string' && agent.handle ? agent.handle : handleFromName(agent.name),
    role: agent.role === 'reviewer' ? 'reviewer' : 'writer',
    color: typeof agent.color === 'string' && agent.color ? agent.color : colorForId(agent.id),
    persona: typeof agent.persona === 'string' ? agent.persona : '',
    skills: Array.isArray(agent.skills)
      ? agent.skills.filter((s): s is string => typeof s === 'string')
      : [],
    provider: migrateProvider(agent),
    sources: Array.isArray(agent.sources)
      ? agent.sources.filter((s): s is string => typeof s === 'string')
      : [],
    invited: false,
    status: 'idle'
  }
}

export type LegacyRecent = RecentDocument & { content?: string }

export function loadPersisted(): Persisted | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Persisted & { recents?: unknown; agents?: unknown }
    if (!parsed || typeof parsed !== 'object') return null
    return {
      provider: parsed.provider,
      agents: Array.isArray(parsed.agents)
        ? parsed.agents.map(migrateAgent).filter((a): a is Agent => a !== null)
        : [],
      mentionAutoSendSeconds:
        typeof parsed.mentionAutoSendSeconds === 'number' ? parsed.mentionAutoSendSeconds : 0
    }
  } catch {
    return null
  }
}

export function savePersisted(data: Persisted): void {
  const sanitized: Persisted = {
    provider: data.provider,
    agents: data.agents.map((agent) => ({ ...agent, status: 'idle', invited: false })),
    mentionAutoSendSeconds: data.mentionAutoSendSeconds ?? 0
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
