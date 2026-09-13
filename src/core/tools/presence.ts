import { Cursor } from 'loro-crdt'
import type { MutationErr, Presence, PresenceResult, SetPresenceResult } from '../../shared/types'
import { blockIdFromCursor, cursorAt, findBlock } from '../tree'
import { asRecord, asString, asStringArray, fail, type SessionContext } from './context'

/**
 * What one peer publishes about itself in the ephemeral store.
 *
 * `user` carries `actorId`/`role` so presence can name who a peer is. The
 * editor writes this shape too; anything without it is a peer we know nothing
 * about, and the honest answer for those is the peer id and an unknown role —
 * never a guess.
 */
export type EphemeralPayload = {
  anchor: Uint8Array | null
  focus: Uint8Array | null
  user: {
    name: string
    color: string
    actorId?: string
    role?: 'human' | 'agent'
  } | null
  claim?: { blockIds: string[]; until: string } | null
}

export function setPresence(
  ctx: SessionContext,
  args: Record<string, unknown>
): SetPresenceResult | MutationErr {
  if (args.cursor !== undefined && !asRecord(args.cursor)) {
    return fail('schema', 'cursor must be an object with blockId.')
  }
  if (args.claimBlockIds !== undefined && !asStringArray(args.claimBlockIds)) {
    return fail('schema', 'claimBlockIds must be an array of block ids.')
  }
  const cursor = asRecord(args.cursor) as { blockId?: string; offset?: number } | undefined
  const claimIds = asStringArray(args.claimBlockIds) ?? []
  const requested =
    typeof args.claimSeconds === 'number' ? args.claimSeconds : ctx.limits.defaultClaimSeconds
  const seconds = Math.max(1, Math.min(requested, ctx.limits.maxClaimSeconds))
  let encoded: Uint8Array | null = null
  if (cursor?.blockId) {
    const found = findBlock(ctx.doc, cursor.blockId)
    if (!found) return fail('not_found', `Block ${cursor.blockId} was not found.`)
    encoded = cursorAt(found.node, cursor.offset ?? 0)?.encode() ?? null
  }
  for (const id of claimIds) {
    if (!findBlock(ctx.doc, id)) return fail('not_found', `Block ${id} was not found.`)
  }
  const until =
    claimIds.length > 0 ? new Date(Date.now() + seconds * 1000).toISOString() : undefined
  ctx.writePresence(encoded, claimIds, until)
  return { ok: true as const, presence: { actors: ctx.presence() } }
}

export function getPresence(ctx: SessionContext, args: Record<string, unknown>): PresenceResult {
  return { actors: ctx.presence(asString(args.nearBlockId)) }
}

/** Decode every peer's ephemeral state into `Presence` rows. */
export function readPresence(ctx: SessionContext, nearBlockId?: string): Presence[] {
  const actors: Presence[] = []
  const states = ctx.ephemeral.getAllStates() as Record<string, EphemeralPayload | undefined>
  for (const [peer, state] of Object.entries(states)) {
    if (!state) continue
    let cursor: Presence['cursor']
    if (state.focus) {
      try {
        const located = blockIdFromCursor(ctx.doc, Cursor.decode(state.focus))
        if (located) cursor = located
      } catch {
        /* stale cursor from a block that no longer exists */
      }
    }
    const claim =
      state.claim?.until && Date.parse(state.claim.until) > Date.now() ? state.claim : undefined
    if (nearBlockId && cursor?.blockId !== nearBlockId && !claim?.blockIds.includes(nearBlockId)) {
      continue
    }
    const isSelf = peer === ctx.peerId
    actors.push({
      actorId: isSelf ? ctx.profile.actorId : (state.user?.actorId ?? peer),
      peerId: peer,
      role: isSelf ? ctx.profile.role : state.user?.role,
      name: isSelf ? ctx.profile.name : state.user?.name,
      color: isSelf ? ctx.profile.color : state.user?.color,
      cursor,
      claim
    })
  }
  return actors
}

/** Whether another live peer currently claims `blockId`. */
export function findClaim(ctx: SessionContext, blockId: string): { who: string } | null {
  const states = ctx.ephemeral.getAllStates() as Record<string, EphemeralPayload | undefined>
  for (const [peer, state] of Object.entries(states)) {
    if (!state?.claim || peer === ctx.peerId) continue
    if (Date.parse(state.claim.until) <= Date.now()) continue
    if (state.claim.blockIds.includes(blockId)) {
      return { who: state.user?.name ?? peer }
    }
  }
  return null
}
