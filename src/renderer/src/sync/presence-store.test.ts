import { afterEach, describe, expect, it, vi } from 'vitest'
import { PresenceStore } from './presence-store'

describe('PresenceStore', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('throttles cursor writes to 20 Hz (AC-07.8)', () => {
    vi.useFakeTimers()
    const store = new PresenceStore('1', 15_000, 20)
    store.setUser({ actorId: 'me', name: 'You', color: '#c45c26', role: 'human' })
    let writes = 0
    store.subscribeLocalUpdates(() => {
      writes += 1
    })
    for (let i = 0; i < 50; i += 1) store.setLocal({ user: { name: 'You', color: '#c45c26' } })
    expect(writes).toBe(1)
    vi.advanceTimersByTime(49)
    expect(writes).toBe(1)
    vi.advanceTimersByTime(1)
    expect(writes).toBe(2)
    store.clear()
  })

  it('drops a claim once until has passed (AC-07.6)', () => {
    const store = new PresenceStore('1')
    store.setUser({ actorId: 'me', name: 'You', color: '#c45c26', role: 'human' })
    store.setClaim({ blockIds: ['b_aaa'], until: new Date(Date.now() + 60_000).toISOString() })
    expect(store.claims()).toHaveLength(1)
    store.setClaim({ blockIds: ['b_aaa'], until: new Date(Date.now() - 1000).toISOString() })
    expect(store.claims()).toHaveLength(0)
    store.clear()
  })
})
