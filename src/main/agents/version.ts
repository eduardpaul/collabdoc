/** `1.2.3` from any text that contains one; null when there is none. */
export function parseVersion(text: string): string | null {
  // First run of digits and dots with at least one dot, e.g. "grok 1.0.30 (abc)" → "1.0.30".
  for (const token of text.split(/[^0-9.]+/)) {
    const parts = token.split('.').filter((part) => part.length > 0)
    if (
      parts.length >= 2 &&
      token.includes('.') &&
      /^\d+$/.test(parts[0]) &&
      /^\d+$/.test(parts[1])
    ) {
      const patch = parts[2] && /^\d+$/.test(parts[2]) ? parts[2] : '0'
      return `${parts[0]}.${parts[1]}.${patch}`
    }
  }
  return null
}

/** Negative when `a` is older than `b`. Missing parts count as 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0)
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}
