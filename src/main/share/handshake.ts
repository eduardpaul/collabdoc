import { SHARE_AUTH_TIMEOUT_MS, SHARE_PROTOCOL_VERSION } from '../../shared/constants'
import { hmacProof, proofsMatch, randomNonce } from '../../shared/share-crypto'
import { bytesToBase64, base64ToBytes } from '../../shared/base64'
import { decodeJsonPayload } from '../../shared/stream-frames'
import { ShareProtocolError, type ShareErrorCode } from './errors'
import { FramePump } from './frames'
import type { PeerConnection } from './transport'

export type { ShareErrorCode }
export { ShareProtocolError }

export type GuestProfile = {
  userId: string
  name: string
  handle: string
  color: string
  installPublicKey: string
}

export type HelloPayload = {
  protocolVersion: number
  docId: string
  title: string
  hostName: string
  nonceH: string
}

export async function runHostHandshake(
  pump: FramePump,
  conn: PeerConnection,
  input: {
    sessionSecret: Uint8Array
    docId: string
    title: string
    hostName: string
    accept: () => ShareErrorCode | null
  }
): Promise<GuestProfile> {
  const nonceH = randomNonce()
  pump.send('hello', {
    protocolVersion: SHARE_PROTOCOL_VERSION,
    docId: input.docId,
    title: input.title,
    hostName: input.hostName,
    nonceH: bytesToBase64(nonceH)
  } satisfies HelloPayload)

  const auth = await pump.next(SHARE_AUTH_TIMEOUT_MS)
  if (auth.tag === 'error') throw errorFrom(auth.payload)
  if (auth.tag !== 'auth') throw new ShareProtocolError('wrong-code', 'wrong code')
  const rec = asRecord(decodeJsonPayload(auth.payload))
  const nonceG = typeof rec.nonceG === 'string' ? base64ToBytes(rec.nonceG) : new Uint8Array()
  const proof = typeof rec.proof === 'string' ? base64ToBytes(rec.proof) : new Uint8Array()
  const profile = asProfile(rec.profile)
  const ok = await proofsMatch(input.sessionSecret, conn.handshakeHash, nonceH, 'guest', proof)
  if (!ok) throw new ShareProtocolError('wrong-code', 'wrong code')
  const refused = input.accept()
  if (refused) throw new ShareProtocolError(refused, refused)
  const hostProof = await hmacProof(input.sessionSecret, conn.handshakeHash, nonceG, 'host')
  pump.send('auth-ok', { proof: bytesToBase64(hostProof) })
  return profile
}

export async function runGuestHandshake(
  pump: FramePump,
  conn: PeerConnection,
  input: { sessionSecret: Uint8Array; profile: GuestProfile; expectedDocId?: string }
): Promise<HelloPayload> {
  const helloFrame = await pump.next(SHARE_AUTH_TIMEOUT_MS)
  if (helloFrame.tag === 'error') throw errorFrom(helloFrame.payload)
  if (helloFrame.tag !== 'hello') {
    throw new ShareProtocolError('timeout', 'The host did not say hello.')
  }
  const hello = asRecord(decodeJsonPayload(helloFrame.payload)) as unknown as HelloPayload
  if (hello.protocolVersion !== SHARE_PROTOCOL_VERSION) {
    throw new ShareProtocolError('version-mismatch', 'This CollabDoc is a different version.')
  }
  if (input.expectedDocId && hello.docId !== input.expectedDocId) {
    throw new ShareProtocolError('doc-mismatch', 'The host is sharing a different document.')
  }
  const nonceH = base64ToBytes(hello.nonceH)
  const nonceG = randomNonce()
  const proof = await hmacProof(input.sessionSecret, conn.handshakeHash, nonceH, 'guest')
  pump.send('auth', {
    nonceG: bytesToBase64(nonceG),
    proof: bytesToBase64(proof),
    profile: input.profile
  })
  const okFrame = await pump.next(SHARE_AUTH_TIMEOUT_MS)
  if (okFrame.tag === 'error') throw errorFrom(okFrame.payload)
  if (okFrame.tag !== 'auth-ok') throw new ShareProtocolError('wrong-code', 'wrong code')
  const ok = asRecord(decodeJsonPayload(okFrame.payload))
  const hostProof = typeof ok.proof === 'string' ? base64ToBytes(ok.proof) : new Uint8Array()
  const match = await proofsMatch(
    input.sessionSecret,
    conn.handshakeHash,
    nonceG,
    'host',
    hostProof
  )
  if (!match) throw new ShareProtocolError('wrong-code', 'wrong code')
  return hello
}

function errorFrom(payload: Uint8Array): ShareProtocolError {
  const rec = asRecord(decodeJsonPayload(payload))
  const code = (typeof rec.code === 'string' ? rec.code : 'wrong-code') as ShareErrorCode
  return new ShareProtocolError(code, typeof rec.message === 'string' ? rec.message : code)
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function asProfile(value: unknown): GuestProfile {
  const rec = asRecord(value)
  return {
    userId: typeof rec.userId === 'string' ? rec.userId : 'unknown',
    name: typeof rec.name === 'string' ? rec.name : 'Guest',
    handle: typeof rec.handle === 'string' ? rec.handle : 'guest',
    color: typeof rec.color === 'string' ? rec.color : '#2563eb',
    installPublicKey: typeof rec.installPublicKey === 'string' ? rec.installPublicKey : ''
  }
}
