import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { BLOCK_ID_ATTR } from '@shared/constants'
import type { HistoryAuthor } from '@core/authors'

export const attributionKey = new PluginKey<DecorationSet>('blockAttribution')

export type AttributionSource = {
  enabled: boolean
  colorFor: (blockId: string) => HistoryAuthor | undefined
}

export function attributionDecorations(source: () => AttributionSource): Plugin {
  return new Plugin({
    key: attributionKey,
    state: {
      init: (_, state) => decorationsFor(state.doc, source()),
      apply(tr, prev, _old, next) {
        const meta = tr.getMeta(attributionKey) as { refresh?: boolean } | undefined
        if (meta?.refresh || tr.docChanged) return decorationsFor(next.doc, source())
        return prev.map(tr.mapping, tr.doc)
      }
    },
    props: {
      decorations(state) {
        return attributionKey.getState(state)
      }
    }
  })
}

function decorationsFor(
  doc: Parameters<typeof DecorationSet.create>[0],
  source: AttributionSource
): DecorationSet {
  if (!source.enabled) return DecorationSet.empty
  const decos: Decoration[] = []
  doc.descendants((node, pos) => {
    const blockId = node.attrs?.[BLOCK_ID_ATTR]
    if (typeof blockId !== 'string' || !blockId || !node.isBlock) return
    const author = source.colorFor(blockId)
    if (!author) return
    decos.push(
      Decoration.node(pos, pos + node.nodeSize, {
        class: 'is-attributed',
        style: `--author-color: ${author.color}`,
        'data-last-author': author.name
      })
    )
  })
  return DecorationSet.create(doc, decos)
}
