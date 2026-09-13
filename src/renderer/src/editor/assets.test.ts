import { describe, expect, it } from 'vitest'
import { AssetError, assetSrc, clearAssets, putBytes, putDataUri, totalAssetBytes } from './assets'
import { MAX_IMAGE_BYTES } from './constants'

describe('assets', () => {
  it('stores one copy of the same bytes', async () => {
    clearAssets()
    const bytes = new Uint8Array([1, 2, 3, 4])
    const a = await putBytes(bytes, 'image/png')
    const b = await putBytes(bytes, 'image/png')
    expect(a.sha256).toBe(b.sha256)
    expect(assetSrc(a)).toMatch(/^asset:[a-f0-9]+$/)
    expect(totalAssetBytes()).toBe(4)
  })

  it('converts a data URI', async () => {
    clearAssets()
    const record = await putDataUri('data:image/png;base64,AQIDBA==')
    expect(record.mime).toBe('image/png')
    expect(record.data).toBe('AQIDBA==')
  })

  it('rejects images over 2 MB', async () => {
    clearAssets()
    const bytes = new Uint8Array(MAX_IMAGE_BYTES + 1)
    await expect(putBytes(bytes, 'image/png')).rejects.toBeInstanceOf(AssetError)
  })
})
