// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { AUTHORS_KEY, META_KEY, ROOT_DOC_KEY } from '../shared/constants'
import { createDocument, openDocument, readMeta, setTitle } from './document'
import { allBlocks, blockIdOf, blockPlainText, nodeName } from './tree'

describe('createDocument', () => {
  it('starts with metadata and one empty paragraph that has a block id', () => {
    const doc = createDocument({ docId: 'doc-1', title: 'Notes' })
    const meta = readMeta(doc)
    expect(meta.docId).toBe('doc-1')
    expect(meta.title).toBe('Notes')
    expect(meta.schemaVersion).toBe(1)
    expect(meta.createdAt).toBeGreaterThan(0)

    const blocks = allBlocks(doc)
    expect(blocks).toHaveLength(1)
    expect(nodeName(blocks[0].node)).toBe('paragraph')
    expect(blockIdOf(blocks[0].node)).toMatch(/^b_[0-9a-f]{10}$/)
    expect(blockPlainText(blocks[0].node)).toBe('')
  })

  it('assigns a random peer id and a random doc id by default', () => {
    const a = createDocument()
    const b = createDocument()
    expect(a.peerIdStr).not.toBe(b.peerIdStr)
    expect(a.peerIdStr).not.toBe('1')
    expect(readMeta(a).docId).not.toBe(readMeta(b).docId)
    expect(readMeta(a).title).toBe('Untitled')
  })

  it('has no seed text and no authors before anyone writes', () => {
    const doc = createDocument()
    const json = JSON.stringify(doc.toJSON())
    expect(json).not.toContain('Collaborative canvas')
    expect(json).not.toContain('b_seed')
    expect(doc.getMap(AUTHORS_KEY).size).toBe(0)
    expect(Object.keys(doc.toJSON())).toEqual(expect.arrayContaining([META_KEY, ROOT_DOC_KEY]))
  })

  it('records timestamps on every commit', () => {
    const doc = createDocument()
    const changes = [...doc.getAllChanges().values()].flat()
    expect(changes.length).toBeGreaterThan(0)
    expect(changes.every((change) => change.timestamp > 0)).toBe(true)
  })

  it('reopens from a snapshot with the same metadata and text styles', () => {
    const doc = createDocument({ title: 'Snap' })
    setTitle(doc, 'Renamed', 'sys:test')
    const reopened = openDocument(doc.export({ mode: 'snapshot' }))
    expect(readMeta(reopened)).toEqual(readMeta(doc))
    expect(reopened.peerIdStr).not.toBe(doc.peerIdStr)
  })

  it('readMeta tolerates a document without metadata', () => {
    const doc = openDocument(createDocument().export({ mode: 'snapshot' }))
    doc.getMap(META_KEY).delete('title')
    expect(readMeta(doc).title).toBe('')
  })
})
