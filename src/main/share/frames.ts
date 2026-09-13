import {
  encodeJsonFrame,
  encodeStreamFrame,
  StreamReader,
  type StreamFrame,
  type StreamTag
} from '../../shared/stream-frames'
import { SHARE_AUTH_TIMEOUT_MS } from '../../shared/constants'
import { ShareProtocolError, type ShareErrorCode } from './errors'
import type { PeerConnection } from './transport'

export class FramePump {
  private readonly queue: StreamFrame[] = []
  private waiter: ((frame: StreamFrame) => void) | null = null
  private readonly listeners: Array<(frame: StreamFrame) => void> = []
  closed = false

  constructor(private readonly conn: PeerConnection) {
    const reader = new StreamReader()
    conn.onData((chunk) => {
      try {
        for (const frame of reader.push(chunk)) this.push(frame)
      } catch {
        conn.destroy()
      }
    })
    conn.onClose(() => {
      this.closed = true
    })
  }

  send(tag: StreamTag, payload: Uint8Array | unknown): boolean {
    const bytes =
      payload instanceof Uint8Array
        ? encodeStreamFrame(tag, payload)
        : encodeJsonFrame(tag, payload)
    return this.conn.write(bytes)
  }

  onFrame(listener: (frame: StreamFrame) => void): void {
    this.listeners.push(listener)
    while (this.queue.length) listener(this.queue.shift()!)
  }

  next(timeoutMs = SHARE_AUTH_TIMEOUT_MS): Promise<StreamFrame> {
    if (this.queue.length) return Promise.resolve(this.queue.shift()!)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.waiter) {
          this.waiter = null
          reject(new ShareProtocolError('timeout', 'The peer did not finish verifying in time.'))
        }
      }, timeoutMs)
      this.waiter = (frame) => {
        clearTimeout(timer)
        resolve(frame)
      }
    })
  }

  private push(frame: StreamFrame): void {
    if (this.waiter) {
      const wait = this.waiter
      this.waiter = null
      wait(frame)
      return
    }
    if (this.listeners.length) {
      for (const listener of this.listeners) listener(frame)
      return
    }
    this.queue.push(frame)
  }
}

export function errorPayload(
  code: ShareErrorCode,
  message: string
): { code: ShareErrorCode; message: string } {
  return { code, message }
}
