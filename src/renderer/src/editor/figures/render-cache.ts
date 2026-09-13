const cache = new Map<string, string>()
const inflight = new Map<string, Promise<string>>()
const paintCounts = new Map<string, number>()

export function renderCacheKey(type: string, source: string, width: number | null): string {
  return `${type}\0${width ?? 100}\0${source}`
}

export function paintCount(key: string): number {
  return paintCounts.get(key) ?? 0
}

export function resetRenderCache(): void {
  cache.clear()
  inflight.clear()
  paintCounts.clear()
}

export async function cachedRender(
  key: string,
  paint: (el: HTMLElement) => Promise<void>,
  signal: AbortSignal
): Promise<string> {
  const hit = cache.get(key)
  if (hit !== undefined) {
    if (signal.aborted) {
      throw abortError()
    }
    return hit
  }
  let pending = inflight.get(key)
  if (!pending) {
    pending = (async () => {
      const el = document.createElement('div')
      paintCounts.set(key, (paintCounts.get(key) ?? 0) + 1)
      await paint(el)
      const html = el.innerHTML
      cache.set(key, html)
      inflight.delete(key)
      return html
    })().catch((error: unknown) => {
      inflight.delete(key)
      throw error
    })
    inflight.set(key, pending)
  }
  const html = await pending
  if (signal.aborted) {
    throw abortError()
  }
  return html
}

function abortError(): DOMException {
  return new DOMException('aborted', 'AbortError')
}
