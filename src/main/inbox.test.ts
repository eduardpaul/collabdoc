// @vitest-environment node
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import type { InboxEntry } from '../shared/types'
import { addToInbox, markInboxRead, mergeInbox, readInbox, setInboxRead } from './inbox'

const from = { id: 'ana', name: 'Ana', color: '#c45c26' }
const entry = (id: string, at: number): InboxEntry => ({
  id,
  docId: 'd1',
  docTitle: 'Doc',
  blockId: 'b1',
  from,
  text: `@you ${id}`,
  at,
  read: false
})

let dir: string | null = null
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true })
  dir = null
})

describe('inbox (10)', () => {
  it('dedupes by request id and keeps newest first (AC-10.3, AC-10.10)', () => {
    const merged = mergeInbox([entry('a', 1)], [entry('a', 1), entry('b', 3), entry('c', 2)])
    expect(merged.map((e) => e.id)).toEqual(['b', 'c', 'a'])
    expect(mergeInbox(merged, [entry('b', 3)])).toBe(merged)
    expect(markInboxRead(merged, ['c']).map((e) => e.read)).toEqual([false, true, false])
    expect(markInboxRead(merged, 'all').every((e) => e.read)).toBe(true)
  })

  it('persists per user on this install', async () => {
    dir = await mkdtemp(join(tmpdir(), 'collabdoc-inbox-'))
    expect(await readInbox(dir, 'u1')).toEqual([])
    const first = await addToInbox(dir, 'u1', [entry('a', 1)])
    expect(first.added).toBe(1)
    const again = await addToInbox(dir, 'u1', [entry('a', 1)])
    expect(again.added).toBe(0)
    expect(await readInbox(dir, 'u2')).toEqual([])
    const read = await setInboxRead(dir, 'u1', 'all')
    expect(read[0].read).toBe(true)
    expect((await readInbox(dir, 'u1'))[0].read).toBe(true)
  })
})
