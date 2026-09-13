import { mkdir, readFile, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { handleFromName, isValidHandle } from '../shared/handles'
import { USER_COLORS } from '../shared/actors'

export type StoredProfile = {
  userId: string
  name: string
  handle: string
  color: string
  setupComplete: boolean
}

export function profilePath(userData: string): string {
  return join(userData, 'profile.json')
}

export function defaultProfile(): StoredProfile {
  return {
    userId: crypto.randomUUID(),
    name: 'You',
    handle: 'you',
    color: USER_COLORS[0],
    setupComplete: false
  }
}

export function sanitizeProfile(raw: unknown): StoredProfile {
  const fallback = defaultProfile()
  if (!raw || typeof raw !== 'object') return fallback
  const rec = raw as Record<string, unknown>
  const name =
    typeof rec.name === 'string' && rec.name.trim() ? rec.name.trim().slice(0, 40) : fallback.name
  const handleRaw = typeof rec.handle === 'string' ? rec.handle : handleFromName(name)
  return {
    userId: typeof rec.userId === 'string' && rec.userId ? rec.userId : fallback.userId,
    name,
    handle: isValidHandle(handleRaw) ? handleRaw : handleFromName(name),
    color: typeof rec.color === 'string' && rec.color.startsWith('#') ? rec.color : fallback.color,
    setupComplete: rec.setupComplete === true
  }
}

export async function readProfile(userData: string): Promise<StoredProfile> {
  try {
    const raw = JSON.parse(await readFile(profilePath(userData), 'utf8')) as unknown
    return sanitizeProfile(raw)
  } catch {
    const created = defaultProfile()
    await writeProfile(userData, created)
    return created
  }
}

export async function writeProfile(
  userData: string,
  profile: StoredProfile
): Promise<StoredProfile> {
  const next = sanitizeProfile({ ...profile, setupComplete: true })
  const file = profilePath(userData)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(next, null, 2), 'utf8')
  return next
}
