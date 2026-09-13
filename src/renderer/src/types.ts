export type LlmKind = 'openai-compatible' | 'anthropic' | 'custom'

export type LlmProvider = {
  enabled: boolean
  kind: LlmKind
  label: string
  endpoint: string
  apiKey: string
  model: string
}

export type McpKind = 'claude' | 'codex' | 'custom'
export type McpTransport = 'stdio' | 'sse'
export type McpStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

export type McpConnection = {
  id: string
  kind: McpKind
  label: string
  transport: McpTransport
  command: string
  url: string
  status: McpStatus
  error?: string
}

export type AgentRole = 'writer' | 'reviewer'
export type AgentRouting = 'llm' | 'mcp'
export type AgentStatus = 'idle' | 'working'

export type Agent = {
  id: string
  name: string
  role: AgentRole
  persona: string
  skills: string[]
  routing: AgentRouting
  mcpId: string | null
  invited: boolean
  status: AgentStatus
}

export type ShareState = {
  active: boolean
  url: string | null
  code: string | null
}

export type DocumentSession = {
  id: string
  title: string
  path: string | null
  content: string
  dirty: boolean
  share: ShareState
}

export type RecentDocument = {
  id: string
  title: string
  path: string | null
  updatedAt: string
  preview: string
  content: string
}

export type ActivityKind = 'edit' | 'comment' | 'agent' | 'share' | 'join' | 'system'

export type ActivityEvent = {
  id: string
  at: string
  actor: string
  kind: ActivityKind
  summary: string
}

export type AppScreen = 'start' | 'workspace'
export type SettingsTab = 'provider' | 'mcp' | 'agents'
export type RightTab = 'agents' | 'activity'
export type CloseIntent = 'home' | 'new' | 'open' | 'recent'

export type AppState = {
  screen: AppScreen
  settingsOpen: boolean
  settingsTab: SettingsTab
  shareOpen: boolean
  joinOpen: boolean
  unsavedIntent: CloseIntent | null
  pendingRecentId: string | null
  notice: string | null
  rightTab: RightTab
  leftCollapsed: boolean
  rightCollapsed: boolean
  provider: LlmProvider
  mcp: McpConnection[]
  agents: Agent[]
  recents: RecentDocument[]
  session: DocumentSession | null
  activity: ActivityEvent[]
}

export type DocumentReadResult =
  { ok: true; path: string; name: string; content: string } | { ok: false; error: string }

export type DocumentSavePayload = {
  path: string | null
  content: string
  suggestedName?: string
}

export type DocumentSaveResult =
  { ok: true; path: string; name: string } | { ok: false; error: string }
