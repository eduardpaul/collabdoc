import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode
} from 'react'
import { EditorContent, useEditorState } from '@tiptap/react'
import { NodeSelection } from '@tiptap/pm/state'
import { currentSpan } from '@core/comments'
import type { HistoryBlock, HistoryEntry } from '@core/history'
import type { RegistryPerson } from '@core/participants'
import type { MentionState } from '@shared/types'
import { previewAt } from '@core/history'
import { attributionKey } from '../editor/attribution'
import { AssetError, bytesToBase64, putFile, setAssetDocument } from '../editor/assets'
import { commentMarksKey, revealThread, type CommentSpan } from '../editor/comment-marks'
import { currentBlockId, currentBlockMarkdown } from '../editor/current-block'
import { configureFigureHost } from '../editor/figure-host'
import { exportSelectedFigure } from '../editor/figures/export'
import { blockAnchor, commitMessageKey } from '../editor/loro-collab'
import {
  refreshMentions,
  setChipState,
  type MentionRequestOptions,
  type SendRequest
} from '../editor/mentions'
import { useCollabEditor } from '../editor/useCollabEditor'
import type { DocumentClient } from '../sync/DocumentClient'
import type { CommentsView } from '../sync/useComments'
import type { HistoryView } from '../sync/useHistory'
import type { CommentDraft } from './CommentsPanel'
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
  onMarkdown,
  readOnly = false,
  history,
  travel,
  restoreTo,
  onCloseTravel,
  onRestored,
  comments,
  selectedThread = null,
  onSelectThread,
  onDraftComment,
  revealRef,
  people = [],
  onSendMention,
  mentionAutoSendSeconds = 0,
  chipStateRef
}: {
  client: DocumentClient
  title: ReactNode
  onNotice: (message: string) => void
  onMarkdown: (markdown: string) => void
  readOnly?: boolean
  history?: HistoryView
  travel?: HistoryEntry | null
  restoreTo?: HistoryEntry | null
  onCloseTravel?: () => void
  onRestored?: () => void
  comments?: CommentsView
  selectedThread?: string | null
  onSelectThread?: (threadId: string) => void
  /** The user asked to comment on the selection (or the current block). */
  onDraftComment?: (draft: CommentDraft) => void
  /** Filled in with a function that scrolls the editor to a thread's span. */
  revealRef?: MutableRefObject<((threadId: string) => void) | null>
  /** Everyone mentionable here (offline collaborators included). */
  people?: RegistryPerson[]
  onSendMention?: (request: SendRequest) => boolean
  mentionAutoSendSeconds?: number
  /** Filled in with a function that writes a request's state onto its chip. */
  chipStateRef?: MutableRefObject<((requestId: string, state: MentionState) => boolean) | null>
}): React.JSX.Element {
  const [attribution, setAttribution] = useState(false)
  const attributionRef = useRef({
    enabled: false,
    colorFor: (_blockId: string) => history?.index?.lastAuthor(_blockId)
  })
  const attributionFn = useCallback(() => attributionRef.current, [])
  const selectThreadRef = useRef(onSelectThread)
  const selectThread = useCallback((id: string) => selectThreadRef.current?.(id), [])
  const draftRef = useRef<() => void>(() => undefined)
  const commentShortcut = useCallback(() => draftRef.current(), [])
  const mentionRef = useRef({ people, onSendMention, mentionAutoSendSeconds })
  const mentionOptions = useMemo<MentionRequestOptions>(
    () => ({
      roster: () => mentionRef.current.people,
      onSend: (request) => mentionRef.current.onSendMention?.(request) ?? false,
      autoSendSeconds: () => mentionRef.current.mentionAutoSendSeconds
    }),
    []
  )
  const editor = useCollabEditor(
    client,
    !readOnly,
    attributionFn,
    selectThread,
    commentShortcut,
    mentionOptions
  )
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
    selectThreadRef.current = onSelectThread
  }, [editor, onNotice, onSelectThread])

  useEffect(() => {
    mentionRef.current = { people, onSendMention, mentionAutoSendSeconds }
    refreshMentions(editor)
  }, [editor, people, onSendMention, mentionAutoSendSeconds])

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
    attributionRef.current = {
      enabled: attribution,
      colorFor: (blockId) => history?.index?.lastAuthor(blockId)
    }
  }, [attribution, history])

  useEffect(() => {
    if (editor.isDestroyed) return
    editor.view.dispatch(editor.state.tr.setMeta(attributionKey, { refresh: true }))
  }, [editor, attribution, history?.version])

  // Highlights follow the threads: re-place them from Loro cursors whenever
  // the comment set or the selection changes.
  useEffect(() => {
    if (editor.isDestroyed) return
    const spans: CommentSpan[] = []
    for (const thread of comments?.threads ?? []) {
      if (thread.status !== 'open' || thread.orphaned) continue
      const span = currentSpan(client.doc, thread)
      if (!span) continue
      spans.push({
        id: thread.id,
        blockId: thread.blockId,
        start: span.start,
        end: span.end,
        whole: thread.whole === true,
        color: thread.author.color
      })
    }
    editor.view.dispatch(
      editor.state.tr.setMeta(commentMarksKey, { spans, selected: selectedThread })
    )
  }, [editor, client, comments?.threads, selectedThread])

  useEffect(() => {
    if (!revealRef) return
    revealRef.current = (threadId) => {
      if (!editor.isDestroyed) revealThread(editor.view, threadId)
    }
    return () => {
      revealRef.current = null
    }
  }, [editor, revealRef])

  useEffect(() => {
    if (!chipStateRef) return
    chipStateRef.current = (requestId, state) =>
      setChipState(editor, client.undoManager, requestId, state)
    return () => {
      chipStateRef.current = null
    }
  }, [editor, client, chipStateRef])

  // A comment on the selection, or on the block the caret is in.
  const draftComment = useCallback((): void => {
    if (readOnly || !onDraftComment) return
    const { state } = editor
    const sel = state.selection
    if (sel.empty) {
      const blockId = currentBlockId(state)
      if (!blockId) return
      onDraftComment({ blockId, quote: '' })
      return
    }
    const from = blockAnchor(state, sel.from)
    const to = blockAnchor(state, sel.to)
    if (!from || !to || from.blockId !== to.blockId) {
      onNotice('Select text within one block to comment on it.')
      return
    }
    const quote = state.doc.textBetween(sel.from, sel.to, ' ').trim()
    if (!quote) return
    onDraftComment({ blockId: from.blockId, start: from.offset, end: to.offset, quote })
  }, [editor, readOnly, onDraftComment, onNotice])

  // One transaction, one Loro change: the cutter reads the message meta and
  // stamps the sync plugin's commit with it (see `humanCommitCutter`).
  const applyRestore = useCallback(
    (entry: HistoryEntry): void => {
      if (readOnly) {
        noticeRef.current('This document is read-only; nothing to restore into.')
        return
      }
      const json = client.previewJson(entry.frontiers)
      if (!json) return
      editor.chain().setMeta(commitMessageKey, 'Restore version').setContent(json).run()
    },
    [client, editor, readOnly]
  )

  useEffect(() => {
    if (!restoreTo || editor.isDestroyed) return
    applyRestore(restoreTo)
    onRestored?.()
  }, [applyRestore, editor, restoreTo, onRestored])

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

  useEffect(() => {
    draftRef.current = draftComment
  }, [draftComment])

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
        attribution={attribution}
        onToggleAttribution={() => setAttribution((value) => !value)}
        onComment={readOnly ? undefined : draftComment}
        onMention={readOnly ? undefined : () => editor.chain().focus().insertContent('@').run()}
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
          {travel ? (
            <TravelOverlay
              entry={travel}
              blocks={previewAt(client.doc, travel.frontiers)}
              onClose={() => onCloseTravel?.()}
              onRestore={
                readOnly
                  ? undefined
                  : () => {
                      applyRestore(travel)
                      onCloseTravel?.()
                    }
              }
            />
          ) : null}
          <EditorContent editor={editor} />
          {travel ? null : (
            <SelectionBar editor={editor} onComment={readOnly ? undefined : draftComment} />
          )}
        </div>
      </article>
    </div>
  )
}

function TravelOverlay({
  entry,
  blocks,
  onClose,
  onRestore
}: {
  entry: HistoryEntry
  blocks: HistoryBlock[]
  onClose: () => void
  onRestore?: () => void
}): React.JSX.Element {
  const when = new Date(entry.timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit'
  })
  return (
    <div className="travel-overlay" data-testid="travel-overlay">
      <div className="travel-banner">
        <p>
          Viewing version from {when} by {entry.author.name}
        </p>
        <div className="travel-banner__actions">
          {onRestore ? (
            <Button size="sm" variant="primary" onClick={onRestore}>
              Restore
            </Button>
          ) : null}
          <Button size="sm" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
      <div className="travel-doc" aria-readonly="true">
        {blocks.map((block, i) => (
          <section key={block.blockId ?? i} data-type={block.type}>
            {block.text || <span className="muted">Empty {block.type}</span>}
          </section>
        ))}
      </div>
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
