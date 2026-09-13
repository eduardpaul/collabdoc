import { useEffect, useRef, useState, type ReactNode } from 'react'
import { EditorContent, useEditorState } from '@tiptap/react'
import { NodeSelection } from '@tiptap/pm/state'
import { AssetError, bytesToBase64, putFile, setAssetDocument } from '../editor/assets'
import { currentBlockMarkdown } from '../editor/current-block'
import { configureFigureHost } from '../editor/figure-host'
import { exportSelectedFigure } from '../editor/figures/export'
import { useCollabEditor } from '../editor/useCollabEditor'
import type { DocumentClient } from '../sync/DocumentClient'
import { EditorToolbar } from './EditorToolbar'
import { FigureControls } from './FigureControls'
import { SearchReplace } from './SearchReplace'
import { SelectionBar } from './SelectionBar'
import { SourcePanel, type SourceKind } from './SourcePanel'
import { Button } from './ui'

export function DocumentEditor({
  client,
  title,
  onNotice,
  onMarkdown
}: {
  client: DocumentClient
  title: ReactNode
  onNotice: (message: string) => void
  onMarkdown: (markdown: string) => void
}): React.JSX.Element {
  const editor = useCollabEditor(client)
  const docId = client.docId
  const [searchOpen, setSearchOpen] = useState(false)
  const [source, setSource] = useState<{ kind: SourceKind; text: string } | null>(null)
  const [mermaidPrompt, setMermaidPrompt] = useState<string | null>(null)
  const editorRef = useRef(editor)
  const noticeRef = useRef(onNotice)

  const insertImage = async (file: File): Promise<void> => {
    try {
      const record = await putFile(file)
      editorRef.current
        .chain()
        .focus()
        .setImageFigure({ src: `asset:${record.sha256}`, alt: file.name })
        .run()
    } catch (error) {
      noticeRef.current(error instanceof AssetError ? error.message : 'Could not insert image.')
    }
  }

  const pickImage = (): void => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/*'
    input.addEventListener('change', () => {
      const file = input.files?.[0]
      if (file) {
        void insertImage(file)
      }
    })
    input.click()
  }

  useEffect(() => {
    editorRef.current = editor
    noticeRef.current = onNotice
  }, [editor, onNotice])

  useEffect(() => {
    setAssetDocument(docId)
  }, [docId])

  useEffect(() => {
    window.__collabEditor = editor
    return () => {
      if (window.__collabEditor === editor) {
        delete window.__collabEditor
      }
    }
  }, [editor])

  useEffect(() => {
    configureFigureHost({
      onPickImage: pickImage,
      onNotice: (message) => noticeRef.current(message),
      onMermaidPaste: (text) => setMermaidPrompt(text)
    })
    return () => configureFigureHost({})
    // Host callbacks read the latest editor/notice through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const markdown = useEditorState({
    editor,
    selector: ({ editor: current }) => currentBlockMarkdown(current)
  })

  useEffect(() => {
    onMarkdown(markdown)
  }, [markdown, onMarkdown])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const mod = event.metaKey || event.ctrlKey
      if (mod && event.key.toLowerCase() === 'f') {
        event.preventDefault()
        setSearchOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const openSource = (): void => {
    const sel = editor.state.selection
    if (!(sel instanceof NodeSelection)) {
      return
    }
    const name = sel.node.type.name
    if (name !== 'mermaidFigure' && name !== 'infographicFigure') {
      return
    }
    setSource({ kind: name, text: String(sel.node.attrs.source ?? '') })
  }

  const exportFigure = async (kind: 'svg' | 'png' | 'image'): Promise<void> => {
    try {
      const file = await exportSelectedFigure(editor, kind)
      if (!file) {
        onNotice('Nothing to export.')
        return
      }
      await saveExport(file)
    } catch (error) {
      onNotice(error instanceof Error ? error.message : 'Export failed.')
    }
  }

  return (
    <div className="document-editor" data-testid="document-editor">
      <EditorToolbar
        editor={editor}
        searchOpen={searchOpen}
        onToggleSearch={() => setSearchOpen((value) => !value)}
      />
      <SearchReplace editor={editor} open={searchOpen} onClose={() => setSearchOpen(false)} />
      <FigureControls
        editor={editor}
        onEditSource={openSource}
        onReplaceImage={() => void pickImage()}
        onExport={(kind) => void exportFigure(kind)}
      />
      {source ? (
        <SourcePanel
          editor={editor}
          kind={source.kind}
          source={source.text}
          onClose={() => setSource(null)}
        />
      ) : null}
      {mermaidPrompt ? (
        <div className="mermaid-prompt" role="dialog" aria-label="Insert as diagram">
          <p>Insert as Mermaid diagram?</p>
          <div className="mermaid-prompt__actions">
            <Button
              size="sm"
              variant="primary"
              onClick={() => {
                editor.chain().focus().setMermaidFigure({ source: mermaidPrompt }).run()
                setMermaidPrompt(null)
              }}
            >
              Insert as diagram
            </Button>
            <Button
              size="sm"
              onClick={() => {
                editor.chain().focus().insertContent(mermaidPrompt).run()
                setMermaidPrompt(null)
              }}
            >
              Insert as text
            </Button>
          </div>
        </div>
      ) : null}
      <article className="page">
        {title}
        <div className="page__body">
          <EditorContent editor={editor} />
          <SelectionBar editor={editor} />
        </div>
      </article>
    </div>
  )
}

async function saveExport(file: { name: string; mime: string; bytes: Uint8Array }): Promise<void> {
  const api = window.api
  if (api?.documents && 'saveBytes' in api.documents) {
    const result = await api.documents.saveBytes({
      suggestedName: file.name,
      mime: file.mime,
      base64: bytesToBase64(file.bytes)
    })
    if (!result.ok && result.error !== 'canceled') {
      throw new Error(result.error)
    }
    return
  }
  const blob = new Blob([file.bytes.buffer as ArrayBuffer], { type: file.mime })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = file.name
  anchor.click()
  URL.revokeObjectURL(url)
}
