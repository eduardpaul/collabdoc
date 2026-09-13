import { describe, expect, it } from 'vitest'
import { decodeDocFrame, encodeDocFrame, FrameError, MAX_FRAME_BYTES } from './protocol'

describe('document frames', () => {
  it('round-trips every kind with a one-byte tag', () => {
    const bytes = new Uint8Array([9, 8, 7])
    for (const [kind, tag] of [
      ['snapshot', 0],
      ['update', 1],
      ['ephemeral', 2]
    ] as const) {
      const frame = encodeDocFrame(kind, bytes)
      expect(frame[0]).toBe(tag)
      expect(frame.byteLength).toBe(4)
      const decoded = decodeDocFrame(frame)
      expect(decoded.kind).toBe(kind)
      expect([...decoded.bytes]).toEqual([9, 8, 7])
      // The payload is a copy, not a view into the frame.
      decoded.bytes[0] = 0
      expect(frame[1]).toBe(9)
    }
  })

  it('accepts ArrayBuffers and offset views', () => {
    const frame = encodeDocFrame('update', new Uint8Array([1, 2]))
    expect(decodeDocFrame(frame.buffer.slice(0)).kind).toBe('update')
    const padded = new Uint8Array([99, ...frame])
    expect([...decodeDocFrame(padded.subarray(1)).bytes]).toEqual([1, 2])
  })

  it('rejects empty, unknown-tag, oversized and non-byte input with a reason', () => {
    const reason = (input: unknown): string => {
      try {
        decodeDocFrame(input)
      } catch (error) {
        return error instanceof FrameError ? error.reason : 'not-frame-error'
      }
      return 'accepted'
    }
    expect(reason(new Uint8Array())).toBe('empty')
    expect(reason(new Uint8Array([3, 1]))).toBe('unknown-tag')
    expect(reason(new Uint8Array([255]))).toBe('unknown-tag')
    expect(reason('snapshot')).toBe('not-bytes')
    expect(reason(null)).toBe('not-bytes')
    expect(reason({ kind: 'update' })).toBe('not-bytes')
    expect(reason(new Uint8Array(MAX_FRAME_BYTES + 1))).toBe('too-large')
    expect(() => encodeDocFrame('update', new Uint8Array(MAX_FRAME_BYTES))).toThrow(FrameError)
  })
})
