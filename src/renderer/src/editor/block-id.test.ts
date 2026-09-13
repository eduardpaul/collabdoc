import { afterEach, describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import { BLOCK_ID_ATTR, BLOCK_ID_TYPES } from './constants'
import { editorExtensions } from './extensions'

const editors: Editor[] = []

function createEditor(content?: object): Editor {
  const element = document.createElement('div')
  document.body.appendChild(element)
  const editor = new Editor({
    element,
    extensions: editorExtensions(),
    content
  })
  editors.push(editor)
  return editor
}

function blockIds(editor: Editor): string[] {
  const ids: string[] = []
  editor.state.doc.descendants((node) => {
    if (!(BLOCK_ID_TYPES as readonly string[]).includes(node.type.name)) {
      return
    }
    const id = node.attrs[BLOCK_ID_ATTR]
    if (typeof id === 'string' && id) {
      ids.push(id)
    }
  })
  return ids
}

function waitForCreate(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0)
  })
}

afterEach(() => {
  while (editors.length) {
    const editor = editors.pop()
    editor?.destroy()
  }
  document.body.innerHTML = ''
})

describe('block ids', () => {
  it('assigns a unique blockId to every block node', async () => {
    const editor = createEditor({
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Title' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Hello' }] },
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'One' }] }]
            }
          ]
        }
      ]
    })
    await waitForCreate()
    const ids = blockIds(editor)
    expect(ids.length).toBeGreaterThan(2)
    expect(new Set(ids).size).toBe(ids.length)
    ids.forEach((id) => expect(id).toMatch(/^b_[a-z0-9]+$/i))
  })

  it('keeps the original id and issues a new one when duplicating a block', async () => {
    const original = 'b_original01'
    const editor = createEditor({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          attrs: { [BLOCK_ID_ATTR]: original },
          content: [{ type: 'text', text: 'Hello' }]
        }
      ]
    })
    await waitForCreate()
    expect(blockIds(editor)).toEqual([original])
    editor.commands.insertContentAt(editor.state.doc.content.size, {
      type: 'paragraph',
      attrs: { [BLOCK_ID_ATTR]: original },
      content: [{ type: 'text', text: 'Hello' }]
    })
    const ids = blockIds(editor)
    expect(ids.length).toBeGreaterThanOrEqual(2)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids[0]).toBe(original)
  })

  it('assigns a new id to the second half of a split block', async () => {
    const original = 'b_splithere1'
    const editor = createEditor({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          attrs: { [BLOCK_ID_ATTR]: original },
          content: [{ type: 'text', text: 'HelloWorld' }]
        }
      ]
    })
    await waitForCreate()
    editor.commands.setTextSelection(6)
    editor.commands.splitBlock()
    const ids = blockIds(editor)
    expect(ids).toHaveLength(2)
    expect(new Set(ids).size).toBe(2)
    expect(ids[0]).toBe(original)
  })
})
