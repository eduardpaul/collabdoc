import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  type Dispatch,
  type ReactNode
} from 'react'
import { clearAssets } from '../editor/assets'
import { createId } from '../lib/ids'
import { emptyShare } from '../lib/share-state'
import { loadPersisted, savePersisted } from '../lib/persist'
import { getClient } from '../sync/clients'
import { asActorProfile, loadProfileSync } from '../sync/identity'
import type {
  BackendAvailability,
  McpServerState,
  McpSource,
  RunEvent,
  RunRecord
} from '@shared/agents'
import type {
  ActivityEvent,
  Agent,
  AppState,
  CloseIntent,
  DocumentSession,
  LlmProvider,
  RecentDocument,
  RecoveryOffer,
  RightTab,
  SettingsTab,
  ShareState,
  UserProfile
} from '../types'
import { defaultAgents, defaultProvider, emptyAppState, withInstallIds } from './defaults'

export type Action =
  | { type: 'home' }
  | {
      /** A document is live in the host and attached; show it. */
      type: 'open-session'
      session: {
        id: string
        title: string
        path: string | null
        share?: ShareState
        isDraft?: boolean
        hasDraft?: boolean
        dirty?: boolean
      }
      summary: string
      kind?: ActivityEvent['kind']
    }
  | { type: 'set-title'; title: string }
  | { type: 'set-dirty'; dirty: boolean }
  | { type: 'set-preview'; preview: string }
  | { type: 'remove-recent'; id: string }
  | { type: 'mark-saved'; path: string; preview: string }
  | {
      type: 'set-listing'
      recents: RecentDocument[]
      recoveries: RecoveryOffer[]
    }
  | {
      type: 'apply-persist-state'
      state: {
        docId: string
        title: string
        path: string | null
        isDraft: boolean
        dirty: boolean
        hasDraft: boolean
      }
    }
  | { type: 'set-missing-recent'; id: string | null }
  | { type: 'open-settings'; tab?: SettingsTab }
  | { type: 'close-settings' }
  | { type: 'set-settings-tab'; tab: SettingsTab }
  | { type: 'set-profile'; profile: UserProfile }
  | { type: 'update-provider'; patch: Partial<LlmProvider> }
  | { type: 'set-backends'; backends: BackendAvailability[] }
  | { type: 'set-backend'; backend: BackendAvailability }
  | { type: 'set-mcp-server'; state: McpServerState }
  | { type: 'set-sources'; sources: McpSource[] }
  | { type: 'set-runs'; runs: RunRecord[] }
  /** A batch of run events from main; updates runs, agent status and Activity. */
  | { type: 'run-events'; events: RunEvent[] }
  | { type: 'add-agent'; agent: Agent }
  | { type: 'update-agent'; id: string; patch: Partial<Agent> }
  | { type: 'set-mention-autosend'; seconds: number }
  | { type: 'remove-agent'; id: string }
  | { type: 'set-share-open'; open: boolean }
  | { type: 'set-join-open'; open: boolean }
  | { type: 'toggle-share' }
  | { type: 'set-share'; share: Partial<ShareState> }
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

function toRecent(
  session: DocumentSession,
  recents: RecentDocument[],
  preview?: string
): RecentDocument {
  const previous = recents.find((item) => item.id === session.id)
  return {
    id: session.id,
    title: session.title,
    path: session.path,
    updatedAt: nowIso(),
    preview: preview ?? previous?.preview ?? ''
  }
}

function upsertRecent(recents: RecentDocument[], doc: RecentDocument): RecentDocument[] {
  const rest = recents.filter((item) => item.id !== doc.id && (!doc.path || item.path !== doc.path))
  return [doc, ...rest].slice(0, 50)
}

function touchRecent(state: AppState, session: DocumentSession, preview?: string): AppState {
  return {
    ...state,
    session,
    recents: upsertRecent(state.recents, toRecent(session, state.recents, preview))
  }
}

function createInitialState(): AppState {
  const persisted = loadPersisted()
  const profile = loadProfileSync()
  const agents = persisted?.agents?.length
    ? withInstallIds(persisted.agents, profile.userId)
    : defaultAgents(profile.userId)
  return {
    ...emptyAppState,
    profile,
    profileSetupOpen: !profile.setupComplete,
    provider: { ...defaultProvider, ...persisted?.provider },
    mentionAutoSendSeconds: persisted?.mentionAutoSendSeconds ?? 0,
    agents: agents.map((agent) => ({ ...agent, invited: false, status: 'idle' })),
    recents: [],
    recoveries: [],
    missingRecentId: null
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
    recents: upsertRecent(state.recents, toRecent(session, state.recents))
  }
}

const MAX_RUNS = 50

function statusOf(runs: RunRecord[], agentId: string): Agent['status'] {
  if (runs.some((r) => r.agentId === agentId && r.status === 'working')) return 'working'
  if (runs.some((r) => r.agentId === agentId && r.status === 'queued')) return 'queued'
  return 'idle'
}

function editsLabel(writes: number): string {
  if (writes === 0) return 'No edits'
  return `${writes} edit${writes === 1 ? '' : 's'}`
}

