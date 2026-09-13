import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { Node } from '@tiptap/pm/model'

export type SearchHit = { from: number; to: number }

export type SearchHighlightMeta = {
  hits: SearchHit[]
  index: number
}

export const searchPluginKey = new PluginKey<DecorationSet>('searchHighlight')

export function collectHits(doc: Node, query: string, caseSensitive: boolean): SearchHit[] {
  if (!query) {
    return []
  }
  const hits: SearchHit[] = []
  const needle = caseSensitive ? query : query.toLowerCase()
  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) {
      return
    }
    const hay = caseSensitive ? node.text : node.text.toLowerCase()
    let idx = 0
    while (idx <= hay.length - needle.length) {
      const found = hay.indexOf(needle, idx)
      if (found < 0) {
        break
      }
      hits.push({ from: pos + found, to: pos + found + query.length })
      idx = found + Math.max(query.length, 1)
    }
  })
  return hits
}

export function searchHighlightPlugin(): Plugin {
  return new Plugin({
    key: searchPluginKey,
    state: {
      init: () => DecorationSet.empty,
      apply(tr, set) {
        const meta = tr.getMeta(searchPluginKey) as SearchHighlightMeta | undefined
        if (meta) {
          const decorations = meta.hits.map((hit, index) =>
            Decoration.inline(hit.from, hit.to, {
              class: index === meta.index ? 'search-hit is-current' : 'search-hit'
            })
          )
          return DecorationSet.create(tr.doc, decorations)
        }
        return set.map(tr.mapping, tr.doc)
      }
    },
    props: {
      decorations(state) {
        return this.getState(state)
      }
    }
  })
}

export const SearchHighlight = Extension.create({
  name: 'searchHighlight',
  addProseMirrorPlugins() {
    return [searchHighlightPlugin()]
  }
})
