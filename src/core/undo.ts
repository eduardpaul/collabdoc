import { UndoManager, type LoroDoc } from 'loro-crdt'
import { SYSTEM_ORIGIN_PREFIX, UNDO_MAX_STEPS } from '../shared/constants'
import { commitTimestamp } from './document'
import { containerToBlockId } from './history'

export type UndoKind = 'undo' | 'redo'

/**
 * One participant's undo stack. A `LoroDoc` only records its own peer's
 * commits as undo steps, so other actors' edits arrive as imports and are
 * never candidates; only this app's own `sys:` bookkeeping (author
 * registration, checkpoints) has to be excluded by origin.
 *
 * `mergeInterval` is what groups steps: 0 for agents (every tool call is a
 * step); for humans a wide ceiling the editor cuts under (see
 * `humanCommitCutter`).
 */
export function createUndoManager(doc: LoroDoc, options: { mergeInterval: number }): UndoManager {
  return new UndoManager(doc, {
    maxUndoSteps: UNDO_MAX_STEPS,
    mergeInterval: options.mergeInterval,
    excludeOriginPrefixes: [SYSTEM_ORIGIN_PREFIX]
  })
}

/**
 * Undo or redo as its own attributed history entry.
 *
 * Loro's `undo()` commits with no message and no timestamp — and an unstamped
 * commit merges into the previous change from this peer, so history would
 * show the typing and its reversal as one entry. Stamping the next commit
 * first keeps the undo a separate, named commit. The origin stays Loro's own
 * `undo`: it is not persisted, and `loro-prosemirror` re-renders a local
 * event only under that origin.
 * Returns the ids of the blocks the step touched (those that still exist).
 */
export function applyUndo(
  doc: LoroDoc,
  manager: UndoManager,
  kind: UndoKind
): { applied: boolean; blockIds: string[] } {
  const can = kind === 'undo' ? manager.canUndo() : manager.canRedo()
  if (!can) return { applied: false, blockIds: [] }
  const before = containerToBlockId(doc)
  const since = doc.oplogVersion()
  doc.setNextCommitOptions({ message: kind, timestamp: commitTimestamp() })
  const applied = kind === 'undo' ? manager.undo() : manager.redo()
  if (!applied) {
    doc.clearNextCommitOptions()
    return { applied: false, blockIds: [] }
  }
  const after = containerToBlockId(doc)
  const blockIds: string[] = []
  // No peer compression: container ids must match the live ones.
  for (const change of doc.exportJsonUpdates(since, undefined, false).changes) {
    for (const op of change.ops) {
      const container = String(op.container)
      const blockId = after.get(container) ?? before.get(container)
      if (blockId && !blockIds.includes(blockId)) blockIds.push(blockId)
    }
  }
  return { applied, blockIds }
}
