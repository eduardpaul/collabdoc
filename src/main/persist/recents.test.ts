// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { capRecent, RECENTS_ENTRY_MAX_BYTES, RECENTS_LIMIT, upsertRecent } from './recents'

describe('recents index', () => {
  it('caps the list at 50, newest first, and keeps each entry small (AC-04.8)', () => {
    let recents: ReturnType<typeof upsertRecent> = []
    for (let i = 0; i < 60; i += 1) {
      recents = upsertRecent(recents, {
        docId: `doc-${i}`,
        title: `Title ${i}`,
        path: `/tmp/doc-${i}.collabdoc`,
        updatedAt: new Date(1_700_000_000_000 + i * 1000).toISOString(),
        preview: 'x'.repeat(120)
      })
    }
    expect(recents).toHaveLength(RECENTS_LIMIT)
    expect(recents[0].docId).toBe('doc-59')
    expect(recents[49].docId).toBe('doc-10')
    expect(recents.every((item) => JSON.stringify(item).length <= RECENTS_ENTRY_MAX_BYTES)).toBe(
      true
    )
  })

  it('truncates oversized preview and path so the entry stays under 1 KB', () => {
    const capped = capRecent({
      docId: 'd',
      title: 'T',
      path: `/very/${'long/'.repeat(80)}file.collabdoc`,
      updatedAt: '2026-01-01T00:00:00.000Z',
      preview: 'p'.repeat(500)
    })
    expect(JSON.stringify(capped).length).toBeLessThanOrEqual(RECENTS_ENTRY_MAX_BYTES)
  })
})
