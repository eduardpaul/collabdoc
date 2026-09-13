import { Extension } from '@tiptap/core'
import { keymap } from '@tiptap/pm/keymap'
import type { Node as PmNode } from '@tiptap/pm/model'
import {
  Plugin,
  PluginKey,
  TextSelection,
  type EditorState,
  type Transaction
} from '@tiptap/pm/state'
import { ReplaceAroundStep, ReplaceStep } from '@tiptap/pm/transform'
import type { LoroDoc, UndoManager } from 'loro-crdt'
import {
  canRedo,
  canUndo,
  LoroEphemeralCursorPlugin,
  LoroSyncPlugin,
  loroSyncPluginKey,
  LoroUndoPlugin,
  ROOT_DOC_KEY,
  redo,
  undo,
  type LoroDocType
} from 'loro-prosemirror'
import { ensureTextShape } from '@core/tree'
import { BLOCK_ID_ATTR } from '@shared/constants'
import type { ActorProfile } from '@shared/types'
import { claimDecorations } from './claims'
import type { PresenceStore } from '../sync/presence-store'

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    loroCollab: {
      undo: () => ReturnType
      redo: () => ReturnType
    }
  }
}

export type LoroCollabOptions = {
  doc: LoroDoc
  presence: PresenceStore
  undoManager: UndoManager
  profile: ActorProfile
}

/**
 * Binds the editor to a Loro document: sync, undo scoped to this person's
 * own commits, remote cursors, and three guards for `loro-prosemirror`
 * behaviour re-verified against the pinned 0.4.4 (see `loro-collab.test.ts`).
 */
export const LoroCollab = Extension.create<LoroCollabOptions>({
  name: 'loroCollab',

  addCommands() {
    // Loro's undo re-renders the view from its own change event, inside the
    // call. Tiptap must not also dispatch the transaction it prepared for this
    // command against the state that just changed — hence `preventDispatch`.
    return {
      undo:
        () =>
        ({ state, tr, dispatch }) => {
          if (!dispatch) return canUndo(state)
          tr.setMeta('preventDispatch', true)
          return undo(state, dispatch)
        },
      redo:
        () =>
        ({ state, tr, dispatch }) => {
          if (!dispatch) return canRedo(state)
          tr.setMeta('preventDispatch', true)
          return redo(state, dispatch)
        }
    }
  },

  addProseMirrorPlugins() {
    const { doc, presence, undoManager, profile } = this.options
    return [
      LoroSyncPlugin({ doc: doc as LoroDocType }),
      textShapeKeeper(doc),
      remoteWritebackGuard(),
      remoteSelectionKeeper(),
      droppedBlockWatcher(doc),
      LoroUndoPlugin({ doc, undoManager }),
      LoroEphemeralCursorPlugin(presence.inner, {
        user: {
          name: profile.name,
          color: profile.color,
          actorId: profile.actorId,
          role: profile.role
        } as { name: string; color: string },
        createCursor: (peer) => createNamedCursor(presence, peer),
        createSelection: (peer) => {
          const color = presence.getAll()[peer]?.user?.color ?? '#c45c26'
          return {
            class: 'loro-selection',
            style: `background-color: ${color}33`
          }
        }
      }),
      claimDecorations(presence),
      keymap({ 'Mod-z': undo, 'Mod-y': redo, 'Mod-Shift-z': redo })
    ]
  }
})

function createNamedCursor(store: PresenceStore, peer: string): HTMLSpanElement {
  const user = store.getAll()[peer as keyof ReturnType<PresenceStore['getAll']>]?.user
  const color = user?.color ?? '#c45c26'
  const name = user?.name ?? peer.slice(0, 6)
  const cursor = document.createElement('span')
  cursor.className = 'ProseMirror-loro-cursor'
  cursor.style.borderColor = color
  cursor.dataset.peer = peer
  cursor.dataset.name = name
  const label = document.createElement('div')
  label.style.backgroundColor = color
  label.textContent = name
  cursor.append('\u2060', label, '\u2060')
  return cursor
}

/**
 * Every text block gets its `LoroText` the moment it exists.
 *
 * `loro-prosemirror` writes a new empty paragraph without a text container
 * and creates one with the first keystroke, so undoing that keystroke removes
 * the container — and whatever a collaborator typed into it meanwhile. After
 * a local transaction that inserted blocks, once the sync plugin has written
 * them to Loro, add the missing containers in a `sys:shape` commit that no
 * undo manager records. Runs after `LoroSyncPlugin` in plugin order.
 */
const textShapeKey = new PluginKey<boolean>('loroTextShape')

function insertsBlocks(tr: Transaction): boolean {
  return tr.steps.some((step) => {
    if (!(step instanceof ReplaceStep) && !(step instanceof ReplaceAroundStep)) return false
    let block = false
    step.slice.content.forEach((child) => {
      if (child.isBlock) block = true
    })
    return block
  })
}

export function textShapeKeeper(doc: LoroDoc): Plugin {
  return new Plugin({
    key: textShapeKey,
    state: {
      init: () => false,
      apply(tr, pending) {
        const meta = tr.getMeta(loroSyncPluginKey) as { type?: string } | undefined
        if (meta?.type === 'doc-changed') {
          if (pending && ensureTextShape(doc) > 0) {
            doc.commit({ origin: 'sys:shape', timestamp: Date.now() })
          }
          return false
        }
        if (meta?.type === 'non-local-updates') return false
        if (tr.getMeta('appendedTransaction')) return pending
        return tr.docChanged && insertsBlocks(tr)
      }
    }
  })
}

