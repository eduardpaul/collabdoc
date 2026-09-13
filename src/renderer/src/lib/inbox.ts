import { INBOX_STORAGE_KEY } from '@shared/constants'
import type { InboxEntry } from '@shared/types'

/**
 * The person's inbox lives with main (`userData/inbox/<userId>.json`). With
 * no main process — plain Vite, Playwright — localStorage plays the same
 * role so the flows are identical. Per install, never synced.
 */
export type InboxStore = {
  list(userId: string): Promise<InboxEntry[]>
  add(userId: string, entries: InboxEntry[]): Promise<{ entries: InboxEntry[]; added: number }>
  markRead(userId: string, ids: string[] | 'all'): Promise<InboxEntry[]>
}

export function inboxStore(): InboxStore {
  const api = window.api?.inbox
  return api ? ipcStore(api) : localStore()
}

function ipcStore(api: NonNullable<NonNullable<Window['api']>['inbox']>): InboxStore {
  return {
    async list(userId) {
      const result = await api.list(userId)
      return result.ok ? result.entries : []
    },
    async add(userId, entries) {
      const result = await api.add({ userId, entries })
      return result.ok
        ? { entries: result.entries, added: result.added }
        : { entries: [], added: 0 }
    },
    async markRead(userId, ids) {
      const result = await api.markRead({ userId, ids })
      return result.ok ? result.entries : []
    }
  }
}

function localStore(): InboxStore {
  const key = (userId: string): string => `${INBOX_STORAGE_KEY}.${userId}`
  const read = (userId: string): InboxEntry[] => {
    try {
      const raw = localStorage.getItem(key(userId))
      const parsed = raw ? (JSON.parse(raw) as unknown) : []
      return Array.isArray(parsed) ? (parsed as InboxEntry[]) : []
    } catch {
      return []
    }
  }
  const write = (userId: string, entries: InboxEntry[]): void => {
    try {
      localStorage.setItem(key(userId), JSON.stringify(entries))
    } catch {
      /* storage unavailable: the inbox is a convenience here */
    }
  }
  return {
    async list(userId) {
      return read(userId)
    },
    async add(userId, entries) {
      const existing = read(userId)
      const known = new Set(existing.map((e) => e.id))
      const fresh = entries.filter((e) => !known.has(e.id))
      if (fresh.length === 0) return { entries: existing, added: 0 }
      const next = [...existing, ...fresh].sort((a, b) => b.at - a.at)
      write(userId, next)
      return { entries: next, added: fresh.length }
    },
    async markRead(userId, ids) {
      const wanted = ids === 'all' ? null : new Set(ids)
      const next = read(userId).map((e) =>
        e.read || (wanted && !wanted.has(e.id)) ? e : { ...e, read: true }
      )
      write(userId, next)
      return next
    }
  }
}
