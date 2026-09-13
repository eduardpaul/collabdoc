import { Extension } from '@tiptap/core'
import { Plugin } from '@tiptap/pm/state'
import { Mapping } from '@tiptap/pm/transform'
import { UniqueID } from '@tiptap/extension-unique-id'
import { BLOCK_ID_ATTR, BLOCK_ID_TYPES } from './constants'

export function createBlockId(): string {
  return `b_${crypto.randomUUID().replace(/-/g, '').slice(0, 10)}`
}

const tracked = new Set<string>(BLOCK_ID_TYPES)

/**
 * UniqueID handles paste/drop. This pass covers insert/duplicate: a copy must
 * not keep the source id, otherwise comments would follow the copy.
 */
function dedupeBlockIdsPlugin(): Plugin {
  return new Plugin({
    appendTransaction(transactions, oldState, newState) {
      if (!transactions.some((transaction) => transaction.docChanged)) {
        return null
      }
      const mapping = new Mapping()
      for (const transaction of transactions) {
        mapping.appendMapping(transaction.mapping)
      }

      const ownerPos = new Map<string, number>()
      oldState.doc.descendants((node, pos) => {
        if (!tracked.has(node.type.name)) {
          return
        }
        const id = node.attrs[BLOCK_ID_ATTR]
        if (typeof id === 'string' && id) {
          ownerPos.set(id, mapping.map(pos))
        }
      })

      const seen = new Set<string>()
      let tr = newState.tr
      let changed = false
      newState.doc.descendants((node, pos) => {
        if (!tracked.has(node.type.name)) {
          return
        }
        const current = node.attrs[BLOCK_ID_ATTR] as string | null
        const ownedAt = current ? ownerPos.get(current) : undefined
        const duplicate = Boolean(current && seen.has(current))
        const copyOfExisting = Boolean(current && ownedAt !== undefined && ownedAt !== pos)
        if (!current || duplicate || copyOfExisting) {
          const next = createBlockId()
          tr = tr.setNodeMarkup(pos, undefined, { ...node.attrs, [BLOCK_ID_ATTR]: next })
          seen.add(next)
          changed = true
          return
        }
        seen.add(current)
      })
      if (!changed) {
        return null
      }
      tr.setMeta('addToHistory', false)
      return tr
    }
  })
}

export const BlockId = UniqueID.configure({
  attributeName: BLOCK_ID_ATTR,
  types: [...BLOCK_ID_TYPES],
  generateID: () => createBlockId()
})

export const DedupeBlockIds = Extension.create({
  name: 'dedupeBlockIds',
  addProseMirrorPlugins() {
    return [dedupeBlockIdsPlugin()]
  }
})
