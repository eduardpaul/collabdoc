// @vitest-environment node
import { mkdir, readFile, rm, stat, utimes, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { decodeCollabdoc, encodeCollabdoc, readCollabdocHeader } from '../../core/collabdoc-file'
import { openDocument, readMeta } from '../../core/document'
import { listHistory } from '../../core/history'
import { DocumentRegistry } from '../../core/registry'
import { addParagraph, human } from '../../core/test-helpers'
import { allBlocks, blockIdOf, blockPlainText, listAssets, nodeName } from '../../core/tree'
import { SCHEMA_VERSION } from '../../shared/constants'
import { DocumentStore } from './store'

describe('DocumentStore', () => {
  const stores: DocumentStore[] = []
  const dirs: string[] = []

  afterEach(async () => {
    vi.useRealTimers()
    for (const store of stores.splice(0)) store.dispose()
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
  })

  async function makeStore(idleMs = 2_000): Promise<{ store: DocumentStore; dir: string }> {
    const { mkdtemp } = await import('fs/promises')
    const dir = await mkdtemp(join(tmpdir(), 'collabdoc-store-'))
    dirs.push(dir)
    const registry = new DocumentRegistry({
      closeDelayMs: Number.POSITIVE_INFINITY,
      warn: () => {}
    })
    const store = new DocumentStore({
      registry,
      userData: join(dir, 'user'),
      documentsDir: join(dir, 'docs'),
      idleMs,
      maxMs: 30_000
    })
    stores.push(store)
    await store.init()
    return { store, dir }
  }

  it('writes a collabdoc whose snapshot matches the live hub (AC-04.1, AC-04.2)', async () => {
    const { store, dir } = await makeStore()
    const created = store.create({ title: 'Plan' })
    const entry = store.registry.get(created.docId)!
    const ana = human(entry.hub)
    addParagraph(ana, 'Persisted history')
    expect(store.stateOf(created.docId)?.dirty).toBe(true)
    const file = join(dir, 'docs', 'Plan.collabdoc')
    await mkdir(join(dir, 'docs'), { recursive: true })
    await store.saveTo(created.docId, file)
    expect(store.stateOf(created.docId)?.dirty).toBe(false)

    const bytes = await readFile(file)
    expect(new TextDecoder().decode(bytes.subarray(0, 8))).toBe('CLBDOC01')
    const header = readCollabdocHeader(bytes)
    expect(header.docId).toBe(created.docId)
    expect(header.title).toBe('Plan')

    const decoded = decodeCollabdoc(bytes)
    const again = openDocument(decoded.snapshot)
    expect(readMeta(again).docId).toBe(created.docId)
    expect(allBlocks(again).map(({ node }) => blockPlainText(node))).toEqual(
      allBlocks(entry.hub.doc).map(({ node }) => blockPlainText(node))
    )
    expect(allBlocks(again).map(({ node }) => blockIdOf(node))).toEqual(
      allBlocks(entry.hub.doc).map(({ node }) => blockIdOf(node))
    )
    expect(listHistory(again)).toHaveLength(listHistory(entry.hub.doc).length)
    expect(listHistory(again).map((item) => item.timestamp)).toEqual(
      listHistory(entry.hub.doc).map((item) => item.timestamp)
    )
  })

  it('autosaves a draft within 2 s so a kill 3 s later loses nothing (AC-04.3, AC-04.6)', async () => {
    const { store, dir } = await makeStore(20)
    const created = store.create({ title: 'Untitled' })
    const entry = store.registry.get(created.docId)!
    addParagraph(human(entry.hub), 'Recover me')
    await new Promise((resolve) => setTimeout(resolve, 80))
    const draft = join(dir, 'user', 'drafts', `${created.docId}.collabdoc`)
    const bytes = await readFile(draft)
    const decoded = decodeCollabdoc(bytes)
    expect(blockPlainText(allBlocks(openDocument(decoded.snapshot))[1].node)).toContain(
      'Recover me'
    )

    store.dispose()
    const registry = new DocumentRegistry({
      closeDelayMs: Number.POSITIVE_INFINITY,
      warn: () => {}
    })
    const again = new DocumentStore({
      registry,
      userData: join(dir, 'user'),
      documentsDir: join(dir, 'docs'),
      idleMs: 2000
    })
    stores.push(again)
    const listing = await again.listing()
    expect(listing.recents.some((item) => item.docId === created.docId && item.path === null)).toBe(
      true
    )
    const recovered = await again.recover(created.docId)
    expect(recovered.title).toBe('Untitled')
    const live = again.registry.get(recovered.docId)!
    expect(
      allBlocks(live.hub.doc).some(({ node }) => blockPlainText(node).includes('Recover me'))
    ).toBe(true)
  })

  it('refuses a newer schema without writing the file (AC-04.10)', async () => {
    const { store, dir } = await makeStore()
    const file = join(dir, 'future.collabdoc')
    const bytes = encodeCollabdoc({
      docId: 'future',
      title: 'Future',
      schemaVersion: SCHEMA_VERSION + 3,
      snapshot: new TextEncoder().encode('nope')
    })
    await writeFile(file, bytes)
    const before = await stat(file)
    await expect(store.openCollabdoc(file)).rejects.toThrow(/schema version/)
    const after = await stat(file)
    expect(after.mtimeMs).toBe(before.mtimeMs)
    expect(after.size).toBe(before.size)
  })

  it('garbage-collects unreferenced assets and warns on a truncated section (AC-04.13)', async () => {
    const { store, dir } = await makeStore()
    const created = store.create({ title: 'Figs' })
    const hashA = 'a'.repeat(64)
    const hashB = 'b'.repeat(64)
    store.putAsset(created.docId, hashA, 'image/png', new Uint8Array([1, 2, 3]))
    store.putAsset(created.docId, hashB, 'image/png', new Uint8Array([4, 5]))
    const entry = store.registry.get(created.docId)!
    const ana = human(entry.hub)
    ana.call('insert_blocks', {
      at: { relation: 'inside_end' },
      blocks: [
        { type: 'imageFigure', attrs: { src: `asset:${hashA}` } },
        { type: 'imageFigure', attrs: { src: `asset:${hashA}` } },
        { type: 'imageFigure', attrs: { src: `asset:${hashB}` } }
      ]
    })
    const file = join(dir, 'figs.collabdoc')
    await store.saveTo(created.docId, file)
    const first = decodeCollabdoc(await readFile(file))
    expect(first.header.assets).toHaveLength(2)

    const imageIds = allBlocks(entry.hub.doc)
      .filter(({ node }) => nodeName(node) === 'imageFigure')
      .map(({ node }) => blockIdOf(node)!)
    ana.call('delete_blocks', { blockIds: [imageIds[2]] })
    await store.saveTo(created.docId, file)
    const second = decodeCollabdoc(await readFile(file))
    expect(second.header.assets).toHaveLength(1)
    expect(second.header.assets[0].hash).toBe(hashA)
    expect(listAssets(openDocument(second.snapshot))).toEqual([hashA])

    const truncated = (await readFile(file)).subarray(0, (await readFile(file)).byteLength - 1)
    const broken = join(dir, 'broken.collabdoc')
    await writeFile(broken, truncated)
    store.dispose()
    const { store: other } = await makeStore()
    other.dispose()
    stores.pop()
    const registry = new DocumentRegistry({
      closeDelayMs: Number.POSITIVE_INFINITY,
      warn: () => {}
    })
    const opener = new DocumentStore({
      registry,
      userData: join(dir, 'user2'),
      documentsDir: join(dir, 'docs'),
      idleMs: 2000
    })
    stores.push(opener)
    const opened = await opener.openCollabdoc(broken)
    expect(opened.warnings).toContain('truncated-assets')
    expect(opener.getAssets(opened.docId).length).toBeLessThan(2)
  })

  it('saving a markdown import writes a collabdoc twin and leaves the .md bytes (AC-04.7)', async () => {
    const { store, dir } = await makeStore()
    const md = join(dir, 'notes.md')
    const original = '# Notes\n\nHello from markdown\n'
    await writeFile(md, original)
    const created = store.create({ title: 'Notes' })
    store.markImportedFrom(created.docId, md)
    expect(store.suggestedSavePath(created.docId, 'Notes')).toBe(join(dir, 'notes.collabdoc'))
    addParagraph(human(store.registry.get(created.docId)!.hub), 'Hello from markdown')
    await store.saveTo(created.docId, join(dir, 'notes.collabdoc'))
    expect(await readFile(md, 'utf8')).toBe(original)
    expect(
      new TextDecoder().decode((await readFile(join(dir, 'notes.collabdoc'))).subarray(0, 8))
    ).toBe('CLBDOC01')
  })

  it('offers recovery when a draft is newer than recents (AC-04.6)', async () => {
    const { store, dir } = await makeStore()
    const created = store.create({ title: 'Untitled' })
    addParagraph(human(store.registry.get(created.docId)!.hub), 'typed')
    await store.flush(created.docId)
    const listing = await store.listing()
    const recent = listing.recents.find((item) => item.docId === created.docId)
    expect(recent?.path).toBeNull()
    const draft = join(dir, 'user', 'drafts', `${created.docId}.collabdoc`)
    const older = new Date(Date.now() - 60_000)
    if (recent) {
      recent.updatedAt = older.toISOString()
      await store.rememberRecent({ ...recent, updatedAt: older.toISOString() })
    }
    await utimes(draft, older, new Date())
    const offers = await store.listing()
    expect(offers.recoveries.some((item) => item.docId === created.docId)).toBe(true)
  })
})
