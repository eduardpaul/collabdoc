import { mkdir, readFile, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import type { InboxEntry } from '../shared/types'

/**
 * A person's inbox: mention requests addressed to them, one file per user
 * on this install (`userData/inbox/<userId>.json`). Never synced — a guest
 * keeps their own, fed by scanning the document they rejoin.
 */
export const INBOX_LIMIT = 500

export function inboxPath(userData: string, userId: string): string {
  const safe = userId.replace(/[^a-zA-Z0-9_-]/g, '_')
  return join(userData, 'inbox', `${safe}.json`)
}

export async function readInbox(userData: string, userId: string): Promise<InboxEntry[]> {
  try {
    const raw = JSON.parse(await readFile(inboxPath(userData, userId), 'utf8')) as unknown
    const entries = (raw as { entries?: unknown }).entries
    return Array.isArray(entries) ? entries.filter(isEntry) : []
  } catch {
    return []
  }
}

async function writeInbox(userData: string, userId: string, entries: InboxEntry[]): Promise<void> {
  const path = inboxPath(userData, userId)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify({ entries }, null, 2), 'utf8')
}

/** Add what is new. Dedupes by request id, so a rescan or a reload adds nothing twice. */
export function mergeInbox(existing: InboxEntry[], incoming: InboxEntry[]): InboxEntry[] {
  const known = new Set(existing.map((e) => e.id))
  const fresh = incoming.filter((e) => isEntry(e) && !known.has(e.id))
  if (fresh.length === 0) return existing
  return [...existing, ...fresh].sort((a, b) => b.at - a.at).slice(0, INBOX_LIMIT)
}

export function markInboxRead(entries: InboxEntry[], ids: string[] | 'all'): InboxEntry[] {
  const wanted = ids === 'all' ? null : new Set(ids)
  return entries.map((e) => (e.read || (wanted && !wanted.has(e.id)) ? e : { ...e, read: true }))
}

export async function addToInbox(
  userData: string,
  userId: string,
  incoming: InboxEntry[]
): Promise<{ entries: InboxEntry[]; added: number }> {
  const existing = await readInbox(userData, userId)
  const merged = mergeInbox(existing, incoming)
  if (merged !== existing) await writeInbox(userData, userId, merged)
  return { entries: merged, added: merged.length - existing.length }
}

export async function setInboxRead(
  userData: string,
  userId: string,
  ids: string[] | 'all'
): Promise<InboxEntry[]> {
  const entries = markInboxRead(await readInbox(userData, userId), ids)
  await writeInbox(userData, userId, entries)
  return entries
}

function isEntry(value: unknown): value is InboxEntry {
  if (!value || typeof value !== 'object') return false
  const rec = value as Record<string, unknown>
  return (
    typeof rec.id === 'string' &&
    typeof rec.docId === 'string' &&
    typeof rec.text === 'string' &&
    typeof rec.at === 'number' &&
    !!rec.from &&
    typeof rec.from === 'object'
  )
}
