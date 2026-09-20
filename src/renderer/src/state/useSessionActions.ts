import type { RunRequest } from '@shared/agents'
import { useAppState } from './AppState'
import { resolveBackend } from './selectors'
import type { AppState } from '../types'
import type { DocxExportConfig } from '@shared/docx-config'
import { parseDocument, previewOf, serializeDocument } from '../lib/document-file'
import { configForDocument, runDocxExport } from '../lib/docx-export'
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
  exportMarkdown: (options?: { includeComments?: boolean; path?: string }) => void
  exportDocx: (options?: { config?: DocxExportConfig; path?: string }) => void
  openDocxExport: () => void
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
  /** Start a turn on the agent's backend; false when nothing can run it. */
  askAgent: (
    agent: Agent,
    prompt: string,
    options?: { kind?: RunRequest['kind']; context?: RunRequest['context'] }
  ) => boolean
  cancelRun: (runId: string) => void
  /** Re-detect the CLI backends (after signing in, installing, …). */
  refreshBackends: () => Promise<void>
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
        if (saveAs) {
          dispatch({ type: 'set-save-as-open', open: true })
          return false
        }
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
      if ('exportTo' in result && result.exportTo) {
        // Save As to .md/.docx is an export: the .collabdoc path and dirty state stay as they are.
        if (result.exportTo.format === 'markdown') {
          await exportMarkdown({ path: result.exportTo.path })
        } else {
          await exportDocx({ path: result.exportTo.path })
        }
        return false
      }
      if (!('path' in result)) return false
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

  const exportMarkdown = async (
    options: { includeComments?: boolean; path?: string } = {}
  ): Promise<void> => {
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
      path: options.path,
      extras: extrasFromDoc(content)
    })
    if (!result.ok) {
      if (!result.canceled) fail(new Error(result.error))
      return
    }
    const name = 'name' in result ? result.name : 'Markdown'
    dispatch({ type: 'notice', message: `Exported ${name}` })
  }

  const exportDocx = async (
    options: { config?: DocxExportConfig; path?: string } = {}
  ): Promise<void> => {
    const session = state.session
    const client = session ? getClient(session.id) : undefined
    if (!session || !client || client.status !== 'live') return
    const config = options.config ?? configForDocument(client, state.docxDefaults)
    const abort = new AbortController()
    const onCancel = (): void => abort.abort()
    dispatch({ type: 'notice', message: 'Exporting Word document…', onCancel })
    const result = await runDocxExport({
      client,
      config,
      author: state.profile.name,
      title: session.title,
      path: options.path,
      signal: abort.signal,
      onProgress: (message) => dispatch({ type: 'notice', message, onCancel })
    })
    if (!result.ok) {
      if (result.canceled) {
        dispatch({ type: 'notice', message: 'Export cancelled' })
        return
      }
      fail(new Error(result.error))
      return
    }
    const warnings = result.report.warnings
    const count = warnings.length
    dispatch({
      type: 'push-activity',
      event: {
        actor: 'You',
        kind: 'system',
        summary:
          count === 0
            ? `Exported ${result.name}`
            : `Exported ${result.name} with ${count} warning${count === 1 ? '' : 's'}`
      }
    })
    if (count === 0) {
      dispatch({ type: 'notice', message: `Exported ${result.name}` })
      return
    }
    dispatch({
      type: 'notice',
      message: `Exported with ${count} warning${count === 1 ? '' : 's'} — Details`,
      warnings
    })
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

  const refreshBackends = async (): Promise<void> => {
    const result = await window.api?.agents.listBackends(true)
    if (result?.ok) dispatch({ type: 'set-backends', backends: result.backends })
  }

  /**
   * One turn for an invited agent (17). The run lives in main: the CLI is
   * launched against the document MCP server as the persona, and progress
   * comes back as `agents:event` batches that the reducer folds into
   * `runs`, the agent's status and Activity.
   */
  const askAgent = (
    agent: Agent,
    prompt: string,
    options: { kind?: RunRequest['kind']; context?: RunRequest['context'] } = {}
  ): boolean => {
    const session = state.session
    if (!session) return false
    if (!window.api?.agents) {
      dispatch({
        type: 'notice',
        message: 'Agents need the desktop app: CLI backends run in main.'
      })
      return false
    }
    const trimmed = prompt.trim()
    const fallback =
      agent.role === 'writer'
        ? 'Draft the next section from the current document.'
        : 'Review the document for structure, claims, and tone.'
    const task = trimmed || fallback
    dispatch({ type: 'update-agent', id: agent.id, patch: { status: 'queued', invited: true } })
    void startRun(state, agent, session, task, options)
    return true
  }

  /**
   * Resolve the backend, waiting for Detect when nothing has answered yet
   * (the first seconds after launch), then hand the run to main.
   */
  const startRun = async (
    snapshot: AppState,
    agent: Agent,
    session: NonNullable<AppState['session']>,
    task: string,
    options: { kind?: RunRequest['kind']; context?: RunRequest['context'] }
  ): Promise<void> => {
    let current = snapshot
    if (current.backends.length === 0) {
      const result = await window.api!.agents.listBackends()
      if (result.ok) {
        dispatch({ type: 'set-backends', backends: result.backends })
        current = { ...current, backends: result.backends }
      }
    }
    const backend = resolveBackend(current, agent)
    if (!backend) {
      dispatch({ type: 'update-agent', id: agent.id, patch: { status: 'idle' } })
      const pinned = agent.provider.kind === 'backend' ? agent.provider.id : null
      dispatch({
        type: 'notice',
        message: pinned
          ? `${agent.name} is set to ${pinned}, which is not available. Detect it in Settings → Backends or pick another.`
          : 'No CLI backend is available. Install and sign in to Claude Code, grok or another CLI, then Detect.'
      })
      dispatch({ type: 'open-settings', tab: 'backends' })
      return
    }
    const request: RunRequest = {
      docId: session.id,
      docTitle: session.title,
      kind: options.kind ?? 'ask',
      persona: {
        id: agent.id,
        name: agent.name,
        handle: agent.handle,
        role: agent.role,
        color: agent.color,
        instructions: agent.persona,
        skills: agent.skills
      },
      backendId: backend.id,
      prompt: task,
      sourceIds: agent.sources,
      context: options.context
    }
    const result = await window.api!.agents.run(request)
    if (!result.ok) {
      dispatch({ type: 'update-agent', id: agent.id, patch: { status: 'idle' } })
      dispatch({ type: 'notice', message: result.error })
      return
    }
    dispatch({ type: 'run-events', events: [{ type: 'run', record: result.record }] })
    if (result.record.status === 'error' && result.record.error) {
      dispatch({ type: 'notice', message: result.record.error.message })
    }
  }

  const cancelRun = (runId: string): void => {
    void window.api?.agents.cancel(runId)
  }

  return {
    newDocument: () => request('new'),
    openDocument: () => request('open'),
    importMarkdown,
    exportMarkdown: (options) => {
      void exportMarkdown(options)
    },
    exportDocx: (options) => {
      void exportDocx(options)
    },
    openDocxExport: () => {
      if (!state.session) return
      dispatch({ type: 'notice', message: null })
      dispatch({ type: 'set-docx-export-open', open: true })
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
    askAgent,
    cancelRun,
    refreshBackends
  }
}
