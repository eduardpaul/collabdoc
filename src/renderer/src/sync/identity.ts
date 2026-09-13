import { USER_COLORS } from '@shared/actors'
import { handleFromName, isValidHandle } from '@shared/handles'
import type { ActorProfile } from '@shared/types'

const LEGACY_KEY = 'collabdoc.identity'
const CACHE_KEY = 'collabdoc.profile'

export type UserProfile = {
  userId: string
  name: string
  handle: string
  color: string
  setupComplete: boolean
}

export function emptyProfile(): UserProfile {
  return {
    userId: crypto.randomUUID(),
    name: 'You',
    handle: 'you',
    color: USER_COLORS[crypto.getRandomValues(new Uint32Array(1))[0] % USER_COLORS.length],
    setupComplete: false
  }
}

export function asActorProfile(profile: UserProfile): ActorProfile {
  return {
    actorId: profile.userId,
    name: profile.name.trim() || 'You',
    handle: profile.handle,
    color: profile.color,
    role: 'human'
  }
}

export function sanitizeUserProfile(raw: unknown): UserProfile {
  const fallback = emptyProfile()
  if (!raw || typeof raw !== 'object') return fallback
  const rec = raw as Record<string, unknown>
  const name =
    typeof rec.name === 'string' && rec.name.trim() ? rec.name.trim().slice(0, 40) : fallback.name
  const handleRaw = typeof rec.handle === 'string' ? rec.handle.toLowerCase() : handleFromName(name)
  return {
    userId: typeof rec.userId === 'string' && rec.userId ? rec.userId : fallback.userId,
    name,
    handle: isValidHandle(handleRaw) ? handleRaw : handleFromName(name),
    color: typeof rec.color === 'string' && rec.color.startsWith('#') ? rec.color : fallback.color,
    setupComplete: rec.setupComplete === true
  }
}

function readCache(): UserProfile | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (raw) return sanitizeUserProfile(JSON.parse(raw))
  } catch {
    /* ignore */
  }
  try {
    const legacy = JSON.parse(localStorage.getItem(LEGACY_KEY) ?? 'null') as {
      userId?: string
      color?: string
    } | null
    if (legacy?.userId) {
      return sanitizeUserProfile({
        userId: legacy.userId,
        color: legacy.color,
        name: 'You',
        handle: 'you',
        setupComplete: false
      })
    }
  } catch {
    /* ignore */
  }
  return null
}

function writeCache(profile: UserProfile): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(profile))
    localStorage.removeItem(LEGACY_KEY)
  } catch {
    /* private mode */
  }
}

export function loadProfileSync(): UserProfile {
  return readCache() ?? emptyProfile()
}

export async function loadProfile(): Promise<UserProfile> {
  const remote = await window.api?.profile?.get?.()
  if (remote && 'ok' in remote && remote.ok) {
    const profile = sanitizeUserProfile(remote.profile)
    writeCache(profile)
    return profile
  }
  const cached = readCache()
  if (cached) return cached
  const created = emptyProfile()
  writeCache(created)
  return created
}

export async function saveProfile(profile: UserProfile): Promise<UserProfile> {
  const next = sanitizeUserProfile({ ...profile, setupComplete: true })
  writeCache(next)
  const remote = await window.api?.profile?.save?.(next)
  if (remote && 'ok' in remote && remote.ok) return sanitizeUserProfile(remote.profile)
  return next
}
