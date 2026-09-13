import { Extension, type CommandProps } from '@tiptap/core'
import type { Node as PmNode } from '@tiptap/pm/model'
import {
  Plugin,
  PluginKey,
  TextSelection,
  type EditorState,
  type Transaction
} from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import { ReplaceAroundStep, ReplaceStep } from '@tiptap/pm/transform'
import type { LoroDoc, UndoManager } from 'loro-crdt'
import {
  canRedo,
  canUndo,
  LoroEphemeralCursorPlugin,
  LoroSyncPlugin,
  loroSyncPluginKey,
  LoroUndoPlugin,
  loroUndoPluginKey,
  ROOT_DOC_KEY,
  type LoroDocType
} from 'loro-prosemirror'
import { commitTimestamp } from '@core/document'
import { applyUndo, type UndoKind } from '@core/undo'
import { ensureTextShape } from '@core/tree'
import { BLOCK_ID_ATTR, HUMAN_COMMIT_IDLE_MS, UNDO_STEP_MAX_MS } from '@shared/constants'
import type { ActorProfile } from '@shared/types'
import { attributionDecorations, type AttributionSource } from './attribution'
import { claimDecorations } from './claims'
import { currentBlockId } from './current-block'
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
  attribution?: () => AttributionSource
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
    const { doc, undoManager } = this.options
    const step =
      (kind: UndoKind) =>
      () =>
      ({ state, tr, dispatch, view }: CommandProps): boolean => {
        if (!dispatch) return kind === 'undo' ? canUndo(state) : canRedo(state)
        tr.setMeta('preventDispatch', true)
        return undoInView(view, doc, undoManager, kind)
      }
    return { undo: step('undo'), redo: step('redo') }
  },

  addKeyboardShortcuts() {
    return {
      'Mod-z': () => this.editor.commands.undo(),
      'Mod-y': () => this.editor.commands.redo(),
      'Mod-Shift-z': () => this.editor.commands.redo()
    }
  },

  addProseMirrorPlugins() {
    const { doc, presence, undoManager, profile, attribution } = this.options
    return [
      LoroSyncPlugin({ doc: doc as LoroDocType }),
      textShapeKeeper(doc),
      humanCommitCutter(doc, undoManager, () => `actor:${profile.actorId}`),
      remoteWritebackGuard(),
      remoteSelectionKeeper(),
      droppedBlockWatcher(doc),
      LoroUndoPlugin({ doc, undoManager }),
      ...(attribution ? [attributionDecorations(attribution)] : []),
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
      claimDecorations(presence)
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

/**
 * Human typing is one Loro change until 1 s idle or the caret moves to
 * another block.
 *
 * LoroSyncPlugin commits every transaction with no message and no timestamp,
 * and Loro merges such a commit into the previous change from the same peer
 * (the merge interval never separates them: an unstamped commit inherits the
 * last timestamp). So a burst merges on its own; what needs doing is the cut.
 * A cut is a fresh timestamp on the *next* commit, handed to Loro through
 * `setNextCommitOptions` before the sync plugin commits — which is why this
 * runs in `state.apply` on the editing transaction, ahead of the appended
 * `doc-changed` one. An empty `commit()` after the fact would be swallowed.
 *
 * A transaction carrying `commitMessageKey` is always its own change, with
 * that message: restore uses it.
 */
export const commitMessageKey = new PluginKey<string>('loroCommitMessage')

export function humanCommitCutter(
  doc: LoroDoc,
  undoManager: UndoManager,
  origin: () => string
): Plugin<string | null> {
  let idleCut = false
  let idle: ReturnType<typeof setTimeout> | null = null
  return new Plugin<string | null>({
    state: {
      init: () => null,
      // State: the block the caret was in after the last local edit.
      apply(tr, lastBlock, oldState, newState) {
        const meta = tr.getMeta(loroSyncPluginKey) as { type?: string } | undefined
        if (meta?.type === 'doc-changed') {
          // The sync plugin has committed (this transaction carries no steps
          // of its own); undo steps may group again.
          undoManager.setMergeInterval(UNDO_STEP_MAX_MS)
          return lastBlock
        }
        if (!tr.docChanged || meta || tr.getMeta('appendedTransaction')) return lastBlock
        const message = tr.getMeta(commitMessageKey) as string | undefined
        // Where this edit started — after any click or arrow key, which never
        // reach here because they don't change the doc.
        const before = currentBlockId(oldState)
        const switched = before != null && lastBlock != null && before !== lastBlock
        if (message || idleCut || switched) {
          doc.setNextCommitOptions({ origin: origin(), timestamp: commitTimestamp(), message })
        }
        // The undo stack cuts where history cuts: this commit must not merge
        // into the last step. Loro's own interval is a ceiling, not an idle
        // timer (see `UNDO_STEP_MAX_MS`).
        if (message || idleCut || switched) undoManager.setMergeInterval(0)
        idleCut = false
        if (idle) clearTimeout(idle)
        idle = setTimeout(() => {
          idleCut = true
        }, HUMAN_COMMIT_IDLE_MS)
        return currentBlockId(newState) ?? before
      }
    },
    view() {
      return {
        destroy() {
          if (idle) clearTimeout(idle)
        }
      }
    }
  })
}

/**
 * Undo/redo from the editor: Loro applies the step and the sync plugin
 * rebuilds the view from the change event. `LoroUndoPlugin` restores the
 * caret from cursors it stored with the step, a tick later; scrolling it
 * into view is queued behind that.
 */
export function undoInView(
  view: EditorView,
  doc: LoroDoc,
  undoManager: UndoManager,
  kind: UndoKind
): boolean {
  const undoState = loroUndoPluginKey.getState(view.state) as
    { isUndoing: { current: boolean } } | undefined
  if (undoState) undoState.isUndoing.current = true
  const { applied } = applyUndo(doc, undoManager, kind)
  setTimeout(() => {
    if (undoState) undoState.isUndoing.current = false
    if (applied && !view.isDestroyed) view.dispatch(view.state.tr.scrollIntoView())
  }, 0)
  return applied
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
            doc.commit({ origin: 'sys:shape', timestamp: commitTimestamp() })
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
