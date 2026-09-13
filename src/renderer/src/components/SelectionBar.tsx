import type { Editor } from '@tiptap/core'
import { useEditorState } from '@tiptap/react'
import { Button } from './ui'

export function SelectionBar({
  editor,
  onAskAgent,
  onComment
}: {
  editor: Editor
  onAskAgent?: () => void
  onComment?: () => void
}): React.JSX.Element | null {
  const selection = useEditorState({
    editor,
    selector: ({ editor: current }) => {
      const sel = current.state.selection
      if (sel.empty) {
        return null
      }
      const quote = current.state.doc.textBetween(sel.from, sel.to, ' ').trim()
      if (quote.length < 1) {
        return null
      }
      try {
        const end = current.view.coordsAtPos(Math.max(sel.from, sel.to - 1))
        const top = Math.max(8, end.top - 44)
        const left = Math.min(end.left, window.innerWidth - 360)
        return {
          quote,
          top,
          left,
          bold: current.isActive('bold'),
          italic: current.isActive('italic'),
          link: current.isActive('link')
        }
      } catch {
        return null
      }
    }
  })

  if (!selection) {
    return null
  }

  return (
    <div
      className="selection-bar"
      style={{ top: selection.top, left: selection.left }}
      onMouseDown={(event) => event.preventDefault()}
    >
      <Button
        size="sm"
        variant="ghost"
        aria-label="Bold"
        aria-pressed={selection.bold}
        className={selection.bold ? 'is-on' : ''}
        onClick={() => editor.chain().focus().toggleBold().run()}
      >
        B
      </Button>
      <Button
        size="sm"
        variant="ghost"
        aria-label="Italic"
        aria-pressed={selection.italic}
        className={selection.italic ? 'is-on' : ''}
        onClick={() => editor.chain().focus().toggleItalic().run()}
      >
        I
      </Button>
      <Button
        size="sm"
        variant="ghost"
        aria-label="Link"
        aria-pressed={selection.link}
        className={selection.link ? 'is-on' : ''}
        onClick={() => {
          const href = window.prompt('Link URL', 'https://')
          if (href === null) {
            return
          }
          const url = href.trim()
          if (!url) {
            editor.chain().focus().unsetLink().run()
            return
          }
          editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run()
        }}
      >
        Link
      </Button>
      <Button size="sm" variant="ghost" aria-label="Comment" disabled onClick={onComment}>
        Comment
      </Button>
      <Button size="sm" variant="ghost" aria-label="Ask agent" disabled onClick={onAskAgent}>
        Ask agent
      </Button>
    </div>
  )
}
