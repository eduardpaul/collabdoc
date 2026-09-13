import { useCallback, useEffect, useMemo, useState } from 'react'
import { listThreads } from '@core/comments'
import { COMMENTS_SEEN_KEY, HISTORY_SETTLE_MS } from '@shared/constants'
import type { CommentThread } from '@shared/types'
import { CommentsApi } from './comments-api'
import type { DocumentClient } from './DocumentClient'

export type CommentsView = {
  threads: CommentThread[]
  version: number
  api: CommentsApi | null
  /** Threads with replies the user has not looked at (per user, local). */
  unread: ReadonlySet<string>
  markRead: (threadId: string) => void
}

const EMPTY: CommentsView = {
  threads: [],
  version: 0,
  api: null,
  unread: new Set(),
  markRead: () => undefined
}

/**
 * Every thread in the document, refreshed a beat after changes settle, plus
 * orphan bookkeeping and the per-user unread state.
 */
export function useComments(client: DocumentClient | null, userId: string): CommentsView {
  const api = useMemo(() => (client ? new CommentsApi(client) : null), [client])
  const [version, setVersion] = useState(0)
  const seenKey = client ? `${COMMENTS_SEEN_KEY}.${userId}.${client.docId}` : ''
  // Seen counts for the current document; a different document re-reads storage.
  const [seenState, setSeenState] = useState<{ key: string; value: Record<string, number> }>({
    key: '',
    value: {}
  })
  const seen = useMemo(
    () => (seenState.key === seenKey ? seenState.value : loadSeen(seenKey)),
    [seenState, seenKey]
  )

  useEffect(() => {
    if (!client || !api) return
    let timer: number | null = null
    const stop = client.subscribe((event) => {
      if (event.type !== 'change') return
      if (timer != null) window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        if (client.status === 'live') api.refreshOrphans()
        setVersion((n) => n + 1)
      }, HISTORY_SETTLE_MS)
    })
    return () => {
      if (timer != null) window.clearTimeout(timer)
      stop()
    }
  }, [client, api])

  const threads = useMemo(
    () => (client ? listThreads(client.doc, { status: 'all' }) : []),
    // Re-read when the document changed, not when the client identity did.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [client, version]
  )

  const unread = useMemo(() => unreadThreads(threads, seen, userId), [threads, seen, userId])

  const markRead = useCallback(
    (threadId: string) => {
      const thread = threads.find((t) => t.id === threadId)
      if (!thread || seen[threadId] === thread.replies.length) return
      const next = { ...seen, [threadId]: thread.replies.length }
      storeSeen(seenKey, next)
      setSeenState({ key: seenKey, value: next })
    },
    [threads, seen, seenKey]
  )

  if (!client || !api) return EMPTY
  return { threads, version, api, unread, markRead }
}

/** A thread is unread when someone else replied since the user last opened it. */
export function unreadThreads(
  threads: CommentThread[],
  seen: Record<string, number>,
  userId: string
): Set<string> {
  const out = new Set<string>()
  for (const thread of threads) {
    const count = thread.replies.length
    if (count === 0 || count <= (seen[thread.id] ?? 0)) continue
    const last = thread.replies[count - 1]
    if (last.author.id === userId) continue
    out.add(thread.id)
  }
  return out
}

function loadSeen(key: string): Record<string, number> {
  if (!key) return {}
  try {
    const raw = localStorage.getItem(key)
    const parsed = raw ? (JSON.parse(raw) as unknown) : null
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, number>) : {}
  } catch {
    return {}
  }
}

function storeSeen(key: string, value: Record<string, number>): void {
  if (!key) return
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* private mode or full storage: unread state is a convenience */
  }
}
