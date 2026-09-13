import {
  SHARE_MAX_FAILED_PROOFS,
  SHARE_PROOF_LOCK_MS,
  SHARE_PROOF_WINDOW_MS
} from '../../shared/constants'
import { bytesToHex } from '../../shared/share-crypto'

export class ProofLimiter {
  private readonly attempts: number[] = []
  private readonly byKey = new Map<string, number[]>()
  lockedUntil = 0
  failures = 0

  get locked(): boolean {
    return Date.now() < this.lockedUntil
  }

  recordFailure(remotePublicKey: Uint8Array): boolean {
    const now = Date.now()
    this.failures += 1
    this.attempts.push(now)
    const key = bytesToHex(remotePublicKey)
    const list = this.byKey.get(key) ?? []
    list.push(now)
    this.byKey.set(key, list)
    const recent = this.attempts.filter((t) => now - t < SHARE_PROOF_WINDOW_MS)
    this.attempts.length = 0
    this.attempts.push(...recent)
    const recentKey = list.filter((t) => now - t < SHARE_PROOF_WINDOW_MS)
    this.byKey.set(key, recentKey)
    if (recent.length >= SHARE_MAX_FAILED_PROOFS || recentKey.length >= SHARE_MAX_FAILED_PROOFS) {
      this.lockedUntil = now + SHARE_PROOF_LOCK_MS
      return true
    }
    return false
  }
}
