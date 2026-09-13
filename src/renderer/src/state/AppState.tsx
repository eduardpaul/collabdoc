import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  type Dispatch,
  type ReactNode
} from 'react'
import { previewOf } from '../lib/document-file'
import { createId, createShareCode, shareUrlForCode } from '../lib/ids'
import { loadPersisted, savePersisted } from '../lib/persist'
import type {
  ActivityEvent,
  Agent,
  AppState,
  CloseIntent,
  DocumentSession,
  LlmProvider,
  McpConnection,
  RecentDocument,
  RightTab,
  SettingsTab
} from '../types'
import { defaultAgents, defaultMcp, defaultProvider, emptyAppState } from './defaults'

export type Action =
  | { type: 'home' }
  | { type: 'new-document' }
  | {
      type: 'load-document'
      doc: { path: string | null; title: string; content: string; id?: string }
    }
  | { type: 'join-session'; code: string }
  | { type: 'set-title'; title: string }
  | { type: 'set-content'; content: string }
  | { type: 'mark-saved'; path: string }
  | { type: 'open-settings'; tab?: SettingsTab }
  | { type: 'close-settings' }
  | { type: 'set-settings-tab'; tab: SettingsTab }
  | { type: 'update-provider'; patch: Partial<LlmProvider> }
  | { type: 'add-mcp'; connection: McpConnection }
  | { type: 'update-mcp'; id: string; patch: Partial<McpConnection> }
  | { type: 'remove-mcp'; id: string }
  | { type: 'add-agent'; agent: Agent }
  | { type: 'update-agent'; id: string; patch: Partial<Agent> }
  | { type: 'remove-agent'; id: string }
  | { type: 'set-share-open'; open: boolean }
  | { type: 'set-join-open'; open: boolean }
  | { type: 'toggle-share' }
  | { type: 'set-right-tab'; tab: RightTab }
  | { type: 'toggle-left' }
  | { type: 'toggle-right' }
  | { type: 'collapse-chrome' }
  | { type: 'ask-unsaved'; intent: CloseIntent; recentId?: string }
  | { type: 'clear-unsaved' }
  | { type: 'notice'; message: string | null }
  | { type: 'push-activity'; event: Omit<ActivityEvent, 'id' | 'at'> }

type Store = {
  state: AppState
  dispatch: Dispatch<Action>
}

const StoreContext = createContext<Store | null>(null)

function nowIso(): string {
  return new Date().toISOString()
}

function activity(event: Omit<ActivityEvent, 'id' | 'at'>): ActivityEvent {
  return { ...event, id: createId('act'), at: nowIso() }
}

function createSession(
  partial: Partial<DocumentSession> & Pick<DocumentSession, 'title'>
): DocumentSession {
  return {
    id: createId('doc'),
    path: null,
    content: '',
    dirty: false,
    share: { active: false, url: null, code: null },
    ...partial
  }
}

function toRecent(session: DocumentSession): RecentDocument {
  return {
    id: session.id,
    title: session.title,
    path: session.path,
    updatedAt: nowIso(),
    preview: previewOf(session.content),
    content: session.content
  }
}

function upsertRecent(recents: RecentDocument[], doc: RecentDocument): RecentDocument[] {
  const rest = recents.filter((item) => item.id !== doc.id && (!doc.path || item.path !== doc.path))
  return [doc, ...rest].slice(0, 20)
}

function mergeMcp(defaults: McpConnection[], stored: McpConnection[] | undefined): McpConnection[] {
  if (!stored?.length) {
    return defaults
  }
  const extras = stored.filter((item) => !defaults.some((preset) => preset.id === item.id))
  const merged = defaults.map((preset) => stored.find((item) => item.id === preset.id) ?? preset)
  return [...merged, ...extras]
}

function createInitialState(): AppState {
  const persisted = loadPersisted()
  const agents = persisted?.agents?.length ? persisted.agents : defaultAgents
  return {
    ...emptyAppState,
    provider: { ...defaultProvider, ...persisted?.provider },
    mcp: mergeMcp(defaultMcp, persisted?.mcp),
    agents: agents.map((agent) => ({
      ...agent,
      skills: agent.skills ?? [],
      invited: false,
      status: 'idle'
    })),
    recents: persisted?.recents ?? []
  }
}

function resetSessionAgents(agents: Agent[]): Agent[] {
  return agents.map((agent) => ({ ...agent, invited: false, status: 'idle' }))
}

