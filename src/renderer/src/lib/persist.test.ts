import { afterEach, describe, expect, it } from 'vitest'
import { localStorageHasDocumentContent, savePersisted, takeLegacyRecents } from './persist'

describe('persisted settings', () => {
  afterEach(() => {
    localStorage.clear()
  })

  it('strips recents with inline content and does not write documents back (AC-04.8, AC-04.12)', () => {
    localStorage.setItem(
      'collabdoc.v1',
      JSON.stringify({
        provider: { enabled: false, kind: 'custom', label: 'x', endpoint: '', apiKey: '', model: '' },
        mcp: [],
        agents: [],
        recents: [
          {
            id: 'old',
            title: 'Notes',
            path: null,
            updatedAt: '2026-01-01T00:00:00.000Z',
            preview: 'hello',
            content: '# Notes\n\nhello'
          }
        ]
      })
    )
    expect(localStorageHasDocumentContent()).toBe(true)
    const legacy = takeLegacyRecents()
    expect(legacy).toHaveLength(1)
    expect(legacy[0].content).toContain('hello')
    expect(localStorageHasDocumentContent()).toBe(false)
    savePersisted({
      provider: { enabled: false, kind: 'custom', label: 'x', endpoint: '', apiKey: '', model: '' },
      mcp: [],
      agents: []
    })
    expect(localStorage.getItem('collabdoc.v1') ?? '').not.toContain('# Notes')
    expect(takeLegacyRecents()).toEqual([])
  })
})
