import { encodeDocFrame, type DocFrameKind } from '../../shared/protocol'
import { SHARE_SLOW_BUFFER_BYTES, SHARE_STALL_MS } from '../../shared/constants'
import type { FrameLink } from '../../core/link'
import type { StreamTag } from '../../shared/stream-frames'
import type { FramePump } from './frames'
import type { PeerConnection } from './transport'

const DOC_TAGS: DocFrameKind[] = ['snapshot', 'update', 'ephemeral']

export function pumpAsLink(pump: FramePump, conn: PeerConnection): FrameLink {
  const message: Array<(data: unknown) => void> = []
  const close: Array<() => void> = []
  let lastOk = Date.now()
  const stall = setInterval(() => {
    if (Date.now() - lastOk > SHARE_STALL_MS) conn.destroy()
  }, 1000)
  conn.onClose(() => {
    clearInterval(stall)
    for (const listener of close) listener()
  })
  pump.onFrame((frame) => {
    if (!DOC_TAGS.includes(frame.tag as DocFrameKind)) return
    lastOk = Date.now()
    const encoded = encodeDocFrame(frame.tag as DocFrameKind, frame.payload)
    for (const listener of message) listener(encoded)
  })
  return {
    send(frame) {
      const tag = DOC_TAGS[frame[0]] as StreamTag | undefined
      if (!tag) return
      if (conn.bufferedAmount > SHARE_SLOW_BUFFER_BYTES && tag === 'ephemeral') return
      const ok = pump.send(tag, frame.subarray(1))
      if (ok) lastOk = Date.now()
    },
    onMessage(listener) {
      message.push(listener)
    },
    onClose(listener) {
      close.push(listener)
    },
    close() {
      conn.destroy()
    }
  }
}
