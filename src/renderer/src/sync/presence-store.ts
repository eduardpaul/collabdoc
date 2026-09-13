import type { PeerID } from 'loro-crdt'
import { CursorEphemeralStore, type CursorPresenceState } from 'loro-prosemirror'
import { PRESENCE_HEARTBEAT_MS, PRESENCE_MAX_HZ, PRESENCE_TIMEOUT_MS } from '@shared/constants'
import type { ActorProfile } from '@shared/types'

export type PresenceClaim = { blockIds: string[]; until: string }

type StoredPayload = {
  anchor: Uint8Array | null
  focus: Uint8Array | null
  user: {
    name: string
    color: string
    actorId?: string
    role?: 'human' | 'agent'
  } | null
  claim?: PresenceClaim | null
}

/**
 * Wraps the cursor store: keeps identity + claims across plugin updates,
 * heartbeats every 5 s, and throttles cursor writes to 20 Hz.
 */
export class PresenceStore {
  readonly inner: CursorEphemeralStore
  readonly peerId: string
  private user: StoredPayload['user'] = null
  private claim: PresenceClaim | null = null
  private pending: CursorPresenceState | null = null
  private lastFlush = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private beat: ReturnType<typeof setInterval> | null = null
  private readonly minGapMs: number

  constructor(peerId: string, timeoutMs = PRESENCE_TIMEOUT_MS, maxHz = PRESENCE_MAX_HZ) {
    this.peerId = peerId
    this.inner = new CursorEphemeralStore(peerId as PeerID, timeoutMs)
    this.minGapMs = Math.ceil(1000 / maxHz)
    const original = this.inner.setLocal.bind(this.inner)
    this.inner.setLocal = (state: CursorPresenceState) => {
      void original
      this.setLocal(state)
    }
  }

  setUser(profile: ActorProfile): void {
    this.user = {
      name: profile.name,
      color: profile.color,
      actorId: profile.actorId,
      role: profile.role
    }
  }

  setLocal(state: CursorPresenceState): void {
    this.pending = state
    const wait = this.minGapMs - (Date.now() - this.lastFlush)
    if (wait <= 0) {
      this.flush(state)
      return
    }
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.flush(this.pending ?? state)
    }, wait)
  }

  setClaim(claim: PresenceClaim | null): void {
    this.claim = claim && Date.parse(claim.until) > Date.now() ? claim : null
    this.flush(this.pending ?? this.inner.getLocal() ?? { user: this.user ?? undefined })
  }

  getAll(): ReturnType<CursorEphemeralStore['getAll']> {
    return this.inner.getAll()
  }

  getAllStates(): ReturnType<CursorEphemeralStore['getAllStates']> {
    return this.inner.getAllStates()
  }

  subscribeBy(listener: (by: 'local' | 'import' | 'timeout') => void): () => void {
    return this.inner.subscribeBy(listener)
  }

  subscribeLocalUpdates(listener: (bytes: Uint8Array) => void): () => void {
    return this.inner.subscribeLocalUpdates(listener)
  }

  apply(bytes: Uint8Array): void {
    this.inner.apply(bytes)
  }

  startHeartbeat(): void {
    this.stopHeartbeat()
    this.beat = setInterval(() => {
      this.flush(this.pending ?? this.inner.getLocal() ?? { user: this.user ?? undefined }, true)
    }, PRESENCE_HEARTBEAT_MS)
    this.flush(this.pending ?? { user: this.user ?? undefined }, true)
  }

  stopHeartbeat(): void {
    if (this.beat) clearInterval(this.beat)
    this.beat = null
  }

  clear(): void {
    this.stopHeartbeat()
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.pending = null
    this.claim = null
    this.inner.delete(this.peerId as PeerID)
  }

  claims(): Array<{ peerId: string; name: string; color: string; claim: PresenceClaim }> {
    const out: Array<{ peerId: string; name: string; color: string; claim: PresenceClaim }> = []
    const states = this.inner.getAllStates() as Record<string, StoredPayload | undefined>
    const now = Date.now()
    for (const [peerId, state] of Object.entries(states)) {
      const claim = state?.claim
      if (!claim?.until || Date.parse(claim.until) <= now) continue
      out.push({
        peerId,
        name: state?.user?.name ?? peerId.slice(0, 6),
        color: state?.user?.color ?? '#8a7d6d',
        claim
      })
    }
    return out
  }

  private flush(state: CursorPresenceState, fromHeartbeat = false): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (!fromHeartbeat) this.lastFlush = Date.now()
    const user = this.user ?? (state.user as StoredPayload['user']) ?? null
    const payload: StoredPayload = {
      anchor: state.anchor?.encode() ?? null,
      focus: state.focus?.encode() ?? null,
      user,
      claim: this.claim
    }
    this.inner.set(this.peerId as PeerID, payload as never)
  }
}
