import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { BLOCK_ID_ATTR } from '@shared/constants'
import type { PresenceStore } from '../sync/presence-store'

const key = new PluginKey<DecorationSet>('claimDecorations')

function decorationsFor(
  doc: Parameters<typeof DecorationSet.create>[0],
  store: PresenceStore
): DecorationSet {
  const found: Array<{ pos: number; size: number; blockId: string }> = []
  doc.descendants((node, pos) => {
    const blockId = node.attrs?.[BLOCK_ID_ATTR]
    if (typeof blockId === 'string' && blockId && node.isBlock) {
      found.push({ pos, size: node.nodeSize, blockId })
    }
    return true
  })
  const decos: Decoration[] = []
  for (const entry of store.claims()) {
    for (const blockId of entry.claim.blockIds) {
      const node = found.find((item) => item.blockId === blockId)
      if (!node) continue
      decos.push(
        Decoration.node(node.pos, node.pos + node.size, {
          class: 'is-claimed',
          style: `--claim-color: ${entry.color}`,
          'data-claimer': entry.name
        })
      )
      decos.push(
        Decoration.widget(node.pos + 1, () => {
          const label = document.createElement('span')
          label.className = 'claim-gutter'
          label.style.setProperty('--claim-color', entry.color)
          label.textContent = entry.name
          return label
        })
      )
    }
  }
  return DecorationSet.create(doc, decos)
}

/** Advisory claim outline + gutter name, driven by the ephemeral store. */
export function claimDecorations(store: PresenceStore): Plugin {
  return new Plugin({
    key,
    state: {
      init: (_, state) => decorationsFor(state.doc, store),
      apply(tr, prev, _old, next) {
        const meta = tr.getMeta(key) as { refresh?: boolean } | undefined
        if (meta?.refresh || tr.docChanged) return decorationsFor(next.doc, store)
        return prev.map(tr.mapping, tr.doc)
      }
    },
    props: {
      decorations(state) {
        return key.getState(state)
      }
    },
    view(view) {
      const stop = store.subscribeBy(() => {
        if (view.isDestroyed) return
        view.dispatch(view.state.tr.setMeta(key, { refresh: true }))
      })
      return { destroy: stop }
    }
  })
}
