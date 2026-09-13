/** `@handle` rules shared by identity (07), mentions (10) and comments (09). */

export const HANDLE_PATTERN = /^[a-z0-9_-]{2,20}$/

export function normalizeHandle(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^@+/, '')
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9_-]/g, '')
    .slice(0, 20)
}

export function isValidHandle(handle: string): boolean {
  return HANDLE_PATTERN.test(handle)
}

/** A valid handle derived from a display name; falls back to `you`. */
export function handleFromName(name: string): string {
  const normalized = normalizeHandle(name)
  if (isValidHandle(normalized)) return normalized
  const padded = `${normalized}user`.slice(0, 20)
  return isValidHandle(padded) ? padded : 'you'
}

/**
 * Give every person a unique handle. Input order is the collision order:
 * the first occupant keeps the preferred handle, later ones get `-2`, `-3`.
 * Sort by `id` before calling so every peer assigns the same suffixes.
 */
export function assignHandles(
  people: ReadonlyArray<{ id: string; name: string; handle?: string }>
): Map<string, string> {
  const taken = new Set<string>()
  const assigned = new Map<string, string>()
  for (const person of people) {
    const preferred =
      person.handle && isValidHandle(person.handle) ? person.handle : handleFromName(person.name)
    const handle = uniquifyHandle(preferred, taken)
    taken.add(handle)
    assigned.set(person.id, handle)
  }
  return assigned
}

export function uniquifyHandle(preferred: string, taken: Set<string>): string {
  const base = isValidHandle(preferred) ? preferred : handleFromName(preferred)
  if (!taken.has(base)) return base
  for (let n = 2; n < 1000; n += 1) {
    const suffix = `-${n}`
    const next = `${base.slice(0, 20 - suffix.length)}${suffix}`
    if (!taken.has(next)) return next
  }
  return `${base.slice(0, 16)}-x`
}

/** Handles mentioned in free text, lower-cased, without the `@`, in order. */
export function mentionedHandles(text: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const match of text.matchAll(/(^|[^a-zA-Z0-9_-])@([a-zA-Z0-9_-]{2,20})(?![a-zA-Z0-9_-])/g)) {
    const handle = match[2].toLowerCase()
    if (!seen.has(handle)) {
      seen.add(handle)
      out.push(handle)
    }
  }
  return out
}
