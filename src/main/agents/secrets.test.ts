// @vitest-environment node
import { mkdtemp, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { SecretStore, plainCipher, type SecretCipher } from './secrets'

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function tmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'collabdoc-secrets-'))
  dirs.push(dir)
  return dir
}

/** A "keyring": XOR with a fixed byte, so a different key reads garbage. */
function xorCipher(key: number): SecretCipher {
  const flip = (buffer: Buffer): Buffer => Buffer.from(buffer.map((b) => b ^ key))
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plain) => flip(Buffer.from(plain, 'utf8')),
    decryptString: (encrypted) => {
      const text = flip(encrypted).toString('utf8')
      JSON.parse(text) // garbage from the wrong key throws, like safeStorage does
      return text
    }
  }
}

describe('SecretStore', () => {
  it('round-trips through the cipher and never writes plain text when encryption is available', async () => {
    const dir = await tmp()
    const store = new SecretStore(dir, xorCipher(0x5a))
    await store.set('source:a:header:X-Key', 'topsecret')
    const raw = await readFile(join(dir, 'secrets.bin'))
    expect(raw.subarray(0, 11).toString()).toBe('CDSEC1:enc\n')
    expect(raw.toString('latin1')).not.toContain('topsecret')
    const again = new SecretStore(dir, xorCipher(0x5a))
    await again.load()
    expect(again.get('source:a:header:X-Key')).toBe('topsecret')
  })

  it('refuses to write while the file cannot be decrypted, so a keyring hiccup does not erase every secret', async () => {
    const dir = await tmp()
    const good = new SecretStore(dir, xorCipher(0x5a))
    await good.set('source:a:header:X-Key', 'topsecret')
    await good.set('source:b:env:TOKEN', 'other')
    const before = await readFile(join(dir, 'secrets.bin'))

    // The keyring answers with a different key (or not at all): reads fail.
    const warnings: string[] = []
    const broken = new SecretStore(dir, xorCipher(0x01), (message) => warnings.push(message))
    await broken.load()
    expect(broken.problem).toMatch(/could not be read/)
    expect(broken.keys()).toEqual([])
    await expect(broken.set('source:c:header:H', 'new')).rejects.toThrow(/kept untouched/)
    await expect(broken.delete('source:a:header:X-Key')).rejects.toThrow(/kept untouched/)
    await expect(broken.deletePrefix('source:a:')).rejects.toThrow(/kept untouched/)
    expect(await readFile(join(dir, 'secrets.bin'))).toEqual(before)
    expect(warnings).toEqual(['secret store unreadable'])

    // When the keyring is back, the same store instance reads everything again.
    const recovered = new SecretStore(dir, xorCipher(0x5a))
    await recovered.load()
    expect(recovered.problem).toBeNull()
    expect(recovered.get('source:a:header:X-Key')).toBe('topsecret')
    expect(recovered.get('source:b:env:TOKEN')).toBe('other')
  })

  it('a missing or empty file is an empty, writable store', async () => {
    const dir = await tmp()
    const store = new SecretStore(dir, plainCipher)
    await store.load()
    expect(store.problem).toBeNull()
    await store.set('k', 'v')
    expect(store.unencrypted).toBe(true)
  })
})
