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
  /**
   * Set when the file exists but could not be read (keyring unavailable,
   * different machine key, corrupt). Writes are refused while it is set so a
   * save cannot replace every stored secret with an empty map; load is retried
   * on the next call in case the keyring comes back.
   */
  private unreadable: string | null = null

  constructor(
    private readonly userData: string,
    private readonly cipher: SecretCipher,
    private readonly log: (message: string, detail?: unknown) => void = () => {}
  ) {}

  /** Why the store is read-only right now, or null when it is usable. */
  get problem(): string | null {
    return this.unreadable
  }

  get file(): string {
    return join(this.userData, 'secrets.bin')
  }

  async load(): Promise<void> {
    if (this.loaded) return
    let raw: Buffer
    try {
      raw = await readFile(this.file)
    } catch {
      // No file yet: an empty store that may be written.
      this.loaded = true
      return
    }
    if (raw.length === 0) {
      this.loaded = true
      return
    }
    try {
      if (raw.subarray(0, ENC_TAG.length).equals(ENC_TAG)) {
        this.values = parse(this.cipher.decryptString(raw.subarray(ENC_TAG.length)))
      } else if (raw.subarray(0, PLAIN_TAG.length).equals(PLAIN_TAG)) {
        this.values = parse(raw.subarray(PLAIN_TAG.length).toString('utf8'))
        this.unencrypted = true
      } else {
        throw new Error('unknown secrets.bin format')
      }
      this.loaded = true
      this.unreadable = null
      // Re-encrypt if we could not have produced this (e.g. keyring came back).
      if (this.unencrypted && this.cipher.isEncryptionAvailable()) await this.save()
    } catch (error) {
      this.values = new Map()
      const detail = error instanceof Error ? error.message : String(error)
      const message =
        `The stored secrets could not be read (${detail}). Existing secrets are kept untouched; ` +
        'source headers and env values cannot be changed until the OS keyring is available again ' +
        `or ${this.file} is removed.`
      if (this.unreadable !== message) this.log('secret store unreadable', detail)
      this.unreadable = message
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
    await this.writable()
    this.values.set(key, value)
    await this.save()
  }

  async delete(key: string): Promise<void> {
    await this.writable()
    if (this.values.delete(key)) await this.save()
  }

  async deletePrefix(prefix: string): Promise<void> {
    await this.writable()
    let changed = false
    for (const key of [...this.values.keys()]) {
      if (key.startsWith(prefix)) {
        this.values.delete(key)
        changed = true
      }
    }
    if (changed) await this.save()
  }

  /** Load, then refuse to go on when the file on disk holds secrets we cannot see. */
  private async writable(): Promise<void> {
    await this.load()
    if (this.unreadable) throw new Error(this.unreadable)
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
