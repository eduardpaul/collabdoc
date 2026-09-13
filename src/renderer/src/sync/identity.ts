import type { ActorProfile } from '@shared/types'

const KEY = 'collabdoc.identity'

const COLORS = ['#c45c26', '#1f8a70', '#2563eb', '#7c3aed', '#db2777', '#d97706']

/**
 * Who this install is, for attribution and presence. 07 moves this into a
 * profile in `userData` with a name and handle the user can edit; until then
 * the id is stable per browser profile and the name is "You".
 */
export function localProfile(): ActorProfile {
  let stored: { userId?: string; color?: string } | null = null
  try {
    stored = JSON.parse(localStorage.getItem(KEY) ?? 'null')
  } catch {
    stored = null
  }
  if (!stored?.userId) {
    const colorIndex = crypto.getRandomValues(new Uint32Array(1))[0] % COLORS.length
    stored = {
      userId: crypto.randomUUID(),
      color: COLORS[colorIndex]
    }
    try {
      localStorage.setItem(KEY, JSON.stringify(stored))
    } catch {
      /* private mode: identity is per session, which is fine */
    }
  }
  return {
    actorId: stored.userId as string,
    name: 'You',
    color: stored.color ?? COLORS[0],
    role: 'human'
  }
}
