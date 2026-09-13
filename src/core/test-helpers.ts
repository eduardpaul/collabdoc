import { REVIEWER_TOOLS, WRITER_TOOLS } from '../shared/tools'
import type { ActorProfile, BlockView, MutationResult, SessionOptions } from '../shared/types'
import type { SyncHub } from './hub'
import { DocumentSession } from './session'

export function profile(actorId: string, role: 'human' | 'agent' = 'agent'): ActorProfile {
  return {
    actorId,
    name: actorId[0].toUpperCase() + actorId.slice(1),
    color: '#123456',
    role,
    handle: actorId
  }
}

export function writer(
  hub: SyncHub,
  actorId: string,
  options: SessionOptions = {}
): DocumentSession {
  return new DocumentSession(hub, profile(actorId), {
    enforceClaims: false,
    allowedTools: WRITER_TOOLS,
    ...options
  })
}

export function reviewer(
  hub: SyncHub,
  actorId: string,
  options: SessionOptions = {}
): DocumentSession {
  return new DocumentSession(hub, profile(actorId), {
    enforceClaims: false,
    allowedTools: REVIEWER_TOOLS,
    ...options
  })
}

export function human(hub: SyncHub, actorId = 'ana'): DocumentSession {
  return new DocumentSession(hub, profile(actorId, 'human'), { enforceClaims: false })
}

/** Insert one paragraph at the end and return its block id. */
export function addParagraph(session: DocumentSession, text: string): string {
  const result = session.call('insert_blocks', {
    at: { relation: 'inside_end' },
    blocks: [{ type: 'paragraph', text }]
  }) as MutationResult
  if (!result.ok) throw new Error(`insert_blocks failed: ${result.message}`)
  return result.blocks[0].blockId
}

export function readBlock(session: DocumentSession, blockId: string): BlockView {
  const result = session.call('get_blocks', { blockIds: [blockId] }) as { blocks: BlockView[] }
  return result.blocks[0]
}

export function textOf(session: DocumentSession, blockId: string): string {
  return readBlock(session, blockId).text
}

export function expectOk(result: unknown): asserts result is { ok: true } {
  const rec = result as { ok?: boolean; message?: string }
  if (rec.ok !== true) throw new Error(`expected ok, got: ${JSON.stringify(result)}`)
}
