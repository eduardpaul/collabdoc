import { colorForId, USER_COLORS } from '@shared/actors'
import { createId } from '../lib/ids'
import type { Agent, AppState, LlmProvider } from '../types'

export const defaultProvider: LlmProvider = {
  enabled: false,
  kind: 'openai-compatible',
  label: 'OpenAI-compatible',
  endpoint: '',
  apiKey: '',
  model: ''
}

/**
 * The ids the two starter agents used to ship with. Every install had the
 * same ones, so two people's "Writer"s on one shared document merged into a
 * single participant — and an @mention meant for the other person's agent
 * would have started your own. Ids are per install now.
 */
export const LEGACY_DEFAULT_AGENT_IDS: Record<string, 'writer' | 'reviewer'> = {
  agent_writer: 'writer',
  agent_reviewer: 'reviewer'
}

/** `agent_<install>_writer`: unique across installs, stable across restarts. */
export function defaultAgentId(userId: string, role: 'writer' | 'reviewer'): string {
  return `agent_${
    userId
      .replace(/[^a-z0-9]/gi, '')
      .slice(0, 8)
      .toLowerCase() || 'local'
  }_${role}`
}

export function defaultAgents(userId: string): Agent[] {
  return [
    {
      id: defaultAgentId(userId, 'writer'),
      name: 'Writer',
      handle: 'writer',
      role: 'writer',
      color: USER_COLORS[2],
      persona:
        'Turns outlines into clear prose in the author voice. Attributes every insertion. Never silently overwrites.',
      skills: ['outline', 'draft', 'rewrite'],
      provider: { kind: 'default' },
      sources: [],
      invited: false,
      status: 'idle'
    },
    {
      id: defaultAgentId(userId, 'reviewer'),
      name: 'Reviewer',
      handle: 'reviewer',
      role: 'reviewer',
      color: USER_COLORS[4],
      persona:
        'Leaves notes on structure, unsupported claims, and tone. Comments instead of rewriting unless asked.',
      skills: ['structure', 'claims', 'tone'],
      provider: { kind: 'default' },
      sources: [],
      invited: false,
      status: 'idle'
    }
  ]
}

/**
 * Agents saved by builds that shipped the shared ids get this install's ids
 * instead; `previousUserId` also re-keys starters created under a provisional
 * id before main's profile arrived.
 */
export function withInstallIds(agents: Agent[], userId: string, previousUserId?: string): Agent[] {
  return agents.map((agent) => {
    let role: 'writer' | 'reviewer' | undefined = LEGACY_DEFAULT_AGENT_IDS[agent.id]
    if (!role && previousUserId && previousUserId !== userId) {
      for (const candidate of ['writer', 'reviewer'] as const) {
        if (agent.id === defaultAgentId(previousUserId, candidate)) role = candidate
      }
    }
    return role ? { ...agent, id: defaultAgentId(userId, role) } : agent
  })
}

export function newAgentDraft(): Agent {
  const id = createId('agent')
  return {
    id,
    name: 'New agent',
    handle: '',
    role: 'writer',
    // A stable colour from the fresh id; the person can change it in the editor.
    color: colorForId(id),
    persona: '',
    skills: [],
    provider: { kind: 'default' },
    sources: [],
    invited: false,
    status: 'idle'
  }
}

export const emptyAppState: Omit<AppState, 'provider' | 'agents' | 'recents' | 'profile'> = {
  screen: 'start',
  settingsOpen: false,
  settingsTab: 'you',
  profileSetupOpen: false,
  shareOpen: false,
  joinOpen: false,
  unsavedIntent: null,
  pendingRecentId: null,
  notice: null,
  rightTab: 'agents',
  mentionAutoSendSeconds: 0,
  leftCollapsed: false,
  rightCollapsed: false,
  backends: [],
  mcpServer: null,
  sources: [],
  runs: [],
  recoveries: [],
  missingRecentId: null,
  session: null,
  activity: []
}
