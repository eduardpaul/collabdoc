import { MAX_DOCUMENT_ASSET_BYTES, MAX_IMAGE_BYTES } from '../../shared/constants'

export type StoredAsset = {
  hash: string
  mime: string
  bytes: Uint8Array
}

export class PersistAssetError extends Error {
  constructor(
    message: string,
    readonly code: 'too-large' | 'doc-too-large'
  ) {
    super(message)
    this.name = 'PersistAssetError'
  }
}

/** In-memory image bytes for open documents, keyed by content hash. */
export class DocumentAssets {
  private readonly byDoc = new Map<string, Map<string, StoredAsset>>()

  put(docId: string, hash: string, mime: string, bytes: Uint8Array): StoredAsset {
    if (bytes.byteLength > MAX_IMAGE_BYTES) {
      throw new PersistAssetError('Image must be 2 MB or smaller.', 'too-large')
    }
    const bag = this.bag(docId)
    const existing = bag.get(hash)
    if (existing) return existing
    if (this.totalBytes(docId) + bytes.byteLength > MAX_DOCUMENT_ASSET_BYTES) {
      throw new PersistAssetError('Document assets would exceed 25 MB.', 'doc-too-large')
    }
    const record: StoredAsset = { hash, mime, bytes }
    bag.set(hash, record)
    return record
  }

  get(docId: string, hash: string): StoredAsset | undefined {
    return this.byDoc.get(docId)?.get(hash)
  }

  list(docId: string): StoredAsset[] {
    return [...(this.byDoc.get(docId)?.values() ?? [])]
  }

  referenced(docId: string, hashes: readonly string[]): StoredAsset[] {
    const bag = this.byDoc.get(docId)
    if (!bag) return []
    const out: StoredAsset[] = []
    const seen = new Set<string>()
    for (const hash of hashes) {
      if (seen.has(hash)) continue
      seen.add(hash)
      const record = bag.get(hash)
      if (record) out.push(record)
    }
    return out
  }

  drop(docId: string): void {
    this.byDoc.delete(docId)
  }

  private bag(docId: string): Map<string, StoredAsset> {
    let bag = this.byDoc.get(docId)
    if (!bag) {
      bag = new Map()
      this.byDoc.set(docId, bag)
    }
    return bag
  }

  private totalBytes(docId: string): number {
    let total = 0
    for (const asset of this.byDoc.get(docId)?.values() ?? []) total += asset.bytes.byteLength
    return total
  }
}
