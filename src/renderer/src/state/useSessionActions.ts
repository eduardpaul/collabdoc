import { useAppState } from './AppState'
import { agentCanRun } from './selectors'
import { previewOf } from '../lib/document-file'
import { openDocumentFromHost, readDocumentFromHost, saveDocumentToHost } from '../lib/files'
import { shareUrlForCode } from '../lib/ids'
import { closeClient, createAndOpen, getClient, openClient } from '../sync/clients'
import { textFromDoc } from '../editor/document'
import type { Agent, CloseIntent } from '../types'

export function useSessionActions(): {
  newDocument: () => void
  openDocument: () => void
  openRecent: (id: string) => Promise<void>
  joinSession: (code: string) => Promise<void>
  resumeDocument: (docId: string) => Promise<boolean>
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

  /** Leave the current document: remember its preview, detach, release. */
  const leaveCurrent = async (): Promise<void> => {
    const current = state.session
    if (!current) {
      return
    }
    const client = getClient(current.id)
    if (client && client.status === 'live') {
      dispatch({ type: 'set-preview', preview: previewOf(textFromDoc(client.toJSON())) })
    }
    await closeClient(current.id)
  }

  const createNew = async (): Promise<void> => {
    await leaveCurrent()
    const client = await createAndOpen({ title: 'Untitled' })
    dispatch({
      type: 'open-session',
      session: { id: client.docId, title: client.title, path: null },
      summary: 'Created a new document'
    })
  }

  const openFromDisk = async (): Promise<void> => {
    const loaded = await openDocumentFromHost()
    if (!loaded) {
      return
    }
    await leaveCurrent()
    const client = await createAndOpen({ title: loaded.title, seed: loaded.content })
    dispatch({
      type: 'open-session',
      session: { id: client.docId, title: loaded.title, path: loaded.path },
      summary: `Opened ${loaded.title}`
    })
  }

  const loadRecent = async (id: string): Promise<void> => {
    const recent = state.recents.find((item) => item.id === id)
    if (!recent) {
      return
    }
    if (!recent.path) {
      // Unsaved drafts only live while the app runs; 04 keeps them on disk.
      dispatch({ type: 'remove-recent', id })
      dispatch({ type: 'notice', message: 'That draft is no longer available.' })
      return
    }
    try {
      const loaded = await readDocumentFromHost(recent.path)
      await leaveCurrent()
      const client = await createAndOpen({ title: loaded.title, seed: loaded.content })
      dispatch({ type: 'remove-recent', id })
      dispatch({
        type: 'open-session',
        session: { id: client.docId, title: loaded.title, path: loaded.path },
        summary: `Opened ${loaded.title}`
      })
    } catch (error) {
      fail(error)
    }
  }

  const proceed = async (intent: CloseIntent): Promise<void> => {
    try {
      if (intent === 'home') {
        await leaveCurrent()
        dispatch({ type: 'home' })
        return
      }
      if (intent === 'new') {
        await createNew()
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
      await openFromDisk()
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
    const session = state.session
    const client = session ? getClient(session.id) : undefined
    if (!session || !client || client.status !== 'live') {
      return false
    }
    try {
      const content = client.toJSON()
      const saved = await saveDocumentToHost({ path: session.path, title: session.title, content })
      if (!saved) {
        return false
      }
      client.markClean()
      dispatch({ type: 'mark-saved', path: saved.path, preview: previewOf(textFromDoc(content)) })
      dispatch({
        type: 'push-activity',
        event: { actor: 'You', kind: 'system', summary: `Saved ${session.title}` }
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

  const joinSession = async (rawCode: string): Promise<void> => {
    const code = rawCode.trim().toUpperCase()
    try {
      await leaveCurrent()
      // 08 replaces this with a real peer connection; until then the join
      // opens a local document that says so.
      const client = await createAndOpen({ title: 'Joined session' })
      dispatch({
        type: 'open-session',
        session: {
          id: client.docId,
          title: 'Joined session',
          path: null,
          share: { active: true, code, url: shareUrlForCode(code) }
        },
        summary: `Joined session ${code}`,
        kind: 'join'
      })
      dispatch({
        type: 'notice',
        message: 'Peer sessions arrive with Hyperswarm sharing; this document is local for now.'
      })
    } catch (error) {
      fail(error)
    }
  }

  /** After a reload: re-attach to the document this window had open (AC-03.7). */
  const resumeDocument = async (docId: string): Promise<boolean> => {
    try {
      const client = await openClient(docId)
      const recent = state.recents.find((item) => item.id === docId)
      dispatch({
        type: 'open-session',
        session: { id: docId, title: client.title, path: recent?.path ?? null },
        summary: `Resumed ${client.title}`
      })
      return true
    } catch {
      return false
    }
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
    joinSession,
    resumeDocument,
    saveDocument,
    goHome: () => request('home'),
    request,
    confirmUnsaved,
    connectMcp,
    disconnectMcp,
    askAgent
  }
}
