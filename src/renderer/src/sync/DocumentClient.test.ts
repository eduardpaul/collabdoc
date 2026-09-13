import { Editor } from '@tiptap/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getThread } from '@core/comments'
import { listHistory } from '@core/history'
import { DocumentRegistry } from '@core/registry'
import { human, addParagraph, textOf, writer } from '@core/test-helpers'
import { blockPlainText, findBlock, getChildren, getRoot, allBlocks } from '@core/tree'
import { LoroList, LoroMap, LoroText } from 'loro-crdt'
import type { CommentThread } from '@shared/types'
import { editorExtensions } from '../editor/extensions'
import { LoroCollab, commitMessageKey } from '../editor/loro-collab'
import {
  closeClient,
  createAndOpen,
  currentDocId,
  openClient,
  resetClientsForTests
} from './clients'
import { CommentsApi } from './comments-api'
import { DocumentClient } from './DocumentClient'
import { unreadThreads } from './useComments'
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

  it('shows a remote caret with name and colour within 100 ms (AC-07.2)', async () => {
    const host = await createAndOpen({ title: 'Cursors' })
    const editor = await bindEditor(host)
    const guest = new DocumentClient(host.docId, {
      actorId: 'guest-ada',
      name: 'Ada',
      color: '#2563eb',
      role: 'human',
      handle: 'ada'
    })
    const channel = new MessageChannel()
    const detach = registry.attach(host.docId, 'guest-ada', {
      send: (frame) => channel.port1.postMessage(frame),
      onMessage: (listener) => {
        channel.port1.onmessage = (event) => listener(event.data)
      },
      onClose: (listener) => channel.port1.addEventListener('close', listener),
      close: () => channel.port1.close()
    })
    channel.port1.start()
    guest.bind(channel.port2)
    await guest.whenLive()
    const { cursorAt, allBlocks: blocks } = await import('@core/tree')
    const cur = cursorAt(blocks(host.doc)[0].node, 0)
    expect(cur).toBeTruthy()
    const started = performance.now()
    guest.presence.setLocal({
      user: { name: 'Ada', color: '#2563eb' },
      anchor: cur!,
      focus: cur!
    })
    await expect
      .poll(() => editor.view.dom.querySelector('.ProseMirror-loro-cursor')?.textContent ?? '', {
        timeout: 200
      })
      .toContain('Ada')
    expect(performance.now() - started).toBeLessThan(100)
    const caret = editor.view.dom.querySelector('.ProseMirror-loro-cursor') as HTMLElement
    expect(caret.style.borderColor.replace(/\s/g, '')).toMatch(/#2563eb|rgb\(37,99,235\)/)
    detach()
    guest.detach()
  })

  it('restore is one messaged commit that does not merge with the keystrokes before it (AC-05.7)', async () => {
    const client = await createAndOpen({ title: 'Restore' })
    const editor = await bindEditor(client)
    editor.commands.insertContent('first')
    await tick(20)
    const afterFirst = [...client.doc.frontiers()]
    editor.commands.insertContent(' second')
    // Past the UndoManager's own 500 ms merge window, as a real restore would be.
    await tick(600)
    const json = client.previewJson(afterFirst)
    expect(json).toBeTruthy()
    editor.chain().setMeta(commitMessageKey, 'Restore version').setContent(json!).run()
    await tick(20)
    expect(editorText(editor).trim()).toBe('first')
    const mine = myHistory(client)
    const restore = mine[mine.length - 1]
    expect(restore.message).toBe('Restore version')
    expect(mine[mine.length - 2].details.join(' ')).toContain('second')
    // One undo steps back over the restore alone.
    expect(editor.commands.undo()).toBe(true)
    await tick(20)
    expect(editorText(editor).trim()).toBe('first second')
  })

  it('typing is one commit per block visit: a caret move to another block cuts it (AC-05.1)', async () => {
    const client = await createAndOpen({ title: 'Cut' })
    const editor = await bindEditor(client)
    editor.commands.setContent({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'one' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'two' }] }
      ]
    })
    await tick(20)
    editor.commands.setTextSelection(4)
    editor.commands.insertContent('A')
    editor.commands.insertContent('B')
    // A plain caret move (no document change), then typing elsewhere.
    editor.commands.setTextSelection(editor.state.doc.content.size - 1)
    editor.commands.insertContent('C')
    await tick(20)
    const mine = myHistory(client)
    const ab = mine.find((e) => e.details.join(' ').includes('“A”'))
    const c = mine.find((e) => e.details.join(' ').includes('“C”'))
    expect(ab?.details.join(' ')).toContain('“B”')
    expect(c).toBeDefined()
    expect(c?.id).not.toBe(ab?.id)
  })

  it('a pause of 1 s starts a new commit in the same block (AC-05.1)', async () => {
    const client = await createAndOpen({ title: 'Idle' })
    const editor = await bindEditor(client)
    editor.commands.insertContent('A')
    await tick(1_100)
    editor.commands.insertContent('B')
    await tick(20)
    const mine = myHistory(client)
    const a = mine.find((e) => e.details.join(' ').includes('“A”'))
    const b = mine.find((e) => e.details.join(' ').includes('“B”'))
    expect(a).toBeDefined()
    expect(b).toBeDefined()
    expect(a?.id).not.toBe(b?.id)
  })
})

