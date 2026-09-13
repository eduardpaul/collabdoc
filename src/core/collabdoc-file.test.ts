// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { SCHEMA_VERSION } from '../shared/constants'
import { ensureAuthor, readAuthors } from './authors'
import {
  COLLABDOC_APP,
  COLLABDOC_MAGIC,
  CollabdocError,
  decodeCollabdoc,
  encodeCollabdoc,
  readCollabdocHeader
} from './collabdoc-file'
import { listThreads, openThread } from './comments'
import { openDocument, readMeta } from './document'
import { listHistory } from './history'
import { SyncHub } from './hub'
import { addParagraph, human } from './test-helpers'
import { allBlocks, blockIdOf, blockPlainText, listAssets } from './tree'

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

describe('collabdoc file format', () => {
  it('starts with CLBDOC01 and a header that parses without loading Loro (AC-04.1)', () => {
    const snapshot = utf8('not-a-real-snapshot')
    const bytes = encodeCollabdoc({
      docId: 'doc-a',
      title: 'Notes',
      snapshot,
      assets: [
        { hash: 'a'.repeat(64), type: 'image/png', bytes: new Uint8Array([1, 2, 3]) },
        { hash: 'a'.repeat(64), type: 'image/png', bytes: new Uint8Array([1, 2, 3]) }
      ]
    })
    expect(new TextDecoder().decode(bytes.subarray(0, 8))).toBe(COLLABDOC_MAGIC)
    const header = readCollabdocHeader(bytes)
    expect(header).toMatchObject({
      docId: 'doc-a',
      title: 'Notes',
      schemaVersion: SCHEMA_VERSION,
      app: COLLABDOC_APP,
      snapshotBytes: snapshot.byteLength
    })
    expect(header.assets).toHaveLength(1)
    expect(header.assets[0]).toMatchObject({ hash: 'a'.repeat(64), size: 3, offset: 0 })
  })

  it('round-trips a hub snapshot: text, block ids, authors, comments, history (AC-04.1, AC-04.2)', () => {
    const hub = SyncHub.create({ title: 'Plan' })
    const ana = human(hub, 'ana')
    ensureAuthor(hub.doc, { actorId: 'ana', name: 'Ana', color: '#c45c26', role: 'human' })
    const blockId = addParagraph(ana, 'Hello persistence')
    openThread(hub.doc, {
      blockId,
      quote: 'Hello',
      start: 0,
      end: 5,
      anchorStart: 'a',
      anchorEnd: 'b',
      author: { id: 'ana', name: 'Ana', role: 'human', color: '#c45c26' },
      body: 'Keep this'
    })
    hub.commitLocal('commented')
    const before = {
      meta: readMeta(hub.doc),
      text: allBlocks(hub.doc).map(({ node }) => blockPlainText(node)),
      blockIds: allBlocks(hub.doc).map(({ node }) => blockIdOf(node)),
      authors: readAuthors(hub.doc),
      comments: listThreads(hub.doc, { status: 'all' }).map((thread) => ({
        id: thread.id,
        body: thread.body,
        blockId: thread.blockId
      })),
      history: listHistory(hub.doc).map((entry) => ({
        id: entry.id,
        timestamp: entry.timestamp,
        message: entry.message,
        actorId: entry.author.actorId,
        name: entry.author.name
      })),
      changes: listHistory(hub.doc).length
    }

    const bytes = encodeCollabdoc({
      docId: before.meta.docId,
      title: before.meta.title,
      snapshot: hub.snapshot()
    })
    const decoded = decodeCollabdoc(bytes)
    const again = openDocument(decoded.snapshot)

    expect(readMeta(again).docId).toBe(before.meta.docId)
    expect(readMeta(again).title).toBe('Plan')
    expect(allBlocks(again).map(({ node }) => blockPlainText(node))).toEqual(before.text)
    expect(allBlocks(again).map(({ node }) => blockIdOf(node))).toEqual(before.blockIds)
    expect(readAuthors(again)).toEqual(before.authors)
    expect(
      listThreads(again, { status: 'all' }).map((thread) => ({
        id: thread.id,
        body: thread.body,
        blockId: thread.blockId
      }))
    ).toEqual(before.comments)
    expect(listHistory(again)).toHaveLength(before.changes)
    expect(
      listHistory(again).map((entry) => ({
        id: entry.id,
        timestamp: entry.timestamp,
        message: entry.message,
        actorId: entry.author.actorId,
        name: entry.author.name
      }))
    ).toEqual(before.history)
  })

  it('refuses a newer magic and a newer schemaVersion without needing the snapshot (AC-04.10)', () => {
    const current = encodeCollabdoc({ docId: 'd', title: 't', snapshot: utf8('snap') })
    const newerMagic = new Uint8Array(current)
    newerMagic.set(new TextEncoder().encode('CLBDOC02'), 0)
    expect(() => readCollabdocHeader(newerMagic)).toThrow(CollabdocError)
    expect(() => readCollabdocHeader(newerMagic)).toThrow(/newer CollabDoc format \(CLBDOC02\)/)

    const unknown = new Uint8Array(current)
    unknown.set(new TextEncoder().encode('NOTADOC!'), 0)
    expect(() => readCollabdocHeader(unknown)).toThrow(/not a CollabDoc file/)

    const newerSchema = encodeCollabdoc({
      docId: 'd',
      title: 't',
      schemaVersion: SCHEMA_VERSION + 1,
      snapshot: utf8('snap')
    })
    expect(readCollabdocHeader(newerSchema).schemaVersion).toBe(SCHEMA_VERSION + 1)
    expect(() => decodeCollabdoc(newerSchema)).toThrow(/schema version/)
  })

  it('opens a truncated asset section with missing hashes and a warning (AC-04.13)', () => {
    const png = new Uint8Array([9, 8, 7, 6])
    const bytes = encodeCollabdoc({
      docId: 'd',
      title: 't',
      snapshot: utf8('snap'),
      assets: [{ hash: 'b'.repeat(64), type: 'image/png', bytes: png }]
    })
    const truncated = bytes.subarray(0, bytes.byteLength - 2)
    const decoded = decodeCollabdoc(truncated)
    expect(new TextDecoder().decode(decoded.snapshot)).toBe('snap')
    expect(decoded.missing).toEqual(['b'.repeat(64)])
    expect(decoded.warnings).toEqual(['truncated-assets'])
    expect(decoded.assets).toEqual([])
  })

  it('stores duplicate image figures once and drops unreferenced assets on encode (AC-04.13)', () => {
    const one = new Uint8Array([1, 1, 1])
    const two = new Uint8Array([2, 2])
    const bytes = encodeCollabdoc({
      docId: 'd',
      title: 't',
      snapshot: utf8('snap'),
      assets: [
        { hash: 'c'.repeat(64), type: 'image/png', bytes: one },
        { hash: 'c'.repeat(64), type: 'image/png', bytes: one },
        { hash: 'd'.repeat(64), type: 'image/jpeg', bytes: two }
      ]
    })
    const decoded = decodeCollabdoc(bytes)
    expect(decoded.header.assets).toHaveLength(2)
    expect(decoded.assets.map((asset) => asset.hash)).toEqual(['c'.repeat(64), 'd'.repeat(64)])
    expect(listAssets(SyncHub.create().doc)).toEqual([])
  })
})