/**
 * A rebuild from Loro must never travel back into Loro.
 *
 * LoroSyncPlugin answers every document-changing transaction — including the
 * ones that replay a remote import onto the view — with an appended
 * `doc-changed` transaction that writes ProseMirror back over the Loro tree.
 * After a remote import that write-back is not a no-op: `createNodeFromLoroObj`
 * silently drops any node the schema rejects and ProseMirror normalises what
 * is left, so the client would send back a document missing the other
 * participant's block and Loro would record that as a local deletion.
 *
 * ProseMirror runs `filterTransaction` over appended transactions too, so the
 * write-back is dropped for any chain that a remote rebuild started. The
 * chain matters as much as the transaction: the block-id plugin appends its
 * own transaction after a rebuild, and the write-back that follows *that* one
 * carries the same loss. Local typing starts its own chain and still syncs.
 */
const remoteChainKey = new PluginKey<boolean>('loroRemoteChain')

export function remoteWritebackGuard(): Plugin {
  return new Plugin({
    key: remoteChainKey,
    state: {
      init: () => false,
      apply(tr, remote) {
        if (tr.getMeta('appendedTransaction')) return remote
        const meta = tr.getMeta(loroSyncPluginKey) as { type?: string } | undefined
        return meta?.type === 'non-local-updates'
      }
    },
    filterTransaction(tr, state) {
      const meta = tr.getMeta(loroSyncPluginKey) as { type?: string } | undefined
      if (meta?.type !== 'doc-changed') return true
      return !remoteChainKey.getState(state)
    }
  })
}

/**
 * An editor that renders fewer blocks than the document holds.
 *
 * `createNodeFromLoroObj` logs and skips any block the schema rejects, so a
 * block can be in the document — and in history — while never appearing on
 * screen. Nothing here rewrites the document: the block stays safe in Loro
 * and the write-back guard keeps the editor from deleting it. Say so, loudly,
 * so the schema gap is findable. Watching is all this does: replaying imports
 * by hand is what scrambled concurrent typing in the reference.
 */
export function droppedBlockWatcher(doc: LoroDoc): Plugin {
  return new Plugin({
    view(view) {
      const unsubscribe = doc.subscribe((event) => {
        if (event.by === 'local') return
        queueMicrotask(() => {
          if (view.isDestroyed) return
          const root = doc.getMap(ROOT_DOC_KEY).toJSON() as { children?: unknown[] }
          const inLoro = root.children?.length ?? 0
          const rendered = view.state.doc.childCount
          if (rendered >= inLoro) return
          console.warn(
            `[collabdoc] editor rendered ${rendered} of ${inLoro} blocks — the schema rejected the rest. ` +
              'They are still in the document; the editor is not writing back over them.'
          )
        })
      })
      return { destroy: unsubscribe }
    }
  })
}

/**
 * Hold the caret still while someone else writes.
 *
 * LoroSyncPlugin replays an import by replacing the whole document, which maps
 * every position inside it to the end of the replacement, and only then puts
 * the caret back — from a `setTimeout`, a tick later. Anything typed in that
 * gap is applied against a bogus selection and lost. With an agent streaming,
 * the document is replaced several times a second, so whole words disappear.
 *
 * Re-anchor the selection in the same dispatch instead, by block id: the caret
 * belongs to a block and an offset within it, and both survive a rebuild. The
 * library's late restore still runs and lands on the same place; it just no
 * longer has a window to itself.
 */
export function remoteSelectionKeeper(): Plugin {
  return new Plugin({
    appendTransaction(trs, oldState, newState) {
      const rebuilt = trs.some((tr) => {
        const meta = tr.getMeta(loroSyncPluginKey) as { type?: string } | undefined
        return meta?.type === 'non-local-updates'
      })
      if (!rebuilt) return null

      const anchor = blockAnchor(oldState, oldState.selection.anchor)
      const head = blockAnchor(oldState, oldState.selection.head)
      if (!anchor || !head) return null

      const from = anchorToPos(newState.doc, anchor)
      const to = anchorToPos(newState.doc, head)
      if (from == null || to == null) return null
      if (newState.selection.anchor === from && newState.selection.head === to) return null

      return newState.tr
        .setSelection(TextSelection.between(newState.doc.resolve(from), newState.doc.resolve(to)))
        .setMeta('addToHistory', false)
    }
  })
}

type BlockAnchor = { blockId: string; offset: number }

/** Where the caret sits, in terms that outlive a rebuild. */
function blockAnchor(state: EditorState, pos: number): BlockAnchor | null {
  if (pos > state.doc.content.size) return null
  const $pos = state.doc.resolve(pos)
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    const blockId = $pos.node(depth).attrs?.[BLOCK_ID_ATTR] as unknown
    if (typeof blockId === 'string' && blockId) {
      return { blockId, offset: pos - $pos.start(depth) }
    }
  }
  return null
}

function anchorToPos(doc: PmNode, anchor: BlockAnchor): number | null {
  let found: number | null = null
  doc.descendants((node, pos) => {
    if (found !== null) return false
    if (node.attrs?.[BLOCK_ID_ATTR] !== anchor.blockId) return true
    found = pos + 1 + Math.min(anchor.offset, node.content.size)
    return false
  })
  return found
}
