import { MAX_FRAME_BYTES } from './protocol'

/** Length-prefixed frames on a byte stream: [u32le length][u8 tag][payload]. */

export type StreamTag =
  | 'snapshot'
  | 'update'
  | 'ephemeral'
  | 'hello'
  | 'auth'
  | 'auth-ok'
  | 'error'
  | 'control'
  | 'resume'
  | 'asset-request'
  | 'asset'

export type StreamFrame = { tag: StreamTag; payload: Uint8Array }

const TAG_TO_BYTE: Record<StreamTag, number> = {
  snapshot: 0,
  update: 1,
  ephemeral: 2,
  hello: 10,
  auth: 11,
  'auth-ok': 12,
  error: 13,
  control: 14,
  resume: 15,
  'asset-request': 16,
  asset: 17
}

const BYTE_TO_TAG: Record<number, StreamTag> = Object.fromEntries(
  Object.entries(TAG_TO_BYTE).map(([tag, byte]) => [byte, tag as StreamTag])
) as Record<number, StreamTag>

export function encodeStreamFrame(tag: StreamTag, payload: Uint8Array): Uint8Array {
  const length = 1 + payload.byteLength
  if (length > MAX_FRAME_BYTES) {
    throw new Error(`Stream frame of ${length} bytes exceeds ${MAX_FRAME_BYTES}.`)
  }
  const out = new Uint8Array(4 + length)
  const view = new DataView(out.buffer)
  view.setUint32(0, length, true)
  out[4] = TAG_TO_BYTE[tag]
  out.set(payload, 5)
  return out
}

export function encodeJsonFrame(tag: StreamTag, value: unknown): Uint8Array {
  return encodeStreamFrame(tag, new TextEncoder().encode(JSON.stringify(value)))
}

export function decodeJsonPayload(payload: Uint8Array): unknown {
  return JSON.parse(new TextDecoder().decode(payload)) as unknown
}

export class StreamReader {
  private buffer = new Uint8Array(0)

  push(chunk: Uint8Array): StreamFrame[] {
    const next = new Uint8Array(this.buffer.byteLength + chunk.byteLength)
    next.set(this.buffer)
    next.set(chunk, this.buffer.byteLength)
    this.buffer = next
    const frames: StreamFrame[] = []
    while (this.buffer.byteLength >= 4) {
      const length = new DataView(
        this.buffer.buffer,
        this.buffer.byteOffset,
        this.buffer.byteLength
      ).getUint32(0, true)
      if (length < 1 || length > MAX_FRAME_BYTES) {
        throw new Error('oversized')
      }
      if (this.buffer.byteLength < 4 + length) break
      const body = this.buffer.subarray(4, 4 + length)
      const tag = BYTE_TO_TAG[body[0]]
      if (!tag) throw new Error(`unknown-tag:${body[0]}`)
      frames.push({ tag, payload: body.slice(1) })
      this.buffer = this.buffer.subarray(4 + length)
    }
    return frames
  }
}
