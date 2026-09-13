import { SCHEMA_VERSION } from '../shared/constants'

/**
 * On-disk `.collabdoc` container. Pure bytes: no Loro, no Node.
 *
 *   magic (8) | header length uint32 LE | header JSON | snapshot | assets
 */

export const COLLABDOC_MAGIC = 'CLBDOC01'
export const COLLABDOC_APP = 'collabdoc/0.1.0'
export const COLLABDOC_MAGIC_BYTES = new TextEncoder().encode(COLLABDOC_MAGIC)
export const COLLABDOC_FORMAT_VERSION = 1

const MAGIC_PREFIX = 'CLBDOC'
const HEADER_OFFSET = 12

export type CollabdocAssetMeta = {
  hash: string
  type: string
  size: number
  offset: number
}

export type CollabdocHeader = {
  docId: string
  title: string
  schemaVersion: number
  savedAt: number
  app: string
  snapshotBytes: number
  assets: CollabdocAssetMeta[]
}

export type PackedAsset = {
  hash: string
  type: string
  bytes: Uint8Array
}

export type DecodeWarning = 'truncated-assets'

export type DecodedCollabdoc = {
  header: CollabdocHeader
  snapshot: Uint8Array
  assets: PackedAsset[]
  missing: string[]
  warnings: DecodeWarning[]
}

export class CollabdocError extends Error {
  constructor(
    message: string,
    readonly code: 'magic' | 'schema' | 'truncated' | 'header'
  ) {
    super(message)
    this.name = 'CollabdocError'
  }
}

export function encodeCollabdoc(input: {
  docId: string
  title: string
  schemaVersion?: number
  savedAt?: number
  app?: string
  snapshot: Uint8Array
  assets?: PackedAsset[]
}): Uint8Array {
  const packed = packAssets(input.assets ?? [])
  const header: CollabdocHeader = {
    docId: input.docId,
    title: input.title,
    schemaVersion: input.schemaVersion ?? SCHEMA_VERSION,
    savedAt: input.savedAt ?? Date.now(),
    app: input.app ?? COLLABDOC_APP,
    snapshotBytes: input.snapshot.byteLength,
    assets: packed.meta
  }
  const headerBytes = new TextEncoder().encode(JSON.stringify(header))
  const total =
    HEADER_OFFSET + headerBytes.byteLength + input.snapshot.byteLength + packed.bytes.byteLength
  const out = new Uint8Array(total)
  out.set(COLLABDOC_MAGIC_BYTES, 0)
  writeU32(out, 8, headerBytes.byteLength)
  out.set(headerBytes, HEADER_OFFSET)
  const snapAt = HEADER_OFFSET + headerBytes.byteLength
  out.set(input.snapshot, snapAt)
  out.set(packed.bytes, snapAt + input.snapshot.byteLength)
  return out
}

/** Parse only the JSON header. Does not touch the snapshot (no Loro). */
export function readCollabdocHeader(bytes: Uint8Array): CollabdocHeader {
  assertMagic(bytes)
  if (bytes.byteLength < HEADER_OFFSET) {
    throw new CollabdocError('This CollabDoc file is truncated or damaged.', 'truncated')
  }
  const headerLen = readU32(bytes, 8)
  const headerEnd = HEADER_OFFSET + headerLen
  if (headerLen < 2 || headerEnd > bytes.byteLength) {
    throw new CollabdocError('This CollabDoc file is truncated or damaged.', 'truncated')
  }
  return parseHeaderJson(bytes.subarray(HEADER_OFFSET, headerEnd))
}

export function decodeCollabdoc(bytes: Uint8Array): DecodedCollabdoc {
  const header = readCollabdocHeader(bytes)
  if (header.schemaVersion > SCHEMA_VERSION) {
    throw new CollabdocError(
      `This document uses schema version ${header.schemaVersion}, which this version of CollabDoc cannot open.`,
      'schema'
    )
  }
  const headerLen = readU32(bytes, 8)
  const snapAt = HEADER_OFFSET + headerLen
  const snapEnd = snapAt + header.snapshotBytes
  if (header.snapshotBytes < 0 || snapEnd > bytes.byteLength) {
    throw new CollabdocError('This CollabDoc file is truncated or damaged.', 'truncated')
  }
  const snapshot = bytes.subarray(snapAt, snapEnd)
  const assets: PackedAsset[] = []
  const missing: string[] = []
  const warnings: DecodeWarning[] = []
  for (const meta of header.assets) {
    const start = snapEnd + meta.offset
    const end = start + meta.size
    if (start < snapEnd || end < start || end > bytes.byteLength) {
      missing.push(meta.hash)
      if (!warnings.includes('truncated-assets')) warnings.push('truncated-assets')
      continue
    }
    assets.push({ hash: meta.hash, type: meta.type, bytes: bytes.subarray(start, end) })
  }
  return { header, snapshot, assets, missing, warnings }
}

