import { useEffect, useRef, useState } from 'react'
import { modLabel } from '../lib/host'
import { useSessionActions } from '../state/useSessionActions'
import { Button, Icon } from './ui'

export function FileMenu(): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const actions = useSessionActions()
  const mod = modLabel()

  useEffect(() => {
    if (!open) return
    const onPointer = (event: PointerEvent): void => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    window.addEventListener('pointerdown', onPointer)
    return () => window.removeEventListener('pointerdown', onPointer)
  }, [open])

  const close = (): void => setOpen(false)

  return (
    <div className="toolbar-menu topbar-menu" ref={root}>
      <Button
        size="sm"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="File menu"
        data-testid="file-menu"
        className={open ? 'is-on' : ''}
        onClick={() => setOpen((value) => !value)}
      >
        File
        <Icon name="chevron" />
      </Button>
      {open ? (
        <div
          className="toolbar-popover topbar-menu__popover"
          role="menu"
          data-testid="file-menu-list"
        >
          <button
            type="button"
            className="menu-item"
            role="menuitem"
            data-testid="file-menu-save"
            onClick={() => {
              close()
              void actions.saveDocument()
            }}
          >
            Save
            <kbd>{mod}+S</kbd>
          </button>
          <button
            type="button"
            className="menu-item"
            role="menuitem"
            data-testid="file-menu-save-as"
            onClick={() => {
              close()
              void actions.saveDocumentAs()
            }}
          >
            Save As…
            <kbd>{mod}+Shift+S</kbd>
          </button>
          <span className="menu-sep" role="separator" />
          <button
            type="button"
            className="menu-item"
            role="menuitem"
            data-testid="file-menu-export-markdown"
            onClick={() => {
              close()
              actions.exportMarkdown()
            }}
          >
            Export Markdown…
          </button>
          <button
            type="button"
            className="menu-item"
            role="menuitem"
            data-testid="file-menu-export-markdown-comments"
            onClick={() => {
              close()
              actions.exportMarkdown({ includeComments: true })
            }}
          >
            Export Markdown with Comments…
          </button>
          <button
            type="button"
            className="menu-item"
            role="menuitem"
            data-testid="file-menu-export-docx"
            onClick={() => {
              close()
              actions.openDocxExport()
            }}
          >
            Export Word (.docx)…
          </button>
        </div>
      ) : null}
    </div>
  )
}