function runActivity(record: RunRecord): ActivityEvent | null {
  const who = record.personaName
  switch (record.status) {
    case 'working':
      return activity({
        actor: who,
        kind: 'agent',
        summary: `Started: ${record.input.slice(0, 120)}`
      })
    case 'done':
      return activity({
        actor: who,
        kind: 'agent',
        summary: [editsLabel(record.writes), record.summary.slice(0, 160)]
          .filter(Boolean)
          .join(' — ')
      })
    case 'error':
      return activity({
        actor: who,
        kind: 'agent',
        summary: `Failed: ${record.error?.message ?? 'unknown error'}`
      })
    case 'cancelled':
      return activity({ actor: who, kind: 'agent', summary: 'Cancelled' })
    case 'limit':
      return activity({
        actor: who,
        kind: 'agent',
        summary: `Stopped: ${record.error?.message ?? 'limit reached'}`
      })
    default:
      return null
  }
}

/**
 * Fold a batch of run events into state: the run list (newest first), each
 * agent's status, and one Activity row per lifecycle change. Steps and text
 * update the run record in place so the agent card can show progress.
 */
function applyRunEvents(state: AppState, events: RunEvent[]): AppState {
  let runs = state.runs
  const rows: ActivityEvent[] = []
  for (const event of events) {
    if (event.type === 'run') {
      if (state.session && event.record.docId !== state.session.id) continue
      const previous = runs.find((r) => r.runId === event.record.runId)
      runs = [event.record, ...runs.filter((r) => r.runId !== event.record.runId)].slice(
        0,
        MAX_RUNS
      )
      // One Activity row per status change; `queued` has no row.
      if (previous?.status !== event.record.status) {
        const row = runActivity(event.record)
        if (row) rows.push(row)
      }
      continue
    }
    const index = runs.findIndex((r) => r.runId === event.runId)
    if (index < 0) continue
    const record = runs[index]
    if (event.type === 'step') {
      runs = runs.map((r, i) => (i === index ? { ...r, steps: [...r.steps, event.step] } : r))
    } else if (event.type === 'text') {
      runs = runs.map((r, i) =>
        i === index ? { ...r, transcript: [...r.transcript.slice(-20), event.text] } : r
      )
    } else if (event.type === 'warning') {
      rows.push(activity({ actor: record.personaName, kind: 'agent', summary: event.message }))
    }
  }
  if (runs === state.runs && rows.length === 0) return state
  const agents = state.agents.map((agent) => {
    const status = statusOf(runs, agent.id)
    return status === agent.status ? agent : { ...agent, status }
  })
  return {
    ...state,
    runs,
    agents,
    activity: rows.length ? [...rows.reverse(), ...state.activity].slice(0, 50) : state.activity
  }
}

/** Backends, the MCP server, sources and runs: state mirrored from main (16–18). */
function runtimeReducer(state: AppState, action: Action): AppState | null {
  switch (action.type) {
    case 'set-backends':
      return { ...state, backends: action.backends }
    case 'set-backend':
      return {
        ...state,
        backends: [...state.backends.filter((b) => b.id !== action.backend.id), action.backend]
      }
    case 'set-mcp-server':
      return { ...state, mcpServer: action.state }
    case 'set-sources':
      return { ...state, sources: action.sources }
    case 'set-runs':
      return { ...state, runs: action.runs }
    case 'run-events':
      return applyRunEvents(state, action.events)
    default:
      return null
  }
}

function persistReducer(state: AppState, action: Action): AppState | null {
  switch (action.type) {
    case 'set-mention-autosend':
      return { ...state, mentionAutoSendSeconds: Math.max(0, Math.floor(action.seconds)) }
    case 'set-listing':
      return { ...state, recents: action.recents, recoveries: action.recoveries }
    case 'apply-persist-state': {
      if (!state.session || state.session.id !== action.state.docId) {
        return state
      }
      const session = {
        ...state.session,
        title: action.state.title || state.session.title,
        path: action.state.path,
        dirty: action.state.dirty,
        isDraft: action.state.isDraft,
        hasDraft: action.state.hasDraft
      }
      return { ...state, session }
    }
    case 'set-missing-recent':
      return { ...state, missingRecentId: action.id }
    default:
      return null
  }
}

