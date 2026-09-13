import { Editor } from '@tiptap/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DocumentRegistry } from '@core/registry'
import { human, addParagraph, textOf } from '@core/test-helpers'
import { blockPlainText, findBlock, getChildren, getRoot, allBlocks } from '@core/tree'
import { LoroList, LoroMap, LoroText } from 'loro-crdt'
import { editorExtensions } from '../editor/extensions'
import { LoroCollab } from '../editor/loro-collab'
import {
  closeClient,
  createAndOpen,
  currentDocId,
  openClient,
  resetClientsForTests
} from './clients'
import type { DocumentClient } from './DocumentClient'
import { inPageHost, setDocumentHostForTests } from './host'

let registry: DocumentRegistry
const editors: Editor[] = []

function tick(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** A Tiptap editor bound to a client, initialised (the sync plugin inits on a timeout). */
async function bindEditor(client: DocumentClient): Promise<Editor> {
  const element = document.createElement('div')
  document.body.appendChild(element)
  const editor = new Editor({
    element,
    extensions: [
      ...editorExtensions(),
      LoroCollab.configure({
        doc: client.doc,
        presence: client.presence,
        undoManager: client.undoManager,
        profile: client.profile
      })
    ]
  })
  editors.push(editor)
  await tick(5)
  return editor
}

function hubText(docId: string): string {
  const hub = registry.get(docId)!.hub
  return allBlocks(hub.doc)
    .map(({ node }) => blockPlainText(node))
    .join('\n')
}

function editorText(editor: Editor): string {
  const parts: string[] = []
  editor.state.doc.forEach((node) => parts.push(node.textContent))
  return parts.join('\n')
}

beforeEach(() => {
  registry = new DocumentRegistry({ closeDelayMs: 200, warn: () => {} })
  setDocumentHostForTests(inPageHost(registry))
})

afterEach(() => {
  while (editors.length) editors.pop()?.destroy()
  resetClientsForTests()
  registry.closeAll()
  setDocumentHostForTests(null)
  document.body.innerHTML = ''
})

describe('DocumentClient over a MessagePort', () => {
  it('creates one hub, receives the snapshot and goes live (AC-03.1)', async () => {
    const client = await createAndOpen({ title: 'Fresh' })
    expect(registry.list()).toEqual([client.docId])
    expect(client.status).toBe('live')
    expect(client.title).toBe('Fresh')
    expect(client.dirty).toBe(false)
    expect(registry.debug()[0].subscribers).toEqual([`page:${client.docId}`])
    expect(currentDocId()).toBe(client.docId)
    await tick(5)
    // The person is registered as an author of this document.
    expect(
      registry.get(client.docId)!.hub.doc.getMap('authors').get(client.doc.peerIdStr)
    ).toMatchObject({
      actorId: client.profile.actorId,
      role: 'human'
    })
  })

  it('typing in the editor reaches the hub as binary update frames (AC-03.2)', async () => {
    const client = await createAndOpen({ title: 'Typing' })
    const editor = await bindEditor(client)
    editor.commands.setTextSelection(1)
    editor.commands.insertContent('Hello from the editor')
    await tick(5)
    expect(hubText(client.docId)).toBe('Hello from the editor')
    expect(editorText(editor)).toBe('Hello from the editor')
    expect(client.dirty).toBe(true)
    const debug = registry.debug()[0]
    expect(debug.text).toBe('Hello from the editor')
    expect(debug.changes).toBeGreaterThan(0)
  })

  it('a remote edit in another block lands within 50 ms and leaves the caret alone (AC-03.3)', async () => {
    const client = await createAndOpen({ title: 'Remote' })
    const editor = await bindEditor(client)
    editor.commands.insertContent('Mine')
    await tick(5)

    const hub = registry.get(client.docId)!.hub
    const other = human(hub, 'guest')
    addParagraph(other, 'Theirs')
    await tick(5)

    // Caret sits after "Mine" in the first paragraph.
    editor.commands.setTextSelection(5)
    const before = editor.state.selection.from
    const started = performance.now()
    other.call('insert_text', {
      blockId: allBlocks(hub.doc)[1].node && idOf(hub.doc, 1),
      text: ' and more'
    })
    await tick(5)
    expect(performance.now() - started).toBeLessThan(50)
    expect(editorText(editor)).toBe('Mine\nTheirs and more')
    expect(editor.state.selection.from).toBe(before)
  })

  it('typing while a remote edit hits the same block loses nothing (AC-03.3)', async () => {
    const client = await createAndOpen({ title: 'Same block' })
    const editor = await bindEditor(client)
    editor.commands.insertContent('start')
    await tick(5)
    const hub = registry.get(client.docId)!.hub
    const other = human(hub, 'guest')
    const blockId = idOf(hub.doc, 0)

    for (const char of 'abcdef') {
      editor.commands.insertContentAt(editor.state.selection.from, char)
      other.call('insert_text', { blockId, text: 'X', at: { start: 0 } })
      // No await: the remote import rebuilds the view between local keystrokes.
    }
    await tick(10)
    const text = editorText(editor)
    expect(text.replace(/X/g, '')).toBe('startabcdef')
    expect(text.match(/X/g)).toHaveLength(6)
    expect(hubText(client.docId)).toBe(text)
    expect(textOf(other, blockId)).toBe(text)
  })

  it("Mod+Z reverts only this person's last change (AC-03.4)", async () => {
    const client = await createAndOpen({ title: 'Undo' })
    const editor = await bindEditor(client)
    expect(
      editor.extensionManager.extensions.some((e) => e.name === 'undoRedo' || e.name === 'history')
    ).toBe(false)
    editor.commands.insertContent('mine ')
    await tick(600)
    const hub = registry.get(client.docId)!.hub
    const other = human(hub, 'guest')
    other.call('insert_text', { blockId: idOf(hub.doc, 0), text: 'theirs' })
    await tick(5)
    expect(editorText(editor)).toBe('mine theirs')

    expect(editor.commands.undo()).toBe(true)
    await tick(5)
    expect(editorText(editor)).toBe('theirs')
    expect(hubText(client.docId)).toBe('theirs')
    expect(editor.commands.redo()).toBe(true)
    await tick(5)
    expect(editorText(editor)).toBe('mine theirs')
  })

  it('closing detaches the port and disposes the hub after the grace period (AC-03.5)', async () => {
    const client = await createAndOpen({ title: 'Close' })
    await closeClient(client.docId)
    expect(client.status).toBe('detached')
    expect(registry.has(client.docId)).toBe(false)
    expect(currentDocId()).toBeNull()

    // A port that simply closes (reload) keeps the hub for the grace period.
    const second = await createAndOpen({ title: 'Reload' })
    second.detach()
    await tick(20)
    expect(registry.has(second.docId)).toBe(true)
    await tick(250)
    expect(registry.has(second.docId)).toBe(false)
  })

  it('re-attaching after a reload gets a fresh snapshot with every edit (AC-03.7)', async () => {
    const client = await createAndOpen({ title: 'Persisting' })
    const editor = await bindEditor(client)
    editor.commands.insertContent('typed before reload')
    client.setTitle('Renamed before reload')
    await tick(5)

    // The page goes away: editor destroyed, client detached, port closed.
    editors.pop()?.destroy()
    client.detach()
    await tick(5)

    const again = await openClient(client.docId)
    expect(again).not.toBe(client)
    expect(again.status).toBe('live')
    expect(again.title).toBe('Renamed before reload')
    const editor2 = await bindEditor(again)
    expect(editorText(editor2)).toBe('typed before reload')
    expect(again.dirty).toBe(false)
  })

  it('title edits travel through the meta map to every subscriber', async () => {
    const client = await createAndOpen({ title: 'Old' })
    const titles: string[] = []
    client.subscribe((event) => {
      if (event.type === 'title') titles.push(event.title)
    })
    client.setTitle('New')
    await tick(5)
    const hub = registry.get(client.docId)!.hub
    expect(hub.doc.getMap('meta').get('title')).toBe('New')
    expect(client.dirty).toBe(true)

    const other = human(hub, 'guest')
    other.doc.getMap('meta').set('title', 'Newer')
    other.doc.commit({ origin: 'actor:guest' })
    await tick(5)
    expect(client.title).toBe('Newer')
    expect(titles).toEqual(['New', 'Newer'])
  })

  it('seeds a new document from parsed file content as one clean commit', async () => {
    const client = await createAndOpen({
      title: 'Seeded',
      seed: {
        type: 'doc',
        content: [
          { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Title' }] },
          { type: 'paragraph', content: [{ type: 'text', text: 'Body' }] }
        ]
      }
    })
    await tick(5)
    expect(hubText(client.docId)).toBe('Title\nBody')
    expect(client.dirty).toBe(false)
    const editor = await bindEditor(client)
    expect(editorText(editor)).toBe('Title\nBody')
    expect(client.toJSON().content?.map((n) => n.type)).toEqual(['heading', 'paragraph'])
  })

  it('keeps a block the schema rejected through the remote rebuild (until the next local edit)', async () => {
    const client = await createAndOpen({ title: 'Guard' })
    const editor = await bindEditor(client)
    editor.commands.insertContent('local')
    await tick(5)
    const hub = registry.get(client.docId)!.hub
    // A block type this build's schema does not know (a future extension);
    // loro-prosemirror logs the rejection, which is the point of the test.
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    const quietWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const children = getChildren(getRoot(hub.doc))
    const foreign = children.insertContainer(children.length, new LoroMap())
    foreign.set('nodeName', 'callout')
    foreign.getOrCreateContainer('attributes', new LoroMap()).set('blockId', 'b_foreign001')
    foreign
      .getOrCreateContainer('children', new LoroList())
      .insertContainer(0, new LoroText())
      .insert(0, 'future')
    hub.commitLocal('foreign block')
    await tick(10)

    // The rebuild's own write-back is filtered: the block survives in Loro.
    expect(editor.state.doc.childCount).toBe(1)
    expect(findBlock(hub.doc, 'b_foreign001')).not.toBeNull()
    expect(getChildren(getRoot(hub.doc))).toHaveLength(2)
    expect(client.dirty).toBe(true)

    // Known limit: the next local edit diffs the editor against Loro and drops
    // it. The schema has to be a superset of everything a document can hold.
    editor.commands.insertContentAt(editor.state.selection.from, '!')
    await tick(10)
    expect(findBlock(hub.doc, 'b_foreign001')).toBeNull()
    expect(quietWarn.mock.calls.some((call) => String(call[0]).includes('rendered 1 of 2'))).toBe(
      true
    )
    quiet.mockRestore()
    quietWarn.mockRestore()
  })

  it('a paragraph created with Enter gets its text container before anyone types (undo safety)', async () => {
    const client = await createAndOpen({ title: 'Shape' })
    const editor = await bindEditor(client)
    editor.commands.insertContent('first')
    editor.commands.splitBlock()
    await tick(5)
    const hub = registry.get(client.docId)!.hub
    const blocks = allBlocks(hub.doc)
    expect(blocks).toHaveLength(2)
    expect(getChildren(blocks[1].node).get(0)).toBeInstanceOf(LoroText)
    expect(client.undoManager.canUndo()).toBe(true)

    // A collaborator types into the new paragraph; undoing our Enter+typing
    // must not take their text with it.
    const other = human(hub, 'guest')
    const newId = idOf(hub.doc, 1)
    editor.commands.insertContentAt(editor.state.selection.from, 'ours')
    await tick(600)
    other.call('insert_text', { blockId: newId, text: ' theirs' })
    await tick(5)
    expect(hubText(client.docId)).toBe('first\nours theirs')
    expect(editor.commands.undo()).toBe(true)
    await tick(5)
    expect(hubText(client.docId)).toBe('first\n theirs')
  })
})

function idOf(doc: import('loro-crdt').LoroDoc, index: number): string {
  const block = allBlocks(doc)[index]
  const attrs = block.node.get('attributes') as LoroMap
  return String(attrs.get('blockId'))
}
