// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { MutationResult } from '../shared/types'
import { SyncHub } from './hub'
import type { DocumentSession } from './session'
import { addParagraph, textOf, writer } from './test-helpers'
import { blockPlainText, findBlock } from './tree'

/** Deterministic PRNG so a failing seed can be replayed. */
function rng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 0x1_0000_0000
  }
}

const WORDS = ['alpha', 'beta', 'gamma', 'delta', 'omega', 'zeta']

/** One random edit against the current text of the block, through the tools. */
function randomEdit(session: DocumentSession, blockId: string, random: () => number): void {
  const text = textOf(session, blockId)
  const roll = random()
  let result: MutationResult
  if (roll < 0.45 || text.length === 0) {
    const word = ` ${WORDS[Math.floor(random() * WORDS.length)]}`
    const at = Math.floor(random() * (text.length + 1))
    result = session.call('insert_text', {
      blockId,
      text: word,
      at: { start: at }
    }) as MutationResult
  } else if (roll < 0.8) {
    const start = Math.floor(random() * text.length)
    const end = Math.min(text.length, start + 1 + Math.floor(random() * 6))
    const expected = text.slice(start, end)
    result = session.call('replace_text', {
      blockId,
      locator: { start, end, expected },
      text: random() < 0.5 ? '' : WORDS[Math.floor(random() * WORDS.length)]
    }) as MutationResult
  } else {
    const start = Math.floor(random() * text.length)
    const end = Math.min(text.length, start + 1 + Math.floor(random() * 4))
    result = session.call('apply_marks', {
      blockId,
      marks: [
        {
          op: random() < 0.7 ? 'add' : 'remove',
          type: 'bold',
          range: { start, end, expected: text.slice(start, end) }
        }
      ]
    }) as MutationResult
  }
  if (!result.ok && result.error !== 'invalid_locator') {
    throw new Error(`unexpected failure: ${result.error} ${result.message}`)
  }
}

describe('concurrent edits converge (AC-02.7)', () => {
  it('random interleavings from two sessions end in the same text everywhere', () => {
    const ITERATIONS = 200
    for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
      const random = rng(1000 + iteration)
      const hub = SyncHub.create()
      const a = writer(hub, 'nova')
      const b = writer(hub, 'rex')
      const blockId = addParagraph(a, 'alpha beta gamma')

      const steps = 4 + Math.floor(random() * 8)
      for (let step = 0; step < steps; step += 1) {
        randomEdit(random() < 0.5 ? a : b, blockId, random)
      }

      const onHub = blockPlainText(findBlock(hub.doc, blockId)!.node)
      expect(textOf(a, blockId), `seed ${1000 + iteration}`).toBe(onHub)
      expect(textOf(b, blockId), `seed ${1000 + iteration}`).toBe(onHub)
      expect(a.doc.version().toJSON(), `seed ${1000 + iteration}`).toEqual(b.doc.version().toJSON())
      a.dispose()
      b.dispose()
    }
  })

  it('offline divergence merges to the same text after both sides sync', () => {
    for (let iteration = 0; iteration < 60; iteration += 1) {
      const random = rng(5000 + iteration)
      const hub = SyncHub.create()
      const a = writer(hub, 'nova')
      const blockId = addParagraph(a, 'alpha beta gamma delta')

      // Fork a second document that will edit without hearing from the hub.
      const offline = SyncHub.fromSnapshot(hub.snapshot())
      const b = writer(offline, 'rex')
      const from = offline.doc.version()
      const fromA = hub.doc.version()

      const steps = 3 + Math.floor(random() * 5)
      for (let step = 0; step < steps; step += 1) {
        randomEdit(a, blockId, random)
        randomEdit(b, blockId, random)
      }

      // Exchange exactly the missed updates in both directions.
      hub.applyUpdate('offline', offline.doc.export({ mode: 'update', from }))
      offline.applyUpdate('hub', hub.doc.export({ mode: 'update', from: fromA }))

      const onHub = blockPlainText(findBlock(hub.doc, blockId)!.node)
      expect(textOf(a, blockId), `seed ${5000 + iteration}`).toBe(onHub)
      expect(textOf(b, blockId), `seed ${5000 + iteration}`).toBe(onHub)
    }
  })
})
