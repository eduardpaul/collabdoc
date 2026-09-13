import type { Editor, JSONContent } from '@tiptap/core'
import { NodeSelection } from '@tiptap/pm/state'
import { docToMarkdown } from './markdown'

export function currentBlockJson(editor: Editor): JSONContent | null {
  const sel = editor.state.selection
  if (sel instanceof NodeSelection && sel.node.isBlock && sel.node.type.name !== 'doc') {
    return sel.node.toJSON() as JSONContent
  }
  const $from = sel.$from
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const node = $from.node(depth)
    if (
      node.isBlock &&
      node.type.name !== 'doc' &&
      node.type.name !== 'bulletList' &&
      node.type.name !== 'orderedList' &&
      node.type.name !== 'taskList'
    ) {
      return node.toJSON() as JSONContent
    }
  }
  return null
}

export function currentBlockMarkdown(editor: Editor): string {
  const block = currentBlockJson(editor)
  if (!block) {
    return ''
  }
  return docToMarkdown({ type: 'doc', content: [block] })
}