export function isCollabdocPath(filePath: string): boolean {
  return /\.collabdoc$/i.test(filePath)
}

export function isMarkdownPath(filePath: string): boolean {
  return /\.(md|markdown|txt)$/i.test(filePath)
}

function packAssets(assets: PackedAsset[]): { meta: CollabdocAssetMeta[]; bytes: Uint8Array } {
  const seen = new Set<string>()
  const meta: CollabdocAssetMeta[] = []
  let total = 0
  for (const asset of assets) {
    if (seen.has(asset.hash)) continue
    seen.add(asset.hash)
    meta.push({ hash: asset.hash, type: asset.type, size: asset.bytes.byteLength, offset: total })
    total += asset.bytes.byteLength
  }
  const bytes = new Uint8Array(total)
  for (const item of meta) {
    const source = assets.find((asset) => asset.hash === item.hash)
    if (source) bytes.set(source.bytes, item.offset)
  }
  return { meta, bytes }
}

function assertMagic(bytes: Uint8Array): void {
  if (bytes.byteLength < 8) {
    throw new CollabdocError('This CollabDoc file is truncated or damaged.', 'truncated')
  }
  const magic = new TextDecoder().decode(bytes.subarray(0, 8))
  if (magic === COLLABDOC_MAGIC) return
  if (magic.startsWith(MAGIC_PREFIX)) {
    const version = Number.parseInt(magic.slice(MAGIC_PREFIX.length), 10)
    if (Number.isFinite(version) && version > COLLABDOC_FORMAT_VERSION) {
      throw new CollabdocError(
        `This file was saved with a newer CollabDoc format (${magic}). Update the app to open it.`,
        'magic'
      )
    }
  }
  throw new CollabdocError('This is not a CollabDoc file.', 'magic')
}

function parseHeaderJson(bytes: Uint8Array): CollabdocHeader {
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    throw new CollabdocError('This CollabDoc file has a damaged header.', 'header')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CollabdocError('This CollabDoc file has a damaged header.', 'header')
  }
  const rec = parsed as Record<string, unknown>
  const docId = rec.docId
  const title = rec.title
  const schemaVersion = rec.schemaVersion
  const savedAt = rec.savedAt
  const snapshotBytes = rec.snapshotBytes
  if (typeof docId !== 'string' || !docId) {
    throw new CollabdocError('This CollabDoc file has a damaged header.', 'header')
  }
  if (typeof schemaVersion !== 'number' || !Number.isFinite(schemaVersion)) {
    throw new CollabdocError('This CollabDoc file has a damaged header.', 'header')
  }
  if (typeof snapshotBytes !== 'number' || !Number.isFinite(snapshotBytes)) {
    throw new CollabdocError('This CollabDoc file has a damaged header.', 'header')
  }
  return {
    docId,
    title: typeof title === 'string' ? title : '',
    schemaVersion,
    savedAt: typeof savedAt === 'number' ? savedAt : 0,
    app: typeof rec.app === 'string' ? rec.app : '',
    snapshotBytes,
    assets: parseAssetMeta(rec.assets)
  }
}

function parseAssetMeta(value: unknown): CollabdocAssetMeta[] {
  if (!Array.isArray(value)) return []
  const out: CollabdocAssetMeta[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const rec = item as Record<string, unknown>
    if (
      typeof rec.hash !== 'string' ||
      typeof rec.size !== 'number' ||
      typeof rec.offset !== 'number'
    ) {
      continue
    }
    out.push({
      hash: rec.hash,
      type: typeof rec.type === 'string' ? rec.type : 'application/octet-stream',
      size: rec.size,
      offset: rec.offset
    })
  }
  return out
}

function writeU32(bytes: Uint8Array, offset: number, value: number): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  view.setUint32(offset, value, true)
}

function readU32(bytes: Uint8Array, offset: number): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return view.getUint32(offset, true)
}
