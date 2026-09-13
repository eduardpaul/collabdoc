import type { EphemeralStore, LoroDoc, LoroMap } from 'loro-crdt'
import type { SessionLimits } from '../../shared/constants'
import type {
  ActorProfile,
  BlockId,
  MutationErr,
  MutationErrorKind,
  MutationResult,
  Presence,
  UndoState
} from '../../shared/types'
import type { LocatedBlock } from '../tree'

/**
 * What the tool implementations need from a `DocumentSession`. Keeping this
 * an interface lets each tool module be a set of plain functions.
 */
export interface SessionContext {
  readonly doc: LoroDoc
  readonly ephemeral: EphemeralStore
  readonly profile: ActorProfile
  readonly limits: SessionLimits
  readonly peerId: string
  /** Find a block and refuse if the caller's `view` is stale. */
  prepareBlock(
    blockId: BlockId,
    view: string | undefined
  ): MutationErr | { ok: true; found: LocatedBlock }
  /** Another participant's live claim on the block, when claims are enforced. */
  claimConflict(blockId: BlockId): MutationErr | null
  /** Run `write` inside one undo step and one attributed commit. */
  mutate(applied: string, write: () => LoroMap[]): MutationResult
  /** Commit sidecar changes (comments) as one attributed, undoable step. */
  commit(message: string, write: () => void): void
  undoState(): UndoState
  presence(nearBlockId?: string): Presence[]
  writePresence(cursorBytes: Uint8Array | null, claimIds?: string[], until?: string): void
}

export function fail(error: MutationErrorKind, message: string): MutationErr {
  return { ok: false, error, message }
}

export function isMutationResult(value: unknown): value is MutationResult {
  return (
    typeof value === 'object' &&
    value != null &&
    'ok' in value &&
    typeof (value as MutationResult).ok === 'boolean'
  )
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

export function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  if (!value.every((item) => typeof item === 'string')) return undefined
  return value as string[]
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}