function withSession(
  state: AppState,
  session: DocumentSession,
  extra: Partial<AppState> = {}
): AppState {
  return {
    ...state,
    agents: resetSessionAgents(state.agents),
    ...extra,
    screen: 'workspace',
    session,
    recents: upsertRecent(state.recents, toRecent(session))
  }
}

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'home':
      return {
        ...state,
        screen: 'start',
        session: null,
        shareOpen: false,
        joinOpen: false,
        unsavedIntent: null,
        pendingRecentId: null,
        activity: [],
        agents: resetSessionAgents(state.agents)
      }
    case 'new-document': {
      const session = createSession({ title: 'Untitled' })
      return withSession(state, session, {
        activity: [activity({ actor: 'You', kind: 'system', summary: 'Created a new document' })],
        unsavedIntent: null,
        joinOpen: false
      })
    }
    case 'load-document': {
      const session = createSession({
        id: action.doc.id ?? createId('doc'),
        title: action.doc.title,
        path: action.doc.path,
        content: action.doc.content,
        dirty: false
      })
      return withSession(state, session, {
        activity: [
          activity({
            actor: 'You',
            kind: 'system',
            summary: action.doc.path
              ? `Opened ${action.doc.title}`
              : `Opened ${action.doc.title} from recents`
          })
        ],
        unsavedIntent: null,
        joinOpen: false
      })
    }
    case 'join-session': {
      const code = action.code.trim().toUpperCase()
      const session = createSession({
        title: 'Joined session',
        share: { active: true, code, url: shareUrlForCode(code) },
        content:
          'Waiting for the host document.\n\nOnce Loro sync and the local tunnel are wired, this page will fill in from the peer session.'
      })
      return withSession(state, session, {
        activity: [activity({ actor: 'You', kind: 'join', summary: `Joined session ${code}` })],
        joinOpen: false,
        unsavedIntent: null
      })
    }
    case 'set-title': {
      if (!state.session) {
        return state
      }
      const session = { ...state.session, title: action.title, dirty: true }
      return { ...state, session, recents: upsertRecent(state.recents, toRecent(session)) }
    }
    case 'set-content': {
      if (!state.session) {
        return state
      }
      const session = { ...state.session, content: action.content, dirty: true }
      return { ...state, session, recents: upsertRecent(state.recents, toRecent(session)) }
    }
    case 'mark-saved': {
      if (!state.session) {
        return state
      }
      const session = { ...state.session, path: action.path, dirty: false }
      return {
        ...state,
        session,
        recents: upsertRecent(state.recents, toRecent(session)),
        notice: 'Document saved',
        unsavedIntent: null
      }
    }
    case 'open-settings':
      return { ...state, settingsOpen: true, settingsTab: action.tab ?? state.settingsTab }
    case 'close-settings':
      return { ...state, settingsOpen: false }
    case 'set-settings-tab':
      return { ...state, settingsTab: action.tab }
    case 'update-provider': {
      const provider = { ...state.provider, ...action.patch }
      provider.enabled = Boolean(provider.endpoint.trim())
      return { ...state, provider }
    }
    case 'add-mcp':
      return { ...state, mcp: [...state.mcp, action.connection] }
    case 'update-mcp':
      return {
        ...state,
        mcp: state.mcp.map((item) => (item.id === action.id ? { ...item, ...action.patch } : item))
      }
    case 'remove-mcp':
      return { ...state, mcp: state.mcp.filter((item) => item.id !== action.id) }
    case 'add-agent':
      return { ...state, agents: [...state.agents, action.agent] }
    case 'update-agent':
      return {
        ...state,
        agents: state.agents.map((item) =>
          item.id === action.id ? { ...item, ...action.patch } : item
        )
      }
    case 'remove-agent':
      return { ...state, agents: state.agents.filter((item) => item.id !== action.id) }
    case 'set-share-open':
      return { ...state, shareOpen: action.open }
    case 'set-join-open':
      return { ...state, joinOpen: action.open }
    case 'toggle-share': {
      if (!state.session) {
        return state
      }
      if (state.session.share.active) {
        const session = { ...state.session, share: { active: false, url: null, code: null } }
        return {
          ...state,
          session,
          shareOpen: true,
          activity: [
            activity({ actor: 'You', kind: 'share', summary: 'Stopped the local tunnel' }),
            ...state.activity
          ]
        }
      }
      const code = createShareCode()
      const session = {
        ...state.session,
        share: { active: true, code, url: shareUrlForCode(code) }
      }
      return {
        ...state,
        session,
        shareOpen: true,
        activity: [
          activity({ actor: 'You', kind: 'share', summary: `Started a local tunnel · ${code}` }),
          ...state.activity
        ]
      }
    }
    case 'set-right-tab':
      return { ...state, rightTab: action.tab, rightCollapsed: false }
    case 'toggle-left':
      return { ...state, leftCollapsed: !state.leftCollapsed }
    case 'toggle-right':
      return { ...state, rightCollapsed: !state.rightCollapsed }
    case 'collapse-chrome':
      return { ...state, leftCollapsed: true, rightCollapsed: true }
    case 'ask-unsaved':
      return {
        ...state,
        unsavedIntent: action.intent,
        pendingRecentId: action.recentId ?? state.pendingRecentId
      }
    case 'clear-unsaved':
      return { ...state, unsavedIntent: null, pendingRecentId: null }
    case 'notice':
      return { ...state, notice: action.message }
    case 'push-activity':
      return { ...state, activity: [activity(action.event), ...state.activity].slice(0, 50) }
    default: {
      const _exhaustive: never = action
      return _exhaustive
    }
  }
}

export function AppStateProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [state, dispatch] = useReducer(reducer, undefined, createInitialState)

  useEffect(() => {
    savePersisted({
      provider: state.provider,
      mcp: state.mcp,
      agents: state.agents,
      recents: state.recents
    })
  }, [state.provider, state.mcp, state.agents, state.recents])

  useEffect(() => {
    if (!state.notice) {
      return
    }
    const timer = window.setTimeout(() => dispatch({ type: 'notice', message: null }), 3600)
    return () => window.clearTimeout(timer)
  }, [state.notice])

  const value = useMemo(() => ({ state, dispatch }), [state])

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>
}

// Context modules export the hook beside the provider.
// eslint-disable-next-line react-refresh/only-export-components
export function useAppState(): Store {
  const ctx = useContext(StoreContext)
  if (!ctx) {
    throw new Error('useAppState must be used within AppStateProvider')
  }
  return ctx
}
