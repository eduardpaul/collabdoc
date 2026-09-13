import { useAppState } from './AppState'
import { agentCanRun } from './selectors'
import { parseDocument, previewOf, serializeDocument } from '../lib/document-file'
import { listThreads, threadsAsFootnotes } from '@core/comments'
import { extrasFromDoc, hydrateImages, saveDocumentToHost } from '../lib/files'
import { emptyShare } from '../lib/share-state'
import { takeLegacyRecents } from '../lib/persist'
import { closeClient, createAndOpen, getClient, openClient } from '../sync/clients'
import { textFromDoc } from '../editor/document'
import type { Agent, CloseIntent, RecentDocument, RecoveryOffer } from '../types'

function nativePersist(): boolean {
  return Boolean(window.api?.documents.saveNow)
}

function shouldPrompt(session: {
  isDraft: boolean
  dirty: boolean
  hasDraft: boolean
  path: string | null
}): boolean {
  if (nativePersist()) {
    if (!session.isDraft) return false
    return session.dirty || session.hasDraft
  }
  return session.dirty
}

function listingFromApi(listing: {
  recents: Array<{
    docId: string
    title: string
    path: string | null
    updatedAt: string
    preview: string
    missing?: boolean
  }>
  recoveries: Array<{ docId: string; title: string; updatedAt: string }>
}): { recents: RecentDocument[]; recoveries: RecoveryOffer[] } {
  return {
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
  }
}

