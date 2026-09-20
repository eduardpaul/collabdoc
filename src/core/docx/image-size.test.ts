// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { imageSize, nativeImageType } from './image-size'

function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82])
  new DataView(bytes.buffer).setUint32(16, width)
  new DataView(bytes.buffer).setUint32(20, height)
  return bytes
}

function gif(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(10)
  bytes.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
  new DataView(bytes.buffer).setUint16(6, width, true)
  new DataView(bytes.buffer).setUint16(8, height, true)
  return bytes
}

function bmp(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(26)
  bytes.set([0x42, 0x4d])
  new DataView(bytes.buffer).setInt32(18, width, true)
  new DataView(bytes.buffer).setInt32(22, height, true)
  return bytes
}

function jpeg(width: number, height: number): Uint8Array {
  // SOI, an APP0 segment to skip, then SOF0 with height/width.
  const app0 = [0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46]
  const sof = [0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff]
  return Uint8Array.from([0xff, 0xd8, ...app0, ...sof, ...new Array(12).fill(0)])
}

describe('imageSize', () => {
  it('reads PNG, GIF, BMP and JPEG headers', () => {
    expect(imageSize(png(640, 480), 'png')).toEqual({ width: 640, height: 480 })
    expect(imageSize(gif(32, 16), 'gif')).toEqual({ width: 32, height: 16 })
    expect(imageSize(bmp(100, -50), 'bmp')).toEqual({ width: 100, height: 50 })
    expect(imageSize(jpeg(1200, 800), 'jpg')).toEqual({ width: 1200, height: 800 })
  })

  it('returns null for truncated or foreign bytes', () => {
    expect(imageSize(new Uint8Array([0x89, 0x50]), 'png')).toBeNull()
    expect(imageSize(gif(10, 10), 'png')).toBeNull()
    expect(imageSize(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), 'jpg')).toBeNull()
  })
})

describe('nativeImageType', () => {
  it('maps only formats Word embeds directly', () => {
    expect(nativeImageType('image/png')).toBe('png')
    expect(nativeImageType('image/jpeg')).toBe('jpg')
    expect(nativeImageType('image/gif')).toBe('gif')
    expect(nativeImageType('image/bmp')).toBe('bmp')
    expect(nativeImageType('image/webp')).toBeNull()
    expect(nativeImageType('image/svg+xml')).toBeNull()
  })
})