describe('per-actor undo in the editor (06)', () => {
  it('undoes bursts in order and redoes them back (AC-06.1)', async () => {
    const client = await createAndOpen({ title: 'Bursts' })
    const editor = await bindEditor(client)
    editor.commands.insertContent('hello')
    editor.commands.insertContent(' world')
    await tick(1_100)
    editor.commands.insertContent(' again')
    await tick(20)
    expect(editorText(editor)).toBe('hello world again')
    expect(editor.commands.undo()).toBe(true)
    await tick(10)
    expect(editorText(editor)).toBe('hello world')
    expect(editor.commands.undo()).toBe(true)
    await tick(10)
    expect(editorText(editor)).toBe('')
    expect(editor.commands.redo()).toBe(true)
    await tick(10)
    expect(editorText(editor)).toBe('hello world')
    expect(editor.commands.redo()).toBe(true)
    await tick(10)
    expect(editorText(editor)).toBe('hello world again')
  })

  it('a block switch starts a new undo step even inside the idle window (AC-06.1)', async () => {
    const client = await createAndOpen({ title: 'Switch' })
    const editor = await bindEditor(client)
    editor.commands.setContent({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'one' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'two' }] }
      ]
    })
    await tick(1_100)
    editor.commands.setTextSelection(4)
    editor.commands.insertContent('A')
    editor.commands.setTextSelection(editor.state.doc.content.size - 1)
    editor.commands.insertContent('B')
    await tick(20)
    expect(editorText(editor)).toBe('oneA\ntwoB')
    expect(editor.commands.undo()).toBe(true)
    await tick(10)
    expect(editorText(editor)).toBe('oneA\ntwo')
    expect(editor.commands.undo()).toBe(true)
    await tick(10)
    expect(editorText(editor)).toBe('one\ntwo')
  })

  it("undo reverts only this person's block while a peer edits another; history records it (AC-06.2)", async () => {
    const client = await createAndOpen({ title: 'Two blocks' })
    const editor = await bindEditor(client)
    editor.commands.setContent({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'A' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'B' }] }
      ]
    })
    await tick(1_100)
    editor.commands.setTextSelection(2)
    editor.commands.insertContent(' mine')
    const hub = registry.get(client.docId)!.hub
    const agent = writer(hub, 'nova')
    agent.call('insert_text', { blockId: idOf(hub.doc, 1), text: ' agent' })
    await tick(20)
    expect(editorText(editor)).toBe('A mine\nB agent')
    const before = myHistory(client).length
    expect(editor.commands.undo()).toBe(true)
    await tick(20)
    expect(editorText(editor)).toBe('A\nB agent')
    expect(hubText(client.docId)).toBe('A\nB agent')
    const mine = myHistory(client)
    expect(mine).toHaveLength(before + 1)
    expect(mine[mine.length - 1]).toMatchObject({
      message: 'undo',
      author: { actorId: client.profile.actorId }
    })
  })

  it('can().undo / can().redo follow every edit, undo and remote import (AC-06.4)', async () => {
    const client = await createAndOpen({ title: 'Buttons' })
    const editor = await bindEditor(client)
    expect(editor.can().undo()).toBe(false)
    expect(editor.can().redo()).toBe(false)
    editor.commands.insertContent('x')
    await tick(5)
    expect(editor.can().undo()).toBe(true)
    editor.commands.undo()
    await tick(5)
    expect(editor.can().undo()).toBe(false)
    expect(editor.can().redo()).toBe(true)
    const hub = registry.get(client.docId)!.hub
    human(hub, 'guest').call('insert_text', { blockId: idOf(hub.doc, 0), text: 'theirs' })
    await tick(5)
    // A remote edit is never an undo candidate here, and does not drop our redo.
    expect(editor.can().undo()).toBe(false)
    expect(editor.can().redo()).toBe(true)
  })

  it('after undo the caret sits at the end of the reverted range (AC-06.5)', async () => {
    const client = await createAndOpen({ title: 'Caret' })
    const editor = await bindEditor(client)
    editor.commands.insertContent('keep ')
    await tick(1_100)
    editor.commands.insertContent('drop')
    await tick(20)
    expect(editor.state.selection.from).toBe(10)
    editor.commands.undo()
    await tick(20)
    expect(editorText(editor)).toBe('keep ')
    expect(editor.state.selection.from).toBe(6)
  })
})

