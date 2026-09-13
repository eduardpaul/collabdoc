export function isSafeHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

export function openExternalUrl(url: string): void {
  if (!isSafeHttpUrl(url)) {
    return
  }
  if (window.api?.shell?.openExternal) {
    void window.api.shell.openExternal(url)
    return
  }
  window.open(url, '_blank', 'noopener,noreferrer')
}

export function hrefFromClickTarget(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) {
    return null
  }
  const anchor = target.closest('a')
  if (!anchor) {
    return null
  }
  const raw = anchor.getAttribute('href') ?? anchor.href
  return raw || null
}
