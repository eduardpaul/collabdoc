/**
 * Document frames between a hub and its subscribers (renderer over a
 * MessagePort, peers over a Hyperswarm stream in 08).
 *
 * Document bytes never travel as JSON: a Loro update is binary, and JSON has
 * no way to carry bytes short of an array of numbers — roughly four characters
 * per byte, so a 2 MB image becomes a ~10 MB message to every client. One tag
 * byte, then the Loro payload verbatim.
 */

export type DocFrameKind = 'snapshot' | 'update' | 'ephemeral'

export type DocFrame = { kind: DocFrameKind; bytes: Uint8Array }

const FRAME_TAGS: Record<DocFrameKind, number> = { snapshot: 0, update: 1, ephemeral: 2 }
const FRAME_KINDS: readonly DocFrameKind[] = ['snapshot', 'update', 'ephemeral']

/** Larger than any document we intend to sync in one piece; see 04/08. */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024

export class FrameError extends Error {
  constructor(
    message: string,
    readonly reason: 'empty' | 'unknown-tag' | 'too-large' | 'not-bytes'
  ) {
    super(message)
    this.name = 'FrameError'
  }
}

export function encodeDocFrame(kind: DocFrameKind, bytes: Uint8Array): Uint8Array {
  if (bytes.byteLength + 1 > MAX_FRAME_BYTES) {
    throw new FrameError(
      `Frame of ${bytes.byteLength} bytes exceeds ${MAX_FRAME_BYTES}.`,
      'too-large'
    )
  }
  const frame = new Uint8Array(bytes.byteLength + 1)
  frame[0] = FRAME_TAGS[kind]
  frame.set(bytes, 1)
  return frame
}

/**
 * Throws `FrameError` for anything that is not a frame this build understands.
 * The payload is copied: Loro keeps the buffer it is handed, and transports
 * hand out slices of pooled ones.
 */
export function decodeDocFrame(data: unknown): DocFrame {
  let view: Uint8Array
  if (data instanceof ArrayBuffer) {
    view = new Uint8Array(data)
  } else if (ArrayBuffer.isView(data)) {
    view = new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  } else {
    throw new FrameError('Frame is not a byte buffer.', 'not-bytes')
  }
  if (view.byteLength > MAX_FRAME_BYTES) {
    throw new FrameError(
      `Frame of ${view.byteLength} bytes exceeds ${MAX_FRAME_BYTES}.`,
      'too-large'
    )
  }
  if (view.byteLength < 1) throw new FrameError('Empty frame.', 'empty')
  const kind = FRAME_KINDS[view[0]]
  if (!kind) throw new FrameError(`Unknown frame tag ${view[0]}.`, 'unknown-tag')
  return { kind, bytes: view.slice(1) }
}
