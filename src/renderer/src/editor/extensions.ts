import type { AnyExtension } from '@tiptap/core'
import { Placeholder, Selection } from '@tiptap/extensions'
import { Markdown } from '@tiptap/markdown'
import { ClipboardMarkdown } from './clipboard'
import { schemaExtensions } from './schema'
import { SearchHighlight } from './search-highlight'

export { ENABLE_TIPTAP_HISTORY, schemaExtensions } from './schema'

const PLACEHOLDER =
  'Start writing. Invite a Writer or Reviewer from the right. Everything stays on this machine until you share a tunnel.'

export function editorExtensions(): AnyExtension[] {
  return [
    ...schemaExtensions(),
    Markdown.configure({
      markedOptions: { gfm: true },
      indentation: { style: 'space', size: 2 }
    }),
    Placeholder.configure({ placeholder: PLACEHOLDER }),
    Selection,
    SearchHighlight,
    ClipboardMarkdown
  ]
}
