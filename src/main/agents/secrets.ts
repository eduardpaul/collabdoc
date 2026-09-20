import { mkdir, readFile, writeFile } from 'fs/promises'
import { dirname, join } from 'path'

/** What Electron's `safeStorage` offers, as an interface so tests can pass a plain one. */
export type SecretCipher = {
  isEncryptionAvailable(): boolean
  encryptString(plain: string): Buffer
  decryptString(encrypted: Buffer): string
}

/** Stores as plain text; for tests and for systems without a keyring (with a warning). */
export const plainCipher: SecretCipher = {
  isEncryptionAvailable: () => false,
  encryptString: (plain) => Buffer.from(plain, 'utf8'),
  decryptString: (buffer) => buffer.toString('utf8')
}

const ENC_TAG = Buffer.from('CDSEC1:enc\n', 'utf8')
const PLAIN_TAG = Buffer.from('CDSEC1:plain\n', 'utf8')

/**
 * `userData/secrets.bin`: one encrypted blob holding every secret the app
 * keeps (source headers/env now; provider keys when 11 lands). Values never
 * cross IPC — callers hand out `SecretField { hasValue, masked }` instead.
 */
export class SecretStore {
  private values = new Map<string, string>()
  private loaded = false
  /** True when the file is stored without OS encryption. */
  unencrypted = false

  constructor(
    private readonly userData: string,
    private readonly cipher: SecretCipher
  ) {}

  get file(): string {
    return join(this.userData, 'secrets.bin')
  }

  async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    let raw: Buffer
    try {
      raw = await readFile(this.file)
    } catch {
      return
    }
    try {
      if (raw.subarray(0, ENC_TAG.length).equals(ENC_TAG)) {
        this.values = parse(this.cipher.decryptString(raw.subarray(ENC_TAG.length)))
        // Re-encrypt if we could not have produced this (e.g. keyring came back).
      } else if (raw.subarray(0, PLAIN_TAG.length).equals(PLAIN_TAG)) {
        this.values = parse(raw.subarray(PLAIN_TAG.length).toString('utf8'))
        this.unencrypted = true
        if (this.cipher.isEncryptionAvailable()) await this.save()
      }
    } catch {
      // Unreadable (different machine key, corrupt file): start empty rather than crash.
      this.values = new Map()
    }
  }

  get(key: string): string | undefined {
    return this.values.get(key)
  }

  has(key: string): boolean {
    return this.values.has(key)
  }

  keys(prefix = ''): string[] {
    return [...this.values.keys()].filter((k) => k.startsWith(prefix))
  }

  async set(key: string, value: string): Promise<void> {
    await this.load()
    this.values.set(key, value)
    await this.save()
  }

  async delete(key: string): Promise<void> {
    await this.load()
    if (this.values.delete(key)) await this.save()
  }

  async deletePrefix(prefix: string): Promise<void> {
    await this.load()
    let changed = false
    for (const key of [...this.values.keys()]) {
      if (key.startsWith(prefix)) {
        this.values.delete(key)
        changed = true
      }
    }
    if (changed) await this.save()
  }

  private async save(): Promise<void> {
    const json = JSON.stringify(Object.fromEntries(this.values))
    let payload: Buffer
    if (this.cipher.isEncryptionAvailable()) {
      payload = Buffer.concat([ENC_TAG, this.cipher.encryptString(json)])
      this.unencrypted = false
    } else {
      payload = Buffer.concat([PLAIN_TAG, Buffer.from(json, 'utf8')])
      this.unencrypted = true
    }
    await mkdir(dirname(this.file), { recursive: true })
    await writeFile(this.file, payload, { mode: 0o600 })
  }
}

function parse(json: string): Map<string, string> {
  const rec = JSON.parse(json) as Record<string, unknown>
  const out = new Map<string, string>()
  for (const [key, value] of Object.entries(rec)) if (typeof value === 'string') out.set(key, value)
  return out
}

/** `…a1b2` for the settings UI; never the value itself. */
export function maskSecret(value: string): string {
  return value.length <= 4 ? '••••' : `…${value.slice(-4)}`
}