export function useSessionActions(): {
  newDocument: () => void
  openDocument: () => void
  importMarkdown: () => void
  exportMarkdown: (options?: { includeComments?: boolean }) => void
  openRecent: (id: string) => Promise<void>
  recoverDocument: (id: string) => Promise<void>
  locateRecent: (id: string) => Promise<void>
  removeRecent: (id: string) => Promise<void>
  joinSession: (code: string) => Promise<void>
  startShare: () => Promise<void>
  stopShare: () => Promise<void>
  removeShareGuest: (id: string) => Promise<void>
  forkDocument: () => Promise<void>
  resumeDocument: (docId: string) => Promise<boolean>
  saveDocument: () => Promise<boolean>
  saveDocumentAs: () => Promise<boolean>
  goHome: () => void
  request: (intent: CloseIntent) => void
  confirmUnsaved: (mode: 'save' | 'discard') => Promise<void>
  hydratePersist: () => Promise<void>
  connectMcp: (id: string) => void
  disconnectMcp: (id: string) => void
  askAgent: (agent: Agent, prompt: string) => void
} {
  const { state, dispatch } = useAppState()

  const fail = (error: unknown): void => {
    const message = error instanceof Error ? error.message : 'Something went wrong'
    if (message === 'canceled') return
    dispatch({ type: 'notice', message })
  }

  const refreshListing = async (): Promise<void> => {
    const result = await window.api?.documents.listing?.()
    if (!result || !('ok' in result) || !result.ok) return
    const mapped = listingFromApi(result)
    dispatch({ type: 'set-listing', recents: mapped.recents, recoveries: mapped.recoveries })
  }

  const leaveCurrent = async (): Promise<void> => {
    const current = state.session
    if (!current) return
    if (nativePersist() && !current.isDraft) {
      await window.api?.documents.flush?.(current.id)
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
      session: { id: client.docId, title: client.title, path: null, isDraft: true },
      summary: 'Created a new document'
    })
  }

  const openFromResult = async (
    result: Exclude<
      Awaited<ReturnType<NonNullable<Window['api']>['documents']['open']>>,
      { ok: false }
    >
  ): Promise<void> => {
    await leaveCurrent()
    if (result.kind === 'collabdoc') {
      const client = await openClient(result.docId)
      dispatch({
        type: 'open-session',
        session: {
          id: result.docId,
          title: result.title || client.title,
          path: result.path || null,
          isDraft: !result.path,
          hasDraft: !result.path
        },
        summary: `Opened ${result.title || client.title}`
      })
      if (result.warnings.includes('truncated-assets')) {
        dispatch({
          type: 'notice',
          message: 'Some images in this file are missing and show as placeholders.'
        })
      }
      return
    }
    const parsed = parseDocument(result.markdown, result.title)
    const content = await hydrateImages(parsed.content, result.sourcePath)
    const client = await openClient(result.docId, { seed: content })
    dispatch({
      type: 'open-session',
      session: { id: client.docId, title: parsed.title, path: null, isDraft: true },
      summary: `Imported ${parsed.title}`
    })
  }

  const openFromDisk = async (): Promise<void> => {
    if (!nativePersist()) {
      const { openDocumentFromHost } = await import('../lib/files')
      const loaded = await openDocumentFromHost()
      if (!loaded) return
      await leaveCurrent()
      const client = await createAndOpen({ title: loaded.title, seed: loaded.content })
      dispatch({
        type: 'open-session',
        session: {
          id: client.docId,
          title: loaded.title,
          path: loaded.path,
          isDraft: !loaded.path
        },
        summary: `Opened ${loaded.title}`
      })
      return
    }
    const result = await window.api!.documents.open()
    if (!result.ok) throw new Error(result.error)
    await openFromResult(result)
  }

  const loadRecent = async (id: string): Promise<void> => {
    const recent = state.recents.find((item) => item.id === id)
    if (!recent) return
    if (recent.missing) {
      dispatch({ type: 'set-missing-recent', id })
      dispatch({
        type: 'notice',
        message: `"${recent.title}" was moved or deleted.`
      })
      return
    }
    if (!nativePersist()) {
      if (!recent.path) {
        dispatch({ type: 'remove-recent', id })
        dispatch({ type: 'notice', message: 'That draft is no longer available.' })
        return
      }
      const { readDocumentFromHost } = await import('../lib/files')
      const loaded = await readDocumentFromHost(recent.path)
      await leaveCurrent()
      const client = await createAndOpen({ title: loaded.title, seed: loaded.content })
      dispatch({
        type: 'open-session',
        session: { id: client.docId, title: loaded.title, path: loaded.path },
        summary: `Opened ${loaded.title}`
      })
      return
    }
    const result = recent.path
      ? await window.api!.documents.openPath(recent.path)
      : await window.api!.documents.recover(id)
    if (!result.ok) {
      if (/enoent|not found|no such file/i.test(result.error)) {
        dispatch({ type: 'set-missing-recent', id })
        dispatch({ type: 'notice', message: `"${recent.title}" was moved or deleted.` })
        return
      }
      throw new Error(result.error)
    }
    await openFromResult(result)
  }

  const proceed = async (intent: CloseIntent): Promise<void> => {
    try {
      if (intent === 'home') {
        await leaveCurrent()
        dispatch({ type: 'home' })
        await refreshListing()
        return
      }
      if (intent === 'new') {
        await createNew()
        return
      }
      if (intent === 'recent') {
        const recentId = state.pendingRecentId
        dispatch({ type: 'clear-unsaved' })
        if (recentId) await loadRecent(recentId)
        return
      }
      await openFromDisk()
    } catch (error) {
      fail(error)
    }
  }

  const request = (intent: CloseIntent): void => {
    if (state.session && shouldPrompt(state.session)) {
      dispatch({ type: 'ask-unsaved', intent })
      return
    }
    void proceed(intent)
  }

  const saveDocument = async (saveAs = false): Promise<boolean> => {
    const session = state.session
    const client = session ? getClient(session.id) : undefined
    if (!session || !client || client.status !== 'live') return false
    try {
      if (!nativePersist()) {
        const content = client.toJSON()
        const saved = await saveDocumentToHost({
          path: session.path,
          title: session.title,
          content
        })
        if (!saved) return false
        client.markClean()
        dispatch({ type: 'mark-saved', path: saved.path, preview: previewOf(textFromDoc(content)) })
        return true
      }
      const result = saveAs
        ? await window.api!.documents.saveAs(session.id)
        : await window.api!.documents.saveNow(session.id)
      if (!result.ok) {
        if (result.canceled) return false
        throw new Error(result.error)
      }
      client.markClean()
      dispatch({
        type: 'mark-saved',
        path: result.path,
        preview: previewOf(textFromDoc(client.toJSON()))
      })
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
    const session = state.session
    if (!intent) return
    if (mode === 'save') {
      const ok = await saveDocument(Boolean(session?.isDraft))
      if (!ok) return
    } else if (session && nativePersist() && session.isDraft) {
      await window.api!.documents.discardDraft(session.id)
    }
    dispatch({ type: 'clear-unsaved' })
    await proceed(intent)
  }

  const joinSession = async (rawCode: string): Promise<void> => {
    const code = rawCode.trim()
    if (!window.api?.share?.join) {
      dispatch({ type: 'notice', message: 'Joining a live session needs the desktop app.' })
      return
    }
    try {
      await leaveCurrent()
      const result = await window.api.share.join({
        code,
        profile: {
          userId: state.profile.userId,
          name: state.profile.name,
          handle: state.profile.handle,
          color: state.profile.color,
          installPublicKey: state.profile.userId
        }
      })
      if (!result.ok) throw new Error(result.error)
      const client = await openClient(result.docId)
      dispatch({
        type: 'open-session',
        session: {
          id: result.docId,
          title: result.title || client.title,
          path: null,
          isDraft: true,
          share: { ...emptyShare(), active: true, role: 'guest', code, status: 'joined' }
        },
        summary: `Joined session`,
        kind: 'join'
      })
      dispatch({ type: 'set-join-open', open: false })
    } catch (error) {
      fail(error)
    }
  }

  const startShare = async (): Promise<void> => {
    const session = state.session
    if (!session) return
    if (!window.api?.share?.start) {
      dispatch({ type: 'notice', message: 'Sharing needs the desktop app.' })
      return
    }
    dispatch({ type: 'set-share', share: { announcing: true, status: 'announcing…' } })
    const result = await window.api.share.start({
      docId: session.id,
      hostName: state.profile.name
    })
    if (!result.ok) {
      dispatch({ type: 'set-share', share: { announcing: false, status: '' } })
      fail(new Error(result.error))
    }
  }

  const stopShare = async (): Promise<void> => {
    await window.api?.share?.stop?.()
    dispatch({ type: 'set-share', share: emptyShare() })
  }

  const removeShareGuest = async (id: string): Promise<void> => {
    await window.api?.share?.removeGuest?.(id)
  }

  const forkDocument = async (): Promise<void> => {
    const session = state.session
    const client = session ? getClient(session.id) : undefined
    if (!session || !client || client.status !== 'live') return
    const content = client.toJSON()
    await leaveCurrent()
    const next = await createAndOpen({ title: `${session.title} copy`, seed: content })
    dispatch({
      type: 'open-session',
      session: { id: next.docId, title: next.title, path: null, isDraft: true },
      summary: 'Forked as my own document'
    })
  }

  const resumeDocument = async (docId: string): Promise<boolean> => {
    try {
      const client = await openClient(docId)
      const recent = state.recents.find((item) => item.id === docId)
      dispatch({
        type: 'open-session',
        session: {
          id: docId,
          title: client.title,
          path: recent?.path ?? null,
          isDraft: !recent?.path
        },
        summary: `Resumed ${client.title}`
      })
      return true
    } catch {
      return false
    }
  }

  const hydratePersist = async (): Promise<void> => {
    if (!nativePersist()) return
    const leftover = takeLegacyRecents()
    for (const item of leftover) {
      try {
        if (typeof item.content === 'string' && item.content.length > 0) {
          const parsed = parseDocument(item.content, item.title)
          const content = await hydrateImages(parsed.content, item.path)
          const created = await window.api!.documents.create({ title: parsed.title })
          if (!created.ok) continue
          const client = await openClient(created.docId, { seed: content })
          await window.api!.documents.flush(created.docId)
          await closeClient(created.docId)
          void client
        } else if (item.path) {
          await window.api!.documents.rememberRecent({
            docId: item.id,
            title: item.title,
            path: item.path,
            updatedAt: item.updatedAt,
            preview: item.preview
          })
        }
      } catch (error) {
        console.warn('[collabdoc] could not migrate a recent document', error)
      }
    }
    await refreshListing()
  }

  const exportMarkdown = async (options: { includeComments?: boolean } = {}): Promise<void> => {
    const session = state.session
    const client = session ? getClient(session.id) : undefined
    if (!session || !client || client.status !== 'live') return
    const content = client.toJSON()
    // With comments: the same document plus footnotes; without, exactly 04's export.
    const footnotes = options.includeComments
      ? threadsAsFootnotes(listThreads(client.doc, { status: 'all' }))
      : ''
    const markdown = serializeDocument(session.title, content, { singleFile: false }) + footnotes
    const suggestedName = `${session.title.trim() || 'Untitled'}.md`
    if (!nativePersist() || !window.api?.documents.exportMarkdown) {
      await saveDocumentToHost({ path: null, title: session.title, content })
      return
    }
    const result = await window.api.documents.exportMarkdown({
      content: markdown,
      suggestedName,
      extras: extrasFromDoc(content)
    })
    if (!result.ok) {
      if (!result.canceled) fail(new Error(result.error))
      return
    }
    dispatch({ type: 'notice', message: 'Exported Markdown' })
  }

  const importMarkdown = (): void => {
    const run = async (): Promise<void> => {
      if (!nativePersist()) {
        await openFromDisk()
        return
      }
      const result = await window.api!.documents.importMarkdown()
      if (!result.ok) throw new Error(result.error)
      await openFromResult(result)
    }
    if (state.session && shouldPrompt(state.session)) {
      dispatch({ type: 'ask-unsaved', intent: 'open' })
      return
    }
    void run().catch(fail)
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
    importMarkdown,
    exportMarkdown: (options) => {
      void exportMarkdown(options)
    },
    openRecent: async (id: string) => {
      if (state.session?.id === id) return
      if (state.session && shouldPrompt(state.session)) {
        dispatch({ type: 'ask-unsaved', intent: 'recent', recentId: id })
        return
      }
      await loadRecent(id)
    },
    recoverDocument: async (id: string) => {
      if (!nativePersist()) return
      if (state.session && shouldPrompt(state.session)) {
        dispatch({ type: 'ask-unsaved', intent: 'recent', recentId: id })
        return
      }
      try {
        const result = await window.api!.documents.recover(id)
        if (!result.ok) throw new Error(result.error)
        await openFromResult(result)
      } catch (error) {
        fail(error)
      }
    },
    locateRecent: async (id: string) => {
      if (!nativePersist()) return
      try {
        const result = await window.api!.documents.locateRecent(id)
        if (!result.ok) throw new Error(result.error)
        dispatch({ type: 'set-missing-recent', id: null })
        await openFromResult(result)
      } catch (error) {
        fail(error)
      }
    },
    removeRecent: async (id: string) => {
      dispatch({ type: 'remove-recent', id })
      dispatch({ type: 'set-missing-recent', id: null })
      if (nativePersist()) await window.api!.documents.removeRecent(id)
    },
    joinSession,
    startShare,
    stopShare,
    removeShareGuest,
    forkDocument,
    resumeDocument,
    saveDocument: () => saveDocument(false),
    saveDocumentAs: () => saveDocument(true),
    goHome: () => request('home'),
    request,
    confirmUnsaved,
    hydratePersist,
    connectMcp,
    disconnectMcp,
    askAgent
  }
}
