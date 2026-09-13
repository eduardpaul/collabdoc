import { Extension } from '@tiptap/core'
import type { Node as PmNode } from '@tiptap/pm/model'
import { NodeSelection, Plugin, TextSelection } from '@tiptap/pm/state'
import type { Editor } from '@tiptap/core'
import { FIGURE_TYPES } from '../constants'

const FIGURE_SET = new Set<string>(FIGURE_TYPES)

export function toggleFigureCaption(editor: Editor, pos: number, node: PmNode): void {
  const innerFrom = pos + 1
  const innerTo = pos + node.nodeSize - 1
  if (node.content.size > 0) {
    const tr = editor.state.tr.delete(innerFrom, innerTo)
    tr.setSelection(NodeSelection.create(tr.doc, pos))
    editor.view.dispatch(tr)
    return
  }
  const text = 'Caption'
  const tr = editor.state.tr.insertText(text, innerFrom)
  tr.setSelection(TextSelection.create(tr.doc, innerFrom, innerFrom + text.length))
  editor.view.dispatch(tr)
  editor.view.focus()
}

export const FigureCaptionKeys = Extension.create({
  name: 'figureCaptionKeys',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          handleTextInput(view, _from, _to, text) {
            const sel = view.state.selection
            if (!(sel instanceof NodeSelection) || !FIGURE_SET.has(sel.node.type.name) || !text) {
              return false
            }
            const insertAt =
              sel.node.content.size === 0 ? sel.from + 1 : sel.from + sel.node.nodeSize - 1
            const tr = view.state.tr.insertText(text, insertAt)
            tr.setSelection(TextSelection.create(tr.doc, insertAt + text.length))
            view.dispatch(tr)
            return true
          }
        }
      })
    ]
  }
})
