import { useAppState } from './AppState'
import { agentCanRun } from './selectors'
import { openDocumentFromHost, readDocumentFromHost, saveDocumentToHost } from '../lib/files'
import type { Agent, CloseIntent } from '../types'

export function useSessionActions(): {
  newDocument: () => void
  openDocument: () => void
  openRecent: (id: string) => Promise<void>
  saveDocument: () => Promise<boolean>
  goHome: () => void
  request: (intent: CloseIntent) => void
  confirmUnsaved: (mode: 'save' | 'discard') => Promise<void>
  connectMcp: (id: string) => void
  disconnectMcp: (id: string) => void
  askAgent: (agent: Agent, prompt: string) => void
} {
  const { state, dispatch } = useAppState()

  const fail = (error: unknown): void => {
    const message = error instanceof Error ? error.message : 'Something went wrong'
    if (message === 'canceled') {
      return
    }
    dispatch({ type: 'notice', message })
  }

  const loadRecent = async (id: string): Promise<void> => {
    const recent = state.recents.find((item) => item.id === id)
    if (!recent) {
      return
    }
    if (recent.path) {
      try {
        const loaded = await readDocumentFromHost(recent.path)
        dispatch({ type: 'load-document', doc: { ...loaded, id: recent.id } })
        return
      } catch {
        dispatch({
          type: 'notice',
          message: 'Could not read that file. Opening the last local copy.'
        })
      }
    }
    dispatch({
      type: 'load-document',
      doc: { id: recent.id, path: recent.path, title: recent.title, content: recent.content }
    })
  }

  const proceed = async (intent: CloseIntent): Promise<void> => {
    if (intent === 'home') {
      dispatch({ type: 'home' })
      return
    }
    if (intent === 'new') {
      dispatch({ type: 'new-document' })
      return
    }
    if (intent === 'recent') {
      const recentId = state.pendingRecentId
      dispatch({ type: 'clear-unsaved' })
      if (recentId) {
        await loadRecent(recentId)
      }
      return
    }
    try {
      const loaded = await openDocumentFromHost()
      if (!loaded) {
        return
      }
      dispatch({ type: 'load-document', doc: loaded })
    } catch (error) {
      fail(error)
    }
  }

  const request = (intent: CloseIntent): void => {
    if (state.session?.dirty) {
      dispatch({ type: 'ask-unsaved', intent })
      return
    }
    void proceed(intent)
  }

  const saveDocument = async (): Promise<boolean> => {
    if (!state.session) {
      return false
    }
    try {
      const saved = await saveDocumentToHost({
        path: state.session.path,
        title: state.session.title,
        content: state.session.content
      })
      if (!saved) {
        return false
      }
      dispatch({ type: 'mark-saved', path: saved.path })
      dispatch({
        type: 'push-activity',
        event: { actor: 'You', kind: 'system', summary: `Saved ${state.session.title}` }
      })
      return true
    } catch (error) {
      fail(error)
      return false
    }
  }

  const confirmUnsaved = async (mode: 'save' | 'discard'): Promise<void> => {
    const intent = state.unsavedIntent
    if (!intent) {
      return
    }
    if (mode === 'save') {
      const ok = await saveDocument()
      if (!ok) {
        return
      }
    }
    dispatch({ type: 'clear-unsaved' })
    await proceed(intent)
  }

  const connectMcp = (id: string): void => {
    dispatch({ type: 'update-mcp', id, patch: { status: 'connecting', error: undefined } })
    window.setTimeout(() => {
      dispatch({ type: 'update-mcp', id, patch: { status: 'connected' } })
      dispatch({
        type: 'notice',
        message:
          'MCP marked connected. The local client will spawn when the agent runtime is wired.'
      })
    }, 700)
  }

  const disconnectMcp = (id: string): void => {
    dispatch({ type: 'update-mcp', id, patch: { status: 'disconnected', error: undefined } })
  }

  const askAgent = (agent: Agent, prompt: string): void => {
    if (!agentCanRun(state, agent)) {
      dispatch({
        type: 'notice',
        message: 'Connect an LLM provider or a local MCP server before asking agents to work.'
      })
      dispatch({ type: 'open-settings', tab: agent.routing === 'mcp' ? 'mcp' : 'provider' })
      return
    }
    const trimmed = prompt.trim()
    const fallback =
      agent.role === 'writer'
        ? 'Draft the next section from the current document.'
        : 'Review the document for structure, claims, and tone.'
    const task = trimmed || fallback
    dispatch({ type: 'update-agent', id: agent.id, patch: { status: 'working', invited: true } })
    dispatch({
      type: 'push-activity',
      event: {
        actor: agent.name,
        kind: 'agent',
        summary: `${agent.role === 'writer' ? 'Drafting' : 'Reviewing'}: ${task}`
      }
    })
    window.setTimeout(() => {
      dispatch({ type: 'update-agent', id: agent.id, patch: { status: 'idle' } })
      dispatch({
        type: 'push-activity',
        event: {
          actor: agent.name,
          kind: 'agent',
          summary:
            'Finished the turn. Output will land in the document once LangChain DeepAgents is connected.'
        }
      })
    }, 1400)
  }

  return {
    newDocument: () => request('new'),
    openDocument: () => request('open'),
    openRecent: async (id: string) => {
      if (state.session?.id === id) {
        return
      }
      if (state.session?.dirty) {
        dispatch({ type: 'ask-unsaved', intent: 'recent', recentId: id })
        return
      }
      await loadRecent(id)
    },
    saveDocument,
    goHome: () => request('home'),
    request,
    confirmUnsaved,
    connectMcp,
    disconnectMcp,
    askAgent
  }
}
