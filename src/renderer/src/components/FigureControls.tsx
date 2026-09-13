import type { Editor } from '@tiptap/core'
import { NodeSelection } from '@tiptap/pm/state'
import { useEditorState } from '@tiptap/react'
import { FIGURE_ALIGNS, FIGURE_TYPES, FIGURE_WIDTHS, type FigureAlign } from '../editor/constants'
import { toggleFigureCaption } from '../editor/figures/caption'
import { Button } from './ui'

export function FigureControls({
  editor,
  onEditSource,
  onReplaceImage,
  onExport
}: {
  editor: Editor
  onEditSource: () => void
  onReplaceImage: () => void
  onExport: (kind: 'svg' | 'png' | 'image') => void
}): React.JSX.Element | null {
  const selected = useEditorState({
    editor,
    selector: ({ editor: current }) => {
      const sel = current.state.selection
      if (!(sel instanceof NodeSelection)) {
        return null
      }
      const name = sel.node.type.name
      if (!(FIGURE_TYPES as readonly string[]).includes(name)) {
        return null
      }
      return {
        name,
        pos: sel.from,
        node: sel.node,
        width: sel.node.attrs.width as number | null,
        align: sel.node.attrs.align as FigureAlign,
        source: String(sel.node.attrs.source ?? ''),
        hasCaption: sel.node.content.size > 0
      }
    }
  })

  if (!selected) {
    return null
  }

  const isImage = selected.name === 'imageFigure'
  const isSyntax = !isImage

  return (
    <div className="figure-controls" role="toolbar" aria-label="Figure">
      {isSyntax ? (
        <Button size="sm" onClick={onEditSource}>
          Edit source
        </Button>
      ) : (
        <Button size="sm" onClick={onReplaceImage}>
          Replace
        </Button>
      )}
      <Button size="sm" onClick={() => toggleFigureCaption(editor, selected.pos, selected.node)}>
        {selected.hasCaption ? 'Caption −' : 'Caption +'}
      </Button>
      {FIGURE_WIDTHS.map((width) => (
        <Button
          key={width}
          size="sm"
          aria-pressed={selected.width === width}
          className={selected.width === width ? 'is-on' : ''}
          onClick={() => editor.commands.updateAttributes(selected.name, { width })}
        >
          {width}%
        </Button>
      ))}
      {FIGURE_ALIGNS.map((align) => (
        <Button
          key={align}
          size="sm"
          aria-label={`Align ${align}`}
          aria-pressed={selected.align === align}
          className={selected.align === align ? 'is-on' : ''}
          onClick={() => editor.commands.updateAttributes(selected.name, { align })}
        >
          {align}
        </Button>
      ))}
      {isSyntax ? (
        <Button size="sm" onClick={() => void navigator.clipboard.writeText(selected.source)}>
          Copy source
        </Button>
      ) : null}
      {isSyntax ? (
        <>
          <Button size="sm" onClick={() => onExport('svg')}>
            Export SVG
          </Button>
          <Button size="sm" onClick={() => onExport('png')}>
            Export PNG
          </Button>
        </>
      ) : (
        <Button size="sm" onClick={() => onExport('image')}>
          Save image
        </Button>
      )}
      <Button
        size="sm"
        variant="danger"
        onClick={() => editor.chain().focus().deleteSelection().run()}
      >
        Delete
      </Button>
    </div>
  )
}
