import { createId } from '../lib/ids'
import type { Agent, AppState, LlmProvider, McpConnection } from '../types'

export const defaultProvider: LlmProvider = {
  enabled: false,
  kind: 'openai-compatible',
  label: 'OpenAI-compatible',
  endpoint: '',
  apiKey: '',
  model: ''
}

export const defaultMcp: McpConnection[] = [
  {
    id: 'mcp_claude',
    kind: 'claude',
    label: 'Claude (local MCP)',
    transport: 'stdio',
    command: 'claude',
    url: '',
    status: 'disconnected'
  },
  {
    id: 'mcp_codex',
    kind: 'codex',
    label: 'Codex (local MCP)',
    transport: 'stdio',
    command: 'codex',
    url: '',
    status: 'disconnected'
  }
]

export const defaultAgents: Agent[] = [
  {
    id: 'agent_writer',
    name: 'Writer',
    role: 'writer',
    persona:
      'Turns outlines into clear prose in the author voice. Attributes every insertion. Never silently overwrites.',
    skills: ['outline', 'draft', 'rewrite'],
    routing: 'llm',
    mcpId: null,
    invited: false,
    status: 'idle'
  },
  {
    id: 'agent_reviewer',
    name: 'Reviewer',
    role: 'reviewer',
    persona:
      'Leaves notes on structure, unsupported claims, and tone. Comments instead of rewriting unless asked.',
    skills: ['structure', 'claims', 'tone'],
    routing: 'llm',
    mcpId: null,
    invited: false,
    status: 'idle'
  }
]

export function newAgentDraft(): Agent {
  return {
    id: createId('agent'),
    name: 'New agent',
    role: 'writer',
    persona: '',
    skills: [],
    routing: 'llm',
    mcpId: null,
    invited: false,
    status: 'idle'
  }
}

export const emptyAppState: Omit<AppState, 'provider' | 'mcp' | 'agents' | 'recents'> = {
  screen: 'start',
  settingsOpen: false,
  settingsTab: 'provider',
  shareOpen: false,
  joinOpen: false,
  unsavedIntent: null,
  pendingRecentId: null,
  notice: null,
  rightTab: 'agents',
  leftCollapsed: false,
  rightCollapsed: false,
  recoveries: [],
  missingRecentId: null,
  session: null,
  activity: []
}
