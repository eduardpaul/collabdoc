import type { FrameLink } from './link'

/**
 * Two ends of an in-memory channel with the `FrameLink` shape. Delivery is
 * synchronous, which keeps tests deterministic; a real MessagePort is async.
 */
export function memoryLinkPair(): [FrameLink, FrameLink] {
  const listeners: Array<{ message: Array<(data: unknown) => void>; close: Array<() => void> }> = [
    { message: [], close: [] },
    { message: [], close: [] }
  ]
  let closed = false
  const make = (mine: 0 | 1): FrameLink => {
    const other = mine === 0 ? 1 : 0
    return {
      send(frame) {
        if (closed) return
        for (const listener of listeners[other].message) listener(frame)
      },
      onMessage(listener) {
        listeners[mine].message.push(listener)
      },
      onClose(listener) {
        listeners[mine].close.push(listener)
      },
      close() {
        if (closed) return
        closed = true
        for (const side of listeners) for (const listener of side.close) listener()
      }
    }
  }
  return [make(0), make(1)]
}
