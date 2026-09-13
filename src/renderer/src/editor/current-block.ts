import type { Editor, JSONContent } from '@tiptap/core'
import type { EditorState } from '@tiptap/pm/state'
import { NodeSelection } from '@tiptap/pm/state'
import { BLOCK_ID_ATTR } from '@shared/constants'
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

export function currentBlockId(state: EditorState): string | null {
  const sel = state.selection
  if (sel instanceof NodeSelection) {
    const id = sel.node.attrs?.[BLOCK_ID_ATTR]
    if (typeof id === 'string' && id) return id
  }
  const $from = sel.$from
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const id = $from.node(depth).attrs?.[BLOCK_ID_ATTR]
    if (typeof id === 'string' && id) return id
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
