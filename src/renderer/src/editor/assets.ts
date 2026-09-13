import { MAX_DOCUMENT_ASSET_BYTES, MAX_IMAGE_BYTES } from './constants'

export type AssetRecord = {
  sha256: string
  mime: string
  ext: string
  data: string
}

export class AssetError extends Error {
  constructor(
    message: string,
    readonly code: 'too-large' | 'doc-too-large' | 'invalid'
  ) {
    super(message)
    this.name = 'AssetError'
  }
}

const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg'
}

const store = new Map<string, AssetRecord>()
const objectUrls = new Map<string, string>()

export function setAssetDocument(_id?: string): void {
  void _id
}

export function currentAssetDocument(): string {
  return 'current'
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes)
  const digest = await crypto.subtle.digest('SHA-256', copy)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function extForMime(mime: string): string {
  return MIME_EXT[mime] ?? 'bin'
}

export function totalAssetBytes(): number {
  let total = 0
  for (const asset of store.values()) {
    total += atob(asset.data).length
  }
  return total
}

export async function putBytes(
  bytes: Uint8Array,
  mime: string,
  _id?: string
): Promise<AssetRecord> {
  void _id
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new AssetError('Image must be 2 MB or smaller.', 'too-large')
  }
  const sha256 = await sha256Hex(bytes)
  const existing = store.get(sha256)
  if (existing) {
    return existing
  }
  if (totalAssetBytes() + bytes.byteLength > MAX_DOCUMENT_ASSET_BYTES) {
    throw new AssetError('Document assets would exceed 25 MB.', 'doc-too-large')
  }
  const record: AssetRecord = {
    sha256,
    mime,
    ext: extForMime(mime),
    data: bytesToBase64(bytes)
  }
  store.set(sha256, record)
  return record
}

export async function putFile(file: File): Promise<AssetRecord> {
  const buffer = new Uint8Array(await file.arrayBuffer())
  return putBytes(buffer, file.type || 'application/octet-stream')
}

export async function putDataUri(uri: string, _id?: string): Promise<AssetRecord> {
  void _id
  const parsed = parseDataUri(uri)
  if (!parsed) {
    throw new AssetError('Invalid data URI.', 'invalid')
  }
  return putBytes(parsed.bytes, parsed.mime)
}

export function parseDataUri(uri: string): { mime: string; bytes: Uint8Array } | null {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(uri)
  if (!match) {
    return null
  }
  const mime = match[1] || 'application/octet-stream'
  const binary = match[2] ? atob(match[3]) : decodeURIComponent(match[3])
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }
  return { mime, bytes }
}

export function assetSrc(record: AssetRecord): string {
  return `asset:${record.sha256}`
}

export function isAssetSrc(src: string): boolean {
  return src.startsWith('asset:')
}

export function hashFromSrc(src: string): string | null {
  if (src.startsWith('asset:')) {
    return src.slice('asset:'.length)
  }
  const file = /(?:^|\/)([a-f0-9]{16,})\.([a-z0-9]+)$/i.exec(src)
  return file?.[1] ?? null
}

export function getAsset(hash: string): AssetRecord | undefined {
  return store.get(hash)
}

export function assetObjectUrl(src: string): string | null {
  if (src.startsWith('data:') || src.startsWith('blob:')) {
    return src
  }
  const hash = hashFromSrc(src)
  if (!hash) {
    return null
  }
  const record = getAsset(hash)
  if (!record) {
    return null
  }
  const cached = objectUrls.get(hash)
  if (cached) {
    return cached
  }
  const bytes = base64ToBytes(record.data)
  const url = URL.createObjectURL(new Blob([bytes.buffer as ArrayBuffer], { type: record.mime }))
  objectUrls.set(hash, url)
  return url
}

export function snapshotAssets(): Record<string, AssetRecord> {
  return Object.fromEntries(store)
}

export function restoreAssets(records: Record<string, AssetRecord> | undefined): void {
  clearAssets()
  for (const [hash, record] of Object.entries(records ?? {})) {
    store.set(hash, record)
  }
}

export function clearAssets(_id?: string): void {
  void _id
  store.clear()
  for (const url of objectUrls.values()) {
    URL.revokeObjectURL(url)
  }
  objectUrls.clear()
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

export function base64ToBytes(data: string): Uint8Array {
  const binary = atob(data)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}
