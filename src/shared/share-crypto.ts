/**
 * Session codes, topic hashes and HMAC proofs for sharing (08).
 * Web Crypto only — runs in tests and in Electron main.
 */

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const INFO_SESSION = 'collabdoc/session'
const INFO_TOPIC = 'collabdoc/topic'

export function generateShareCode(): string {
  return encodeCrockford(crypto.getRandomValues(new Uint8Array(8))).slice(0, 12)
}

export function formatShareCode(code: string): string {
  const compact = parseShareCode(code)
  return compact.match(/.{1,4}/g)?.join('-') ?? compact
}

export function parseShareCode(raw: string): string {
  const mapped = raw
    .toUpperCase()
    .replace(/-/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0')
    .replace(/U/g, 'V')
  if (!/^[0-9A-HJKMNP-TV-Z]{12}$/.test(mapped)) {
    throw new Error('That is not a CollabDoc connection code.')
  }
  return mapped
}

export async function deriveSessionSecret(code: string): Promise<Uint8Array> {
  const compact = parseShareCode(code)
  return hkdf(new TextEncoder().encode(compact), INFO_SESSION)
}

export async function deriveTopic(sessionSecret: Uint8Array): Promise<Uint8Array> {
  return hkdf(sessionSecret, INFO_TOPIC)
}

export async function hmacProof(
  sessionSecret: Uint8Array,
  handshakeHash: Uint8Array,
  nonce: Uint8Array,
  role: 'guest' | 'host'
): Promise<Uint8Array> {
  const roleBytes = new TextEncoder().encode(role)
  const data = concat(handshakeHash, nonce, roleBytes)
  const key = await crypto.subtle.importKey(
    'raw',
    toBuffer(sessionSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, toBuffer(data)))
}

export async function proofsMatch(
  sessionSecret: Uint8Array,
  handshakeHash: Uint8Array,
  nonce: Uint8Array,
  role: 'guest' | 'host',
  proof: Uint8Array
): Promise<boolean> {
  const expected = await hmacProof(sessionSecret, handshakeHash, nonce, role)
  if (expected.byteLength !== proof.byteLength) return false
  let diff = 0
  for (let i = 0; i < expected.byteLength; i += 1) diff |= expected[i] ^ proof[i]
  return diff === 0
}

export function randomNonce(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(16))
}

export function encodeCrockford(bytes: Uint8Array): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += CROCKFORD[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += CROCKFORD[(value << (5 - bits)) & 31]
  return out
}

export function formatJoinLink(hostPublicKey: Uint8Array, code: string): string {
  return `collabdoc://join/${encodeCrockford(hostPublicKey)}#${formatShareCode(code)}`
}

export function parseJoinTarget(raw: string): { code: string; hostPublicKey?: Uint8Array } {
  const trimmed = raw.trim()
  if (trimmed.startsWith('collabdoc://join/')) {
    const hash = trimmed.indexOf('#')
    const keyPart = trimmed.slice('collabdoc://join/'.length, hash >= 0 ? hash : undefined)
    const codePart = hash >= 0 ? trimmed.slice(hash + 1) : ''
    return {
      code: parseShareCode(codePart),
      hostPublicKey: decodeCrockford(keyPart.replace(/-/g, ''))
    }
  }
  return { code: parseShareCode(trimmed) }
}

export function decodeCrockford(text: string): Uint8Array {
  const compact = text.toUpperCase().replace(/[IL]/g, '1').replace(/O/g, '0').replace(/U/g, 'V')
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const ch of compact) {
    const idx = CROCKFORD.indexOf(ch)
    if (idx < 0) continue
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return new Uint8Array(out)
}

export function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function hkdf(ikm: Uint8Array, info: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', toBuffer(ikm), 'HKDF', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new TextEncoder().encode('collabdoc'),
      info: new TextEncoder().encode(info)
    },
    key,
    256
  )
  return new Uint8Array(bits)
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.byteLength
  }
  return out
}

function toBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}
