// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { encodeCollabdoc } from './collabdoc-file'
import { readMeta } from './document'
import { listHistory } from './history'
import { SyncHub } from './hub'
import { addParagraph, expectOk, human } from './test-helpers'

describe('presence is ephemeral (AC-07.7)', () => {
  it('never appears in history or a .collabdoc snapshot', () => {
    const hub = SyncHub.create({ title: 'Notes' })
    const ana = human(hub, 'ana')
    const blockId = addParagraph(ana, 'visible text')
    expectOk(
      ana.call('set_presence', {
        cursor: { blockId, offset: 2 },
        claimBlockIds: [blockId],
        claimSeconds: 60
      })
    )
    const until = (
      ana.call('get_presence', {}) as {
        actors: Array<{ claim?: { until: string } }>
      }
    ).actors.find((p) => p.claim)?.claim?.until
    expect(until).toBeTruthy()

    const history = JSON.stringify(listHistory(hub.doc))
    expect(history).not.toContain('presence')
    expect(history).not.toMatch(/claim/i)
    if (until) expect(history).not.toContain(until)

    const bytes = encodeCollabdoc({
      docId: readMeta(hub.doc).docId,
      title: 'Notes',
      snapshot: hub.snapshot()
    })
    const file = new TextDecoder().decode(bytes)
    expect(file).not.toContain(until ?? 'no-until')
    expect(file).not.toContain('"anchor"')
    expect(file).not.toContain('claimSeconds')
  })
})
