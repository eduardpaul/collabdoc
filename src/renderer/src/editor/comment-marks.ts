import { Extension } from '@tiptap/core'
import type { Node as PmNode } from '@tiptap/pm/model'
import { Plugin, PluginKey, TextSelection, type EditorState } from '@tiptap/pm/state'
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'
import { loroSyncPluginKey } from 'loro-prosemirror'
import { BLOCK_ID_ATTR } from '@shared/constants'

/** A thread's current place in the document, in block-text offsets. */
export type CommentSpan = {
  id: string
  blockId: string
  start: number
  end: number
  whole: boolean
  color: string
}

type CommentMarksState = {
  spans: CommentSpan[]
  selected: string | null
  decorations: DecorationSet
}

type Meta = { spans?: CommentSpan[]; selected?: string | null; flash?: string }

export const commentMarksKey = new PluginKey<CommentMarksState>('commentMarks')

/**
 * Highlights for open threads, coloured by their author. Spans are resolved
 * outside (Loro cursors, see `currentSpan`) and handed in through a meta;
 * between refreshes the decorations ride along with the transaction mapping
 * so typing next to a highlight never makes it jump. Clicking a highlight
 * selects its card.
 */
export function commentMarks(onSelect: (threadId: string) => void): Plugin<CommentMarksState> {
  return new Plugin<CommentMarksState>({
    key: commentMarksKey,
    state: {
      init: () => ({ spans: [], selected: null, decorations: DecorationSet.empty }),
      apply(tr, prev, _old, newState) {
        const meta = tr.getMeta(commentMarksKey) as Meta | undefined
        if (!meta) {
          if (!tr.docChanged) return prev
          // A remote rebuild replaces the whole document, which would map
          // every highlight to its end: re-place them by block id instead.
          const sync = tr.getMeta(loroSyncPluginKey) as { type?: string } | undefined
          if (sync?.type === 'non-local-updates') {
            return { ...prev, decorations: build(newState.doc, prev.spans, prev.selected) }
          }
          return { ...prev, decorations: prev.decorations.map(tr.mapping, tr.doc) }
        }
        const spans = meta.spans ?? prev.spans
        const selected = meta.selected === undefined ? prev.selected : meta.selected
        return { spans, selected, decorations: build(newState.doc, spans, selected, meta.flash) }
      }
    },
    props: {
      decorations(state) {
        return commentMarksKey.getState(state)?.decorations ?? DecorationSet.empty
      },
      // Selecting the card; the click still places the caret, so nothing is
      // reported as handled.
      handleClick(view, pos) {
        const set = commentMarksKey.getState(view.state)?.decorations
        const hit = set?.find(pos, pos).find((d) => typeof d.spec.threadId === 'string')
        if (hit) onSelect(hit.spec.threadId as string)
      }
    }
  })
}

export const CommentMarks = Extension.create<{
  onSelect: (threadId: string) => void
  /** `Mod-Alt-m`: comment on the selection. Handled here so the browser never
   * treats the chord as text input (Ctrl+Alt is AltGr on Linux). */
  onComment: () => void
}>({
  name: 'commentMarks',
  addOptions() {
    return { onSelect: () => undefined, onComment: () => undefined }
  },
  addKeyboardShortcuts() {
    return {
      'Mod-Alt-m': () => {
        this.options.onComment()
        return true
      }
    }
  },
  addProseMirrorPlugins() {
    return [commentMarks((id) => this.options.onSelect(id))]
  }
})

/** Put the caret at a thread's span and bring it on screen, flashing it. */
export function revealThread(view: EditorView, threadId: string): boolean {
  const range = spanRange(view.state, threadId)
  if (!range) return false
  const tr = view.state.tr
    .setSelection(TextSelection.create(view.state.doc, range.from))
    .setMeta(commentMarksKey, { selected: threadId, flash: threadId } satisfies Meta)
    .scrollIntoView()
  view.dispatch(tr)
  return true
}

export function spanRange(
  state: EditorState,
  threadId: string
): { from: number; to: number } | null {
  const set = commentMarksKey.getState(state)?.decorations
  const hit = set?.find(undefined, undefined, (spec) => spec.threadId === threadId)[0]
  return hit ? { from: hit.from, to: hit.to } : null
}

function build(
  doc: PmNode,
  spans: CommentSpan[],
  selected: string | null,
  flash?: string
): DecorationSet {
  if (spans.length === 0) return DecorationSet.empty
  const byBlock = new Map<string, CommentSpan[]>()
  for (const span of spans) {
    const list = byBlock.get(span.blockId) ?? []
    list.push(span)
    byBlock.set(span.blockId, list)
  }
  const decorations: Decoration[] = []
  doc.descendants((node, pos) => {
    if (byBlock.size === 0) return false
    const blockId = node.attrs?.[BLOCK_ID_ATTR] as unknown
    if (typeof blockId !== 'string') return true
    const list = byBlock.get(blockId)
    if (!list) return true
    byBlock.delete(blockId)
    const text = firstTextblock(node, pos)
    for (const span of list) {
      const state =
        span.id === selected ? (span.id === flash ? ' is-selected is-flash' : ' is-selected') : ''
      const spec = { threadId: span.id }
      if (span.whole || !text) {
        decorations.push(
          Decoration.node(
            pos,
            pos + node.nodeSize,
            {
              class: `comment-block${state}`,
              style: `--thread-color: ${span.color}`,
              'data-thread': span.id
            },
            spec
          )
        )
        continue
      }
      const size = text.node.content.size
      const from = text.pos + 1 + Math.min(span.start, size)
      const to = text.pos + 1 + Math.min(span.end, size)
      if (to <= from) continue
      decorations.push(
        Decoration.inline(
          from,
          to,
          {
            class: `comment-span${state}`,
            style: `--thread-color: ${span.color}`,
            'data-thread': span.id
          },
          spec
        )
      )
    }
    return false
  })
  return DecorationSet.create(doc, decorations)
}

/** The node whose text a span's offsets index: the block itself or its first textblock. */
function firstTextblock(node: PmNode, pos: number): { node: PmNode; pos: number } | null {
  if (node.isTextblock) return { node, pos }
  let found: { node: PmNode; pos: number } | null = null
  node.descendants((child, childPos) => {
    if (found) return false
    if (child.isTextblock) {
      found = { node: child, pos: pos + 1 + childPos }
      return false
    }
    return true
  })
  return found
}
