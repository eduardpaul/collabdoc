import { LoroDoc, LoroMap } from 'loro-crdt'
import { CHECKPOINTS_KEY } from '../shared/constants'
import { commitBoundary } from './document'
import type { Frontier } from './history'

export type Checkpoint = {
  id: string
  name: string
  frontiers: Frontier[]
  actorId: string
  at: number
}

export function addCheckpoint(
  doc: LoroDoc,
  input: { name: string; actorId: string; frontiers?: Frontier[] }
): Checkpoint {
  const name = input.name.trim() || 'Checkpoint'
  const frontiers = input.frontiers ?? (doc.frontiers() as Frontier[])
  const at = Date.now()
  const id = `cp_${at.toString(36)}`
  const list = doc.getList(CHECKPOINTS_KEY)
  const row = list.insertContainer(list.length, new LoroMap())
  row.set('id', id)
  row.set('name', name)
  row.set('actorId', input.actorId)
  row.set('at', at)
  row.set('frontiers', JSON.stringify(frontiers))
  commitBoundary(doc, {
    origin: `actor:${input.actorId}`,
    message: `checkpoint: ${name}`,
    timestamp: at
  })
  return { id, name, frontiers, actorId: input.actorId, at }
}

export function listCheckpoints(doc: LoroDoc): Checkpoint[] {
  const list = doc.getList(CHECKPOINTS_KEY)
  const out: Checkpoint[] = []
  for (let i = 0; i < list.length; i += 1) {
    const row = list.get(i)
    if (!(row instanceof LoroMap)) continue
    const parsed = asCheckpoint(row)
    if (parsed) out.push(parsed)
  }
  return out.sort((a, b) => b.at - a.at)
}

function asCheckpoint(row: LoroMap): Checkpoint | null {
  const id = row.get('id')
  const name = row.get('name')
  const actorId = row.get('actorId')
  const at = row.get('at')
  const raw = row.get('frontiers')
  if (typeof id !== 'string' || typeof name !== 'string' || typeof actorId !== 'string') {
    return null
  }
  if (typeof at !== 'number' || typeof raw !== 'string') return null
  let frontiers: Frontier[] = []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return null
    frontiers = parsed.filter(isFrontier)
  } catch {
    return null
  }
  return { id, name, frontiers, actorId, at }
}

function isFrontier(value: unknown): value is Frontier {
  if (!value || typeof value !== 'object') return false
  const rec = value as Record<string, unknown>
  return typeof rec.peer === 'string' && typeof rec.counter === 'number'
}