describe('comments from the renderer (09)', () => {
  it('a comment on the selection is one attributed, undoable commit that peers see (AC-09.1, AC-09.2)', async () => {
    const client = await createAndOpen({ title: 'Comments' })
    const editor = await bindEditor(client)
    editor.commands.insertContent('Some words here')
    await tick(1_100)
    const api = new CommentsApi(client)
    const hub = registry.get(client.docId)!.hub
    const blockId = idOf(hub.doc, 0)
    const added = api.add({ blockId, start: 5, end: 10, body: 'why words? @nova' })
    expect(added.ok).toBe(true)
    if (!added.ok) return
    expect(added.thread).toMatchObject({
      quote: 'words',
      author: { id: client.profile.actorId, role: 'human' },
      status: 'open'
    })
    await tick(5)
    // The agent on the hub sees it and replies through its tool.
    const nova = writer(hub, 'nova')
    const listed = nova.call('list_comments', { mentioning: 'me' }) as { threads: CommentThread[] }
    expect(listed.threads.map((t) => t.id)).toEqual([added.thread.id])
    expect(
      nova.call('reply_comment', { threadId: added.thread.id, body: 'because' })
    ).toMatchObject({
      ok: true
    })
    await tick(5)
    expect(getThread(client.doc, added.thread.id)?.replies.map((r) => r.body)).toEqual(['because'])
    // History: the comment is its own entry with a message, by this user.
    const mine = myHistory(client)
    expect(mine.some((e) => e.message.startsWith('comment: why words?'))).toBe(true)
    // Undo reverts the comment alone, not the typing before it.
    expect(editor.commands.undo()).toBe(true)
    await tick(10)
    expect(editorText(editor)).toBe('Some words here')
    expect(getThread(client.doc, added.thread.id)).toBeNull()
  })

  it('resolve, reopen, edit and delete keep the permissions of the core model (AC-09.3, AC-09.4)', async () => {
    const client = await createAndOpen({ title: 'Perms' })
    await bindEditor(client)
    const hub = registry.get(client.docId)!.hub
    const nova = writer(hub, 'nova')
    const blockId = idOf(hub.doc, 0)
    const theirs = nova.call('add_comment', { blockId, body: 'agent note' }) as {
      thread: CommentThread
    }
    await tick(5)
    const api = new CommentsApi(client)
    expect(api.edit(theirs.thread.id, 'rewritten')).toMatchObject({ ok: false })
    expect(api.remove(theirs.thread.id)).toMatchObject({ ok: false })
    expect(api.reopen(theirs.thread.id)).toMatchObject({ ok: false })
    expect(api.resolve(theirs.thread.id)).toMatchObject({
      ok: true,
      thread: { status: 'resolved' }
    })
    expect(api.resolve(theirs.thread.id)).toMatchObject({ ok: false })
    expect(api.reopen(theirs.thread.id)).toMatchObject({ ok: true, thread: { status: 'open' } })
    const mine = api.add({ blockId, body: 'mine' })
    if (!mine.ok) throw new Error(mine.error)
    expect(api.edit(mine.thread.id, 'edited')).toMatchObject({
      ok: true,
      thread: { body: 'edited' }
    })
    expect(api.remove(mine.thread.id)).toMatchObject({
      ok: true,
      thread: { deleted: true, body: '' }
    })
    await tick(5)
    expect(getThread(hub.doc, mine.thread.id)).toMatchObject({ deleted: true, replies: [] })
  })

  it('unread marks threads with new replies by others until opened (AC-09.9)', () => {
    const ana = { id: 'ana', name: 'Ana', role: 'human' as const, color: '#000' }
    const rex = { id: 'rex', name: 'Rex', role: 'agent' as const, color: '#111' }
    const base = {
      blockId: 'b',
      quote: '',
      start: 0,
      end: 0,
      anchorStart: '',
      anchorEnd: '',
      body: 'q',
      createdAt: 1,
      status: 'open' as const
    }
    const threads: CommentThread[] = [
      { ...base, id: 't1', author: ana, replies: [{ id: 'r1', author: rex, body: 'a', at: 2 }] },
      { ...base, id: 't2', author: ana, replies: [{ id: 'r2', author: ana, body: 'b', at: 2 }] },
      { ...base, id: 't3', author: rex, replies: [] }
    ]
    expect([...unreadThreads(threads, {}, 'ana')]).toEqual(['t1'])
    expect([...unreadThreads(threads, { t1: 1 }, 'ana')]).toEqual([])
    expect([...unreadThreads(threads, { t1: 1 }, 'rex')]).toEqual(['t2'])
  })
})

function myHistory(client: DocumentClient): ReturnType<typeof listHistory> {
  return listHistory(client.doc).filter((e) => e.peer === client.doc.peerIdStr)
}

function idOf(doc: import('loro-crdt').LoroDoc, index: number): string {
  const block = allBlocks(doc)[index]
  const attrs = block.node.get('attributes') as LoroMap
  return String(attrs.get('blockId'))
}
