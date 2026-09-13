// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { buildParticipantRegistry, sessionRows } from './participants'

describe('participant registry (AC-07.9)', () => {
  it('assigns the same handle suffixes from actorId order on every peer', () => {
    const local = {
      actorId: 'b-id',
      name: 'Bob',
      color: '#111',
      role: 'human' as const,
      handle: 'ana'
    }
    const input = {
      local,
      authors: [
        { actorId: 'a-id', name: 'Ann', color: '#222', role: 'human' as const, handle: 'ana' },
        { actorId: 'b-id', name: 'Bob', color: '#111', role: 'human' as const, handle: 'ana' }
      ],
      invited: [{ id: 'agent_writer', name: 'Writer' }],
      onlineIds: new Set(['b-id'])
    }
    const host = buildParticipantRegistry(input)
    const guest = buildParticipantRegistry(input)
    expect(host.people.map((p) => `${p.id}:${p.handle}`)).toEqual(
      guest.people.map((p) => `${p.id}:${p.handle}`)
    )
    expect(host.people.find((p) => p.id === 'a-id')?.handle).toBe('ana')
    expect(host.people.find((p) => p.id === 'b-id')?.handle).toBe('ana-2')
    expect(host.handleChanged).toBe(true)
    expect(host.localHandle).toBe('ana-2')
    expect(host.people.find((p) => p.id === 'a-id')?.online).toBe(false)
  })

  it('session rows include the local user and invited idle agents, not a waiting placeholder', () => {
    const registry = buildParticipantRegistry({
      local: { actorId: 'me', name: 'You', color: '#c45c26', role: 'human', handle: 'you' },
      authors: [],
      invited: [{ id: 'agent_writer', name: 'Writer' }],
      onlineIds: new Set(['me'])
    })
    const rows = sessionRows(registry.people, {
      localId: 'me',
      presence: [
        {
          actorId: 'me',
          peerId: '1',
          role: 'human',
          name: 'You',
          color: '#c45c26',
          cursor: { blockId: 'b_aaa', offset: 0 }
        }
      ],
      agentStatus: { agent_writer: 'idle' },
      blockLabel: () => '¶1'
    })
    expect(rows.map((r) => r.id)).toEqual(['agent_writer', 'me'])
    expect(rows.find((r) => r.id === 'me')?.status).toBe('typing in ¶1')
    expect(rows.find((r) => r.id === 'agent_writer')?.status).toBe('idle')
    expect(rows.some((r) => /waiting/i.test(r.name))).toBe(false)
  })
})
