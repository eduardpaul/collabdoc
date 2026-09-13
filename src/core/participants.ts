import { assignHandles, handleFromName } from '../shared/handles'
import { colorForId } from '../shared/actors'
import type { ActorProfile, AuthorRecord, ParticipantRole, Presence } from '../shared/types'

export type RegistryPerson = {
  id: string
  handle: string
  name: string
  color: string
  role: ParticipantRole
  online: boolean
}

export type RegistryInput = {
  local: ActorProfile
  authors: AuthorRecord[]
  invited: Array<{ id: string; name: string; color?: string; role?: ParticipantRole }>
  onlineIds: ReadonlySet<string>
}

/**
 * Everyone addressable in this document: authors (including offline), the
 * local user, and invited agents. Handles are unique and assigned in
 * `actorId` order so every peer computes the same suffixes.
 */
export function buildParticipantRegistry(input: RegistryInput): {
  people: RegistryPerson[]
  localHandle: string
  handleChanged: boolean
} {
  const byId = new Map<
    string,
    { id: string; name: string; color: string; role: ParticipantRole; handle?: string }
  >()
  const add = (person: {
    id: string
    name: string
    color: string
    role: ParticipantRole
    handle?: string
  }): void => {
    const existing = byId.get(person.id)
    if (!existing) {
      byId.set(person.id, person)
      return
    }
    byId.set(person.id, {
      ...existing,
      name: person.name || existing.name,
      color: person.color || existing.color,
      handle: person.handle ?? existing.handle,
      role: person.role
    })
  }

  add({
    id: input.local.actorId,
    name: input.local.name,
    color: input.local.color,
    role: input.local.role,
    handle: input.local.handle
  })
  for (const author of input.authors) {
    add({
      id: author.actorId,
      name: author.name,
      color: author.color,
      role: author.role,
      handle: author.handle
    })
  }
  for (const agent of input.invited) {
    add({
      id: agent.id,
      name: agent.name,
      color: agent.color ?? colorForId(agent.id),
      role: agent.role ?? 'agent',
      handle: handleFromName(agent.name)
    })
  }

  const ordered = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id))
  const handles = assignHandles(ordered)
  const people: RegistryPerson[] = ordered.map((person) => ({
    id: person.id,
    handle: handles.get(person.id) ?? handleFromName(person.name),
    name: person.name,
    color: person.color,
    role: person.role,
    online: input.onlineIds.has(person.id)
  }))
  const localHandle = handles.get(input.local.actorId) ?? handleFromName(input.local.name)
  const preferred =
    input.local.handle && input.local.handle.length > 0
      ? input.local.handle
      : handleFromName(input.local.name)
  return { people, localHandle, handleChanged: localHandle !== preferred }
}

export type SessionRow = RegistryPerson & {
  status: string
  kind: 'you' | 'agent' | 'peer'
  cursorBlockId?: string
}

export function sessionRows(
  people: RegistryPerson[],
  input: {
    localId: string
    presence: Presence[]
    agentStatus: Record<string, 'idle' | 'working'>
    blockLabel: (blockId: string) => string
  }
): SessionRow[] {
  const byId = new Map(input.presence.map((row) => [row.actorId, row]))
  const invitedOrOnline = people.filter(
    (person) => person.online || person.id === input.localId || person.role === 'agent'
  )
  return invitedOrOnline.map((person) => {
    const live = byId.get(person.id)
    const working = input.agentStatus[person.id] === 'working'
    const typing = live?.cursor?.blockId
    let status = 'idle'
    if (working) status = 'working'
    else if (typing) status = `typing in ${input.blockLabel(typing)}`
    const kind: SessionRow['kind'] =
      person.id === input.localId ? 'you' : person.role === 'agent' ? 'agent' : 'peer'
    return {
      ...person,
      online: person.id === input.localId || person.online,
      status,
      kind,
      cursorBlockId: typing
    }
  })
}
