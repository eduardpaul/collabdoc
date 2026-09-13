import type { JSONContent } from '@tiptap/core'

export type DocJson = JSONContent

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

export type ShareGuestInfo = {
  id: string
  name: string
  color: string
  handle: string
  connection: 'direct' | 'holepunched' | 'relay' | 'local'
}

export type ShareState = {
  active: boolean
  announcing: boolean
  url: string | null
  code: string | null
  role: 'host' | 'guest' | null
  guests: ShareGuestInfo[]
  status: string
  lockedUntil: number
  hostEnded: boolean
  readOnly: boolean
}

/**
 * What the reducer knows about the open document. The content itself lives
 * in the `DocumentClient` for `id` (see `sync/clients.ts`), never here.
 */
export type DocumentSession = {
  id: string
  title: string
  path: string | null
  dirty: boolean
  isDraft: boolean
  hasDraft: boolean
  share: ShareState
}

export type RecentDocument = {
  id: string
  title: string
  path: string | null
  updatedAt: string
  preview: string
  missing?: boolean
}

export type RecoveryOffer = {
  id: string
  title: string
  updatedAt: string
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
export type SettingsTab = 'you' | 'provider' | 'mcp' | 'agents'
export type RightTab = 'agents' | 'comments' | 'history' | 'activity' | 'markdown'
export type CloseIntent = 'home' | 'new' | 'open' | 'recent'

export type UserProfile = {
  userId: string
  name: string
  handle: string
  color: string
  setupComplete: boolean
}

export type AppState = {
  screen: AppScreen
  settingsOpen: boolean
  settingsTab: SettingsTab
  profile: UserProfile
  profileSetupOpen: boolean
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
  /** Seconds of idleness before an agent request is sent on its own; 0 = off (10). */
  mentionAutoSendSeconds: number
  recents: RecentDocument[]
  recoveries: RecoveryOffer[]
  missingRecentId: string | null
  session: DocumentSession | null
  activity: ActivityEvent[]
}

export type DocumentReadResult =
  { ok: true; path: string; name: string; content: string } | { ok: false; error: string }

export type DocumentSavePayload = {
  path: string | null
  content: string
  suggestedName?: string
  extras?: { relativePath: string; base64: string }[]
}

export type DocumentSaveResult =
  { ok: true; path: string; name: string } | { ok: false; error: string }
