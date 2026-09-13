import { mkdir, readFile, writeFile } from 'fs/promises'
import { dirname } from 'path'

export const RECENTS_LIMIT = 50
export const RECENTS_ENTRY_MAX_BYTES = 1024

export type RecentRecord = {
  docId: string
  title: string
  path: string | null
  updatedAt: string
  preview: string
}

export type RecentListing = RecentRecord & { missing?: boolean }

type RecentsFile = { recents: RecentRecord[] }

export function capRecent(entry: RecentRecord): RecentRecord {
  const next: RecentRecord = {
    docId: entry.docId,
    title: entry.title.slice(0, 200),
    path: entry.path,
    updatedAt: entry.updatedAt,
    preview: entry.preview.slice(0, 120)
  }
  let json = JSON.stringify(next)
  while (json.length > RECENTS_ENTRY_MAX_BYTES && next.preview.length > 0) {
    next.preview = next.preview.slice(0, Math.max(0, next.preview.length - 16))
    json = JSON.stringify(next)
  }
  if (json.length > RECENTS_ENTRY_MAX_BYTES && next.path && next.path.length > 80) {
    next.path = `…${next.path.slice(-(RECENTS_ENTRY_MAX_BYTES - json.length + next.path.length - 1))}`
  }
  return next
}

export function upsertRecent(recents: RecentRecord[], entry: RecentRecord): RecentRecord[] {
  const capped = capRecent(entry)
  const rest = recents.filter(
    (item) => item.docId !== capped.docId && (!capped.path || item.path !== capped.path)
  )
  return [capped, ...rest]
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
    .slice(0, RECENTS_LIMIT)
}

export async function loadRecentsFile(filePath: string): Promise<RecentRecord[]> {
  try {
    const raw = await readFile(filePath, 'utf8')
    const parsed = JSON.parse(raw) as RecentsFile
    if (!parsed || !Array.isArray(parsed.recents)) return []
    return parsed.recents.filter(isRecentRecord).map(capRecent)
  } catch {
    return []
  }
}

export async function saveRecentsFile(filePath: string, recents: RecentRecord[]): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  const payload: RecentsFile = { recents: recents.slice(0, RECENTS_LIMIT).map(capRecent) }
  await writeFile(filePath, JSON.stringify(payload, null, 2), 'utf8')
}

function isRecentRecord(value: unknown): value is RecentRecord {
  if (!value || typeof value !== 'object') return false
  const rec = value as Record<string, unknown>
  return (
    typeof rec.docId === 'string' &&
    typeof rec.title === 'string' &&
    typeof rec.updatedAt === 'string'
  )
}
