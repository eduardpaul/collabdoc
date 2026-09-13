import { useEffect, useMemo, useRef, useState } from 'react'
import type { Editor } from '@tiptap/core'
import { useEditorState } from '@tiptap/react'
import { collectHits, searchPluginKey } from '../editor/search-highlight'
import { Button, TextInput } from './ui'

export function SearchReplace({
  editor,
  open,
  onClose
}: {
  editor: Editor
  open: boolean
  onClose: () => void
}): React.JSX.Element | null {
  const [query, setQuery] = useState('')
  const [replacement, setReplacement] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [index, setIndex] = useState(0)
  const findRef = useRef<HTMLInputElement>(null)
  const doc = useEditorState({
    editor,
    selector: ({ editor: current }) => current.state.doc
  })

  const hits = useMemo(() => collectHits(doc, query, caseSensitive), [doc, query, caseSensitive])
  const activeIndex = hits.length === 0 ? 0 : index % hits.length

  useEffect(() => {
    if (!open) {
      const tr = editor.state.tr.setMeta(searchPluginKey, { hits: [], index: 0 })
      tr.setMeta('addToHistory', false)
      editor.view.dispatch(tr)
      return
    }
    const tr = editor.state.tr.setMeta(searchPluginKey, { hits, index: activeIndex })
    tr.setMeta('addToHistory', false)
    editor.view.dispatch(tr)
    const hit = hits[activeIndex]
    if (hit) {
      editor.chain().setTextSelection({ from: hit.from, to: hit.to }).scrollIntoView().run()
    }
  }, [editor, hits, activeIndex, open])

  useEffect(() => {
    if (open) {
      findRef.current?.focus()
      findRef.current?.select()
    }
  }, [open])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const mod = event.metaKey || event.ctrlKey
      if (mod && event.key.toLowerCase() === 'f') {
        event.preventDefault()
        event.stopImmediatePropagation()
        if (open) {
          findRef.current?.focus()
          findRef.current?.select()
        }
        return
      }
      if (open && event.key === 'Escape') {
        event.preventDefault()
        event.stopImmediatePropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, onClose])

  if (!open) {
    return null
  }

  const go = (delta: number): void => {
    if (hits.length === 0) {
      return
    }
    setIndex((current) => (current + delta + hits.length) % hits.length)
  }

  const replaceOne = (): void => {
    const hit = hits[activeIndex]
    if (!hit) {
      return
    }
    editor.chain().focus().insertContentAt({ from: hit.from, to: hit.to }, replacement).run()
  }

  const replaceAll = (): void => {
    if (hits.length === 0) {
      return
    }
    let chain = editor.chain().focus()
    for (const hit of [...hits].reverse()) {
      chain = chain.insertContentAt({ from: hit.from, to: hit.to }, replacement)
    }
    chain.run()
  }

  return (
    <div className="search-replace" role="search" aria-label="Find and replace">
      <TextInput
        ref={findRef}
        value={query}
        aria-label="Find"
        placeholder="Find"
        onChange={(event) => {
          setQuery(event.target.value)
          setIndex(0)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            go(event.shiftKey ? -1 : 1)
          }
        }}
      />
      <TextInput
        value={replacement}
        aria-label="Replace"
        placeholder="Replace"
        onChange={(event) => setReplacement(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            replaceOne()
          }
        }}
      />
      <label className="search-case">
        <input
          type="checkbox"
          checked={caseSensitive}
          onChange={(event) => setCaseSensitive(event.target.checked)}
        />
        Aa
      </label>
      <span className="search-count" aria-live="polite">
        {hits.length ? `${activeIndex + 1}/${hits.length}` : '0'}
      </span>
      <Button size="sm" onClick={() => go(-1)} disabled={!hits.length} aria-label="Previous match">
        Prev
      </Button>
      <Button size="sm" onClick={() => go(1)} disabled={!hits.length} aria-label="Next match">
        Next
      </Button>
      <Button size="sm" onClick={replaceOne} disabled={!hits.length} aria-label="Replace one">
        Replace
      </Button>
      <Button size="sm" onClick={replaceAll} disabled={!hits.length} aria-label="Replace all">
        All
      </Button>
      <Button size="sm" variant="ghost" onClick={onClose} aria-label="Close search">
        ×
      </Button>
    </div>
  )
}
