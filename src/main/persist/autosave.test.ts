// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AutosaveScheduler } from './autosave'

describe('AutosaveScheduler', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('writes 2 s after the last edit and not before (AC-04.3)', async () => {
    vi.useFakeTimers()
    const saved: string[] = []
    const scheduler = new AutosaveScheduler({
      idleMs: 2000,
      maxMs: 30_000,
      save: async (id) => {
        saved.push(id)
      }
    })
    scheduler.touch('doc')
    await vi.advanceTimersByTimeAsync(1999)
    expect(saved).toEqual([])
    scheduler.touch('doc')
    await vi.advanceTimersByTimeAsync(1999)
    expect(saved).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(saved).toEqual(['doc'])
    scheduler.dispose()
  })

  it('writes at 30 s even when edits keep coming (AC-04.3)', async () => {
    vi.useFakeTimers()
    const saved: string[] = []
    const scheduler = new AutosaveScheduler({
      idleMs: 2000,
      maxMs: 30_000,
      save: async (id) => {
        saved.push(id)
      }
    })
    scheduler.touch('doc')
    for (let i = 0; i < 29; i += 1) {
      await vi.advanceTimersByTimeAsync(1000)
      scheduler.touch('doc')
    }
    expect(saved).toEqual([])
    await vi.advanceTimersByTimeAsync(1000)
    expect(saved).toEqual(['doc'])
    scheduler.dispose()
  })
})
