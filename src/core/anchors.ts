import { Cursor } from 'loro-crdt'
import { base64ToBytes, bytesToBase64 } from '../shared/base64'
import type { Anchor } from '../shared/types'

export function encodeAnchor(cursor: Cursor): Anchor {
  return bytesToBase64(cursor.encode())
}

export function decodeAnchor(anchor: Anchor): Cursor {
  return Cursor.decode(base64ToBytes(anchor))
}
