import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { commentRequests, documentRequests, requestInstruction } from '@core/mentions'
import type { RegistryPerson } from '@core/participants'
import { HISTORY_SETTLE_MS } from '@shared/constants'
import type { InboxEntry, MentionRequest, MentionState, MentionTarget } from '@shared/types'
import type { SendRequest } from '../editor/mentions'
import { inboxStore, type InboxStore } from '../lib/inbox'
import type { DocumentClient } from './DocumentClient'

export type AgentDispatch = {
  /** Start a run; false when it cannot start (no provider, agent gone). */
  invoke: (target: MentionTarget, instruction: string, context: MentionRequest) => boolean
  /** Agent ids currently running. Requests to an agent finish when it stops. */
  working: ReadonlySet<string>
}

export type MentionsView = {
  inbox: InboxEntry[]
  unread: number
  /** Enter on a request paragraph. */
  send: (request: SendRequest) => boolean
  markRead: (ids: string[] | 'all') => void
}

const DISPATCHED_KEY = 'collabdoc.mentions.dispatched'

/**
 * Requests both ways. Outgoing: an agent target starts a run and the chip
 * follows it (queued → working → done | failed); a person target needs
 * nothing more, because recipients find requests in the document itself.
 * Incoming: the synced document is scanned after every change — chips with
 * `sentAt` and comments naming my handle — and anything new lands in the
 * per-install inbox; opening it marks the sender's chip `seen`.
 */
export function useMentions(input: {
  client: DocumentClient | null
  docTitle: string
  me: { id: string; name: string; color: string; handle: string }
  people: RegistryPerson[]
  agents: AgentDispatch
  authorOf: (blockId: string) => { id: string; name: string; color: string } | undefined
  /** Writes state onto a chip in the open editor; false when the chip is not on screen. */
  setChip: (requestId: string, state: MentionState) => boolean
}): MentionsView {
  const { client, docTitle, me, people, agents, authorOf, setChip } = input
  const store = useMemo<InboxStore>(() => inboxStore(), [])
  const [inbox, setInbox] = useState<InboxEntry[]>([])
  const [version, setVersion] = useState(0)
  // Agent requests in flight: requestId → agent id. Comment mentions that
  // already produced a run, so a rescan never runs them twice.
  const inFlight = useRef(new Map<string, string>())
  const dispatched = useRef(loadDispatched(me.id))
  const latest = useRef({ people, agents, authorOf, docTitle, me, setChip })
  useEffect(() => {
    latest.current = { people, agents, authorOf, docTitle, me, setChip }
  })

  useEffect(() => {
    let alive = true
    void store.list(me.id).then((entries) => {
      if (alive) setInbox(entries)
    })
    return () => {
      alive = false
    }
  }, [store, me.id])

  useEffect(() => {
    if (!client) return
    let timer: number | null = null
    const stop = client.subscribe((event) => {
      if (event.type !== 'change') return
      if (timer != null) window.clearTimeout(timer)
      timer = window.setTimeout(() => setVersion((n) => n + 1), HISTORY_SETTLE_MS)
    })
    return () => {
      if (timer != null) window.clearTimeout(timer)
      stop()
    }
  }, [client])

  // Chip state is document content, written through the editor so the view
  // follows; a chip in a document that is not open keeps its last state.
  const setState = useCallback((requestId: string, state: MentionState) => {
    latest.current.setChip(requestId, state)
  }, [])

  // Scan the document for requests addressed to me, and for comment
  // mentions of agents that I wrote and still owe a run.
  useEffect(() => {
    if (!client || client.status !== 'live') return
    const {
      people: roster,
      authorOf: author,
      docTitle: title,
      me: self,
      agents: runs
    } = latest.current
    const resolve = (handle: string): MentionTarget | null => {
      const person = roster.find((p) => p.handle.toLowerCase() === handle.toLowerCase())
      return person
        ? {
            kind: person.role === 'agent' ? 'agent' : 'person',
            id: person.id,
            handle: person.handle,
            label: person.name
          }
        : null
    }
    const fromFor = (blockId: string): MentionRequest['from'] =>
      author(blockId) ?? { id: 'unknown', name: 'Someone', color: '#8a7d6d' }
    const requests = [
      ...documentRequests(client.doc, client.docId, fromFor),
      ...commentRequests(client.doc, client.docId, resolve)
    ]
    const mine = requests.filter((r) => r.target.kind === 'person' && r.target.id === self.id)
    if (mine.length) {
      const entries = mine.map((r) => toEntry(r, title))
      void store.add(self.id, entries).then((result) => {
        if (result.added > 0) setInbox(result.entries)
      })
    }
    for (const request of requests) {
      if (request.origin !== 'comment' || request.target.kind !== 'agent') continue
      if (request.from.id !== self.id || dispatched.current.has(request.requestId)) continue
      dispatched.current.add(request.requestId)
      storeDispatched(self.id, dispatched.current)
      runs.invoke(request.target, requestInstruction(request.text, request.target.handle), request)
    }
    // The version bump is the trigger; the rest is read through `latest`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, version, store])

  // Chips follow the agent: working while it runs, done when it stops.
  useEffect(() => {
    for (const [requestId, agentId] of inFlight.current) {
      if (agents.working.has(agentId)) {
        setState(requestId, 'working')
      } else {
        inFlight.current.delete(requestId)
        setState(requestId, 'done')
      }
    }
  }, [agents.working, setState])

  const send = useCallback(
    (request: SendRequest): boolean => {
      if (!client) return false
      const { target } = request
      if (target.kind === 'person') return true
      const context: MentionRequest = {
        requestId: request.requestId,
        docId: client.docId,
        origin: 'document',
        blockId: request.blockId,
        target,
        from: { id: me.id, name: me.name, color: me.color },
        text: request.text,
        at: Date.now()
      }
      const started = agents.invoke(
        target,
        requestInstruction(request.text, target.handle),
        context
      )
      if (!started) {
        // The chip is stamped by the caller as sent; mark the outcome next tick.
        window.setTimeout(() => setState(request.requestId, 'failed'), 0)
        return true
      }
      inFlight.current.set(request.requestId, target.id)
      return true
    },
    [client, agents, me, setState]
  )

  const markRead = useCallback(
    (ids: string[] | 'all') => {
      void store.markRead(me.id, ids).then((entries) => {
        setInbox(entries)
        const seen = ids === 'all' ? entries.map((e) => e.id) : ids
        for (const id of seen) setState(id, 'seen')
      })
    },
    [store, me.id, setState]
  )

  return {
    inbox,
    unread: inbox.filter((e) => !e.read).length,
    send,
    markRead
  }
}

function toEntry(request: MentionRequest, docTitle: string): InboxEntry {
  return {
    id: request.requestId,
    docId: request.docId,
    docTitle,
    blockId: request.blockId,
    threadId: request.threadId,
    from: request.from,
    text: request.text,
    at: request.at,
    read: false
  }
}

function loadDispatched(userId: string): Set<string> {
  try {
    const raw = localStorage.getItem(`${DISPATCHED_KEY}.${userId}`)
    const parsed = raw ? (JSON.parse(raw) as unknown) : []
    return new Set(Array.isArray(parsed) ? (parsed as string[]) : [])
  } catch {
    return new Set()
  }
}

function storeDispatched(userId: string, ids: Set<string>): void {
  try {
    localStorage.setItem(`${DISPATCHED_KEY}.${userId}`, JSON.stringify([...ids].slice(-500)))
  } catch {
    /* fine */
  }
}