function reducer(state: AppState, action: Action): AppState {
  const persisted = persistReducer(state, action) ?? runtimeReducer(state, action)
  if (persisted) return persisted
  switch (action.type) {
    case 'home':
      clearAssets()
      return {
        ...state,
        screen: 'start',
        session: null,
        shareOpen: false,
        joinOpen: false,
        unsavedIntent: null,
        pendingRecentId: null,
        missingRecentId: null,
        activity: [],
        runs: [],
        agents: resetSessionAgents(state.agents)
      }
    case 'open-session': {
      clearAssets()
      const session: DocumentSession = {
        id: action.session.id,
        title: action.session.title,
        path: action.session.path,
        dirty: action.session.dirty ?? false,
        isDraft: action.session.isDraft ?? !action.session.path,
        hasDraft: action.session.hasDraft ?? false,
        share: action.session.share ?? emptyShare()
      }
      return withSession(state, session, {
        activity: [
          activity({ actor: 'You', kind: action.kind ?? 'system', summary: action.summary })
        ],
        runs: [],
        unsavedIntent: null,
        joinOpen: false
      })
    }
    case 'set-title': {
      if (!state.session || state.session.title === action.title) {
        return state
      }
      return touchRecent(state, { ...state.session, title: action.title })
    }
    case 'set-dirty': {
      if (!state.session || state.session.dirty === action.dirty) {
        return state
      }
      return { ...state, session: { ...state.session, dirty: action.dirty } }
    }
    case 'set-preview': {
      if (!state.session) {
        return state
      }
      return touchRecent(state, state.session, action.preview)
    }
    case 'remove-recent':
      return { ...state, recents: state.recents.filter((item) => item.id !== action.id) }
    case 'mark-saved': {
      if (!state.session) {
        return state
      }
      const session = {
        ...state.session,
        path: action.path,
        dirty: false,
        isDraft: false,
        hasDraft: false
      }
      return {
        ...touchRecent(state, session, action.preview),
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
    case 'set-profile': {
      if (state.session) {
        getClient(state.session.id)?.setProfile(asActorProfile(action.profile))
      }
      return {
        ...state,
        profile: action.profile,
        // Starter agents keyed by a provisional id follow the real install id.
        agents: withInstallIds(state.agents, action.profile.userId, state.profile.userId),
        profileSetupOpen: !action.profile.setupComplete
      }
    }
    case 'update-provider': {
      const provider = { ...state.provider, ...action.patch }
      provider.enabled = Boolean(provider.endpoint.trim())
      return { ...state, provider }
    }
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
    case 'toggle-share':
      return state
    case 'set-share': {
      if (!state.session) return state
      return {
        ...state,
        session: { ...state.session, share: { ...state.session.share, ...action.share } }
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
      if (
        action.type === 'set-listing' ||
        action.type === 'apply-persist-state' ||
        action.type === 'set-missing-recent' ||
        action.type === 'set-mention-autosend' ||
        action.type === 'set-backends' ||
        action.type === 'set-backend' ||
        action.type === 'set-mcp-server' ||
        action.type === 'set-sources' ||
        action.type === 'set-runs' ||
        action.type === 'run-events'
      ) {
        return state
      }
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
      agents: state.agents,
      mentionAutoSendSeconds: state.mentionAutoSendSeconds
    })
  }, [state.provider, state.agents, state.mentionAutoSendSeconds])

  // Backends (17), the document MCP server (16) and sources (18) live in main.
  useEffect(() => {
    const api = window.api
    if (!api?.agents) return
    void api.agents.listBackends().then((result) => {
      if (result.ok) dispatch({ type: 'set-backends', backends: result.backends })
    })
    void api.mcp.getState().then((result) => {
      if (result.ok) dispatch({ type: 'set-mcp-server', state: result.state })
    })
    void api.sources.list().then((result) => {
      if (result.ok) dispatch({ type: 'set-sources', sources: result.sources })
    })
    const stopMcp = api.mcp.onState((mcpState) =>
      dispatch({ type: 'set-mcp-server', state: mcpState })
    )
    const stopEvents = api.agents.onEvents((events) => {
      if (Array.isArray(events)) dispatch({ type: 'run-events', events })
    })
    const stopBackend = api.agents.onBackend((backend) =>
      dispatch({ type: 'set-backend', backend })
    )
    return () => {
      stopMcp()
      stopEvents()
      stopBackend()
    }
  }, [])

  useEffect(() => {
    const api = window.api?.documents
    if (!api?.onState) {
      return
    }
    const stopState = api.onState((persistState) => {
      if (!persistState.dirty) {
        getClient(persistState.docId)?.markClean()
      }
      dispatch({ type: 'apply-persist-state', state: persistState })
    })
    const stopListing = api.onListing?.((listing) => {
      dispatch({
        type: 'set-listing',
        recents: listing.recents.map((item) => ({
          id: item.docId,
          title: item.title,
          path: item.path,
          updatedAt: item.updatedAt,
          preview: item.preview,
          missing: item.missing
        })),
        recoveries: listing.recoveries.map((item) => ({
          id: item.docId,
          title: item.title,
          updatedAt: item.updatedAt
        }))
      })
    })
    const stopShare = window.api?.share?.onState?.((share) => {
      dispatch({
        type: 'set-share',
        share: {
          active: share.active,
          announcing: share.announcing,
          url: share.link,
          code: share.code,
          role: share.role,
          guests: share.guests,
          status: share.status,
          lockedUntil: share.lockedUntil,
          hostEnded: share.hostEnded,
          readOnly: share.readOnly
        }
      })
    })
    const stopShareActivity = window.api?.share?.onActivity?.((summary) => {
      dispatch({ type: 'push-activity', event: { actor: 'You', kind: 'share', summary } })
    })
    return () => {
      stopState()
      stopListing?.()
      stopShare?.()
      stopShareActivity?.()
    }
  }, [])

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
