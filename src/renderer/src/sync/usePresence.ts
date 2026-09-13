import { useEffect, useMemo, useState } from 'react'
import { readAuthors } from '@core/authors'
import { buildParticipantRegistry, sessionRows, type SessionRow } from '@core/participants'
import { Cursor } from 'loro-crdt'
import { BLOCK_ID_ATTR } from '@shared/constants'
import type { Presence } from '@shared/types'
import { asActorProfile } from './identity'
import type { DocumentClient } from './DocumentClient'
import { useAppState } from '../state/AppState'
import { blockIdFromCursor } from '@core/tree'

function readLivePresence(client: DocumentClient): Presence[] {
  const actors: Presence[] = []
  const states = client.presence.getAllStates() as Record<
    string,
    {
      focus?: Uint8Array | null
      user?: { name?: string; color?: string; actorId?: string; role?: 'human' | 'agent' }
      claim?: { blockIds: string[]; until: string }
    }
  >
  for (const [peerId, state] of Object.entries(states)) {
    if (!state) continue
    let cursor: Presence['cursor']
    if (state.focus) {
      try {
        cursor = blockIdFromCursor(client.doc, Cursor.decode(state.focus)) ?? undefined
      } catch {
        cursor = undefined
      }
    }
    const isSelf = peerId === client.doc.peerIdStr
    actors.push({
      actorId: isSelf ? client.profile.actorId : (state.user?.actorId ?? peerId),
      peerId,
      role: isSelf ? client.profile.role : state.user?.role,
      name: isSelf ? client.profile.name : state.user?.name,
      color: isSelf ? client.profile.color : state.user?.color,
      cursor,
      claim:
        state.claim?.until && Date.parse(state.claim.until) > Date.now() ? state.claim : undefined
    })
  }
  return actors
}

function paragraphLabel(client: DocumentClient, blockId: string): string {
  let index = 0
  const json = client.doc.getMap('doc').toJSON() as {
    children?: Array<{ attributes?: { blockId?: string } }>
  }
  const children = json.children ?? []
  for (const child of children) {
    const id = child.attributes?.blockId
    if (!id) continue
    index += 1
    if (id === blockId) return `¶${index}`
  }
  return 'the document'
}

export function usePresence(client: DocumentClient | null): {
  rows: SessionRow[]
  handleNotice: string | null
  scrollTo: (blockId: string) => void
} {
  const { state } = useAppState()
  const [tick, setTick] = useState(0)

  useEffect(() => {
    if (!client) return
    return client.subscribe((event) => {
      if (event.type === 'presence' || event.type === 'change') setTick((n) => n + 1)
    })
  }, [client])

  const built = useMemo(() => {
    void tick
    if (!client) return { rows: [] as SessionRow[], handleNotice: null as string | null }
    const presence = readLivePresence(client)
    const onlineIds = new Set(presence.map((row) => row.actorId))
    onlineIds.add(state.profile.userId)
    const invited = state.agents.filter((agent) => agent.invited)
    const registry = buildParticipantRegistry({
      local: asActorProfile(state.profile),
      authors: Object.values(readAuthors(client.doc)),
      invited: invited.map((agent) => ({ id: agent.id, name: agent.name })),
      onlineIds
    })
    const rows = sessionRows(registry.people, {
      localId: state.profile.userId,
      presence,
      agentStatus: Object.fromEntries(state.agents.map((agent) => [agent.id, agent.status])),
      blockLabel: (blockId) => paragraphLabel(client, blockId)
    })
    return {
      rows,
      handleNotice: registry.handleChanged
        ? `Your handle in this document is @${registry.localHandle} because @${state.profile.handle} is taken.`
        : null
    }
  }, [client, state.agents, state.profile, tick])

  return {
    ...built,
    scrollTo: (blockId: string) => {
      void BLOCK_ID_ATTR
      const editor = window.__collabEditor
      if (!editor) return
      let pos: number | null = null
      editor.state.doc.descendants((node, nodePos) => {
        if (pos !== null) return false
        if (node.attrs?.[BLOCK_ID_ATTR] === blockId) {
          pos = nodePos + 1
          return false
        }
        return true
      })
      if (pos == null) return
      editor.chain().focus().setTextSelection(pos).scrollIntoView().run()
    }
  }
}
