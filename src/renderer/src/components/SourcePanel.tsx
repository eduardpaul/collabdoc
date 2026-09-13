import { useEffect, useState } from 'react'
import type { Editor } from '@tiptap/core'
import { Button, TextArea } from './ui'
import { DEFAULT_INFOGRAPHIC, DEFAULT_MERMAID } from '../editor/figures/defaults'

export type SourceKind = 'mermaidFigure' | 'infographicFigure'

export function SourcePanel({
  editor,
  kind,
  source,
  onClose
}: {
  editor: Editor
  kind: SourceKind
  source: string
  onClose: () => void
}): React.JSX.Element {
  const fallback = kind === 'mermaidFigure' ? DEFAULT_MERMAID : DEFAULT_INFOGRAPHIC
  const [draft, setDraft] = useState(source)
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState('')

  useEffect(() => {
    const abort = new AbortController()
    const handle = window.setTimeout(() => {
      void (async () => {
        const el = document.createElement('div')
        try {
          if (kind === 'mermaidFigure') {
            const { renderMermaid } = await import('../editor/figures/mermaid-runtime')
            await renderMermaid(draft.trim() || fallback, el, abort.signal)
          } else {
            const { renderInfographic } = await import('../editor/figures/infographic-runtime')
            await renderInfographic(draft.trim() || fallback, el, abort.signal)
          }
          if (abort.signal.aborted) {
            return
          }
          setPreview(el.innerHTML)
          setError(null)
        } catch (err) {
          if (abort.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
            return
          }
          setError(err instanceof Error ? err.message : 'Invalid source')
        }
      })()
    }, 300)
    return () => {
      window.clearTimeout(handle)
      abort.abort()
    }
  }, [draft, fallback, kind])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopImmediatePropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const apply = (): void => {
    const next = draft.trim() || fallback
    if (kind === 'mermaidFigure') {
      editor.chain().focus().updateMermaidSource(next).run()
    } else {
      editor.chain().focus().updateInfographicSource(next).run()
    }
    onClose()
  }

  return (
    <div className="source-panel" role="dialog" aria-label="Edit figure source">
      <div className="source-panel__pane">
        <label htmlFor="figure-source">Source</label>
        <TextArea
          id="figure-source"
          value={draft}
          rows={14}
          spellCheck={false}
          onChange={(event) => setDraft(event.target.value)}
        />
        {error ? <p className="source-panel__error">{error}</p> : null}
      </div>
      <div className="source-panel__pane">
        <span>Preview</span>
        <div className="source-panel__preview" dangerouslySetInnerHTML={{ __html: preview }} />
      </div>
      <div className="source-panel__actions">
        <Button size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button size="sm" variant="primary" onClick={apply}>
          Apply
        </Button>
      </div>
    </div>
  )
}
