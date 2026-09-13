import { afterEach, describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import { ALLOWED_MARKS, ALLOWED_NODES } from './constants'
import { editorExtensions, schemaExtensions } from './extensions'
import { getSchema } from '@tiptap/core'

const editors: Editor[] = []

afterEach(() => {
  while (editors.length) {
    editors.pop()?.destroy()
  }
  document.body.innerHTML = ''
})

describe('editor schema', () => {
  it('only exposes the supported nodes and marks', () => {
    const schema = getSchema(schemaExtensions())
    const nodes = Object.keys(schema.nodes).filter(
      (name) => name !== 'doc' && name !== 'text' && name !== 'hardBreak'
    )
    const marks = Object.keys(schema.marks)
    for (const name of nodes) {
      expect(ALLOWED_NODES).toContain(name)
    }
    for (const name of marks) {
      expect(ALLOWED_MARKS).toContain(name)
    }
  })

  it('strips unknown HTML on paste instead of preserving it', () => {
    const element = document.createElement('div')
    document.body.appendChild(element)
    const editor = new Editor({ element, extensions: editorExtensions() })
    editors.push(editor)
    editor.commands.setContent(
      '<table><tr><td>cell</td></tr></table><h5>Heading five</h5><p>Keep me</p><form><input name="x" /></form>'
    )
    const json = JSON.stringify(editor.getJSON())
    expect(json).not.toContain('table')
    expect(json).not.toContain('iframe')
    expect(json).toContain('Keep me')
    expect(json).toContain('Heading five')
  })
})
