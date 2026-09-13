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
