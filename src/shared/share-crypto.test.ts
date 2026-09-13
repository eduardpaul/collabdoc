import { describe, expect, it } from 'vitest'
import {
  deriveSessionSecret,
  deriveTopic,
  formatJoinLink,
  formatShareCode,
  generateShareCode,
  hmacProof,
  parseJoinTarget,
  parseShareCode,
  proofsMatch,
  randomNonce
} from './share-crypto'

describe('share codes', () => {
  it('round-trips a generated code and hides it from the topic hash', async () => {
    const code = generateShareCode()
    expect(parseShareCode(formatShareCode(code))).toBe(code)
    const secret = await deriveSessionSecret(code)
    const topic = await deriveTopic(secret)
    expect(topic.byteLength).toBe(32)
    expect(new TextDecoder().decode(topic)).not.toContain(code)
    const link = formatJoinLink(topic, code)
    const parsed = parseJoinTarget(link)
    expect(parsed.code).toBe(code)
    expect(parsed.hostPublicKey?.byteLength).toBeGreaterThan(10)
  })

  it('proofs are bound to the handshake hash (AC-08.4)', async () => {
    const secret = await deriveSessionSecret(generateShareCode())
    const hashA = randomNonce()
    const hashB = randomNonce()
    const nonce = randomNonce()
    const proof = await hmacProof(secret, hashA, nonce, 'guest')
    expect(await proofsMatch(secret, hashA, nonce, 'guest', proof)).toBe(true)
    expect(await proofsMatch(secret, hashB, nonce, 'guest', proof)).toBe(false)
  })
})
