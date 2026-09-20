export type NativeImageType = 'png' | 'jpg' | 'gif' | 'bmp'

/** Formats Word embeds as-is; anything else (SVG, WebP, …) arrives as a rendered PNG. */
export function nativeImageType(mime: string): NativeImageType | null {
  if (mime.includes('png')) return 'png'
  if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg'
  if (mime.includes('gif')) return 'gif'
  if (mime.includes('bmp')) return 'bmp'
  return null
}

export type ImageSize = { width: number; height: number }

/** Pixel size from the file header of a PNG, JPEG, GIF or BMP; null when unreadable. */
export function imageSize(bytes: Uint8Array, type: NativeImageType): ImageSize | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  switch (type) {
    case 'png':
      return pngSize(bytes, view)
    case 'gif':
      return gifSize(bytes, view)
    case 'bmp':
      return bmpSize(bytes, view)
    case 'jpg':
      return jpegSize(bytes, view)
    default:
      return null
  }
}

function valid(size: ImageSize): ImageSize | null {
  return size.width > 0 && size.height > 0 ? size : null
}

function pngSize(bytes: Uint8Array, view: DataView): ImageSize | null {
  // 8-byte signature, then the IHDR chunk: length(4) 'IHDR'(4) width(4) height(4).
  if (bytes.length < 24 || bytes[0] !== 0x89 || bytes[1] !== 0x50) return null
  return valid({ width: view.getUint32(16), height: view.getUint32(20) })
}

function gifSize(bytes: Uint8Array, view: DataView): ImageSize | null {
  if (bytes.length < 10 || bytes[0] !== 0x47 || bytes[1] !== 0x49) return null
  return valid({ width: view.getUint16(6, true), height: view.getUint16(8, true) })
}

function bmpSize(bytes: Uint8Array, view: DataView): ImageSize | null {
  if (bytes.length < 26 || bytes[0] !== 0x42 || bytes[1] !== 0x4d) return null
  // BITMAPINFOHEADER: height may be negative for top-down bitmaps.
  return valid({ width: view.getInt32(18, true), height: Math.abs(view.getInt32(22, true)) })
}

function jpegSize(bytes: Uint8Array, view: DataView): ImageSize | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null
  let offset = 2
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1
      continue
    }
    const marker = bytes[offset + 1]
    if (marker === 0xff) {
      offset += 1
      continue
    }
    // Start-of-frame markers (except DHT/JPG/DAC) carry height then width.
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isSof) {
      return valid({ width: view.getUint16(offset + 7), height: view.getUint16(offset + 5) })
    }
    if (marker === 0xd9 || marker === 0xda) return null
    offset += 2 + view.getUint16(offset + 2)
  }
  return null
}
