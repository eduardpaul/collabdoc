import { SyncHub } from '../../core/hub'
import { listAssets } from '../../core/tree'
import { SHARE_JOIN_TIMEOUT_MS } from '../../shared/constants'
import { base64ToBytes } from '../../shared/base64'
import {
  bytesToHex,
  deriveSessionSecret,
  deriveTopic,
  parseJoinTarget
} from '../../shared/share-crypto'
import { decodeJsonPayload, type StreamFrame } from '../../shared/stream-frames'
import type { DocumentAssets } from '../persist/assets'
import { FramePump } from './frames'
import { type GuestProfile, runGuestHandshake, ShareProtocolError } from './handshake'
import type { PeerConnection, PeerTransport } from './transport'

export type ShareGuestEvent =
  | { type: 'status'; status: string }
  | { type: 'host-ending' }
  | { type: 'rotated'; code: string; link: string }
  | { type: 'error'; message: string; code?: string }

export class ShareGuest {
  hub: SyncHub | null = null
  docId = ''
  title = ''
  private conn: PeerConnection | null = null
  private pump: FramePump | null = null
  private secret: Uint8Array = new Uint8Array()
  private stopped = false
  private readonly pendingAssets = new Map<string, Uint8Array[]>()

  constructor(
    private readonly opts: {
      transport: PeerTransport
      assets: DocumentAssets
      profile: GuestProfile
      onEvent: (event: ShareGuestEvent) => void
    }
  ) {}

  async connect(
    raw: string,
    expectedDocId?: string
  ): Promise<{ docId: string; title: string; hub: SyncHub }> {
    this.opts.onEvent({ type: 'status', status: 'finding host…' })
    const target = parseJoinTarget(raw)
    this.secret = new Uint8Array(await deriveSessionSecret(target.code))
    const topic = await deriveTopic(this.secret)
    this.opts.onEvent({ type: 'status', status: 'connecting' })
    this.conn = await this.opts.transport.dial(
      { code: target.code, hostPublicKey: target.hostPublicKey, topic },
      { timeoutMs: SHARE_JOIN_TIMEOUT_MS }
    )
    this.pump = new FramePump(this.conn)
    this.opts.onEvent({ type: 'status', status: 'verifying' })
    const hello = await runGuestHandshake(this.pump, this.conn, {
      sessionSecret: this.secret,
      profile: this.opts.profile,
      expectedDocId
    })
    this.docId = hello.docId
    this.title = hello.title
    const snapshot = await this.waitSnapshot()
    this.hub = SyncHub.fromSnapshot(snapshot)
    this.bind()
    this.requestMissingAssets()
    this.opts.onEvent({ type: 'status', status: 'joined' })
    return { docId: this.docId, title: this.title, hub: this.hub }
  }

  async disconnect(): Promise<void> {
    this.stopped = true
    this.conn?.destroy()
    this.hub?.dispose()
    this.hub = null
  }

  pause(): void {
    this.conn?.pause?.()
  }

  resumeNetwork(): void {
    this.conn?.resume?.()
  }

  private async waitSnapshot(): Promise<Uint8Array> {
    for (;;) {
      const frame = await this.pump!.next(SHARE_JOIN_TIMEOUT_MS)
      if (frame.tag === 'error') {
        const rec = recOf(frame)
        throw new ShareProtocolError(
          (typeof rec.code === 'string' ? rec.code : 'wrong-code') as never,
          typeof rec.message === 'string' ? rec.message : 'Join failed'
        )
      }
      if (frame.tag === 'snapshot') return frame.payload
      if (frame.tag === 'ephemeral' && this.hub) this.hub.applyEphemeral('host', frame.payload)
    }
  }

  private bind(): void {
    const hub = this.hub!
    const pump = this.pump!
    hub.subscribe('host', (event) => {
      if (event.from === 'host') return
      pump.send(event.type, event.bytes)
    })
    pump.onFrame((frame) => this.onFrame(frame))
    this.conn?.onClose(() => {
      if (!this.stopped) this.opts.onEvent({ type: 'status', status: 'offline — edits will sync' })
    })
  }

  private onFrame(frame: StreamFrame): void {
    const hub = this.hub
    if (!hub) return
    if (frame.tag === 'update' || frame.tag === 'snapshot') {
      hub.applyUpdate('host', frame.payload)
      this.requestMissingAssets()
    } else if (frame.tag === 'ephemeral') {
      hub.applyEphemeral('host', frame.payload)
    } else if (frame.tag === 'asset') {
      this.takeAsset(frame.payload)
    } else if (frame.tag === 'error') {
      const rec = recOf(frame)
      this.opts.onEvent({
        type: 'error',
        code: typeof rec.code === 'string' ? rec.code : undefined,
        message: typeof rec.message === 'string' ? rec.message : 'Share error'
      })
    } else if (frame.tag === 'control') {
      const rec = recOf(frame)
      if (rec.type === 'host-ending') {
        this.stopped = true
        this.opts.onEvent({ type: 'host-ending' })
      }
      if (rec.type === 'rotate' && typeof rec.code === 'string') {
        this.opts.onEvent({
          type: 'rotated',
          code: rec.code,
          link: typeof rec.link === 'string' ? rec.link : ''
        })
      }
    }
  }

  private requestMissingAssets(): void {
    if (!this.hub || !this.pump) return
    for (const hash of listAssets(this.hub.doc)) {
      if (this.opts.assets.get(this.docId, hash)) continue
      this.pump.send('asset-request', { hash })
    }
  }

  private takeAsset(payload: Uint8Array): void {
    const rec = recOf({ tag: 'asset', payload })
    const hash = typeof rec.hash === 'string' ? rec.hash : ''
    const mime = typeof rec.type === 'string' ? rec.type : 'application/octet-stream'
    const index = typeof rec.index === 'number' ? rec.index : 0
    const total = typeof rec.total === 'number' ? rec.total : 1
    const bytes = typeof rec.bytes === 'string' ? base64ToBytes(rec.bytes) : new Uint8Array()
    const parts =
      this.pendingAssets.get(hash) ?? Array.from({ length: total }, () => new Uint8Array())
    parts[index] = bytes
    this.pendingAssets.set(hash, parts)
    if (parts.some((part) => part.byteLength === 0) && total > 1) return
    const joined = joinBytes(parts)
    void crypto.subtle.digest('SHA-256', new Uint8Array(joined)).then((digest) => {
      const got = bytesToHex(new Uint8Array(digest))
      if (got !== hash) {
        this.pump?.send('asset-request', { hash })
        return
      }
      this.opts.assets.put(this.docId, hash, mime, joined)
    })
  }
}

function recOf(frame: StreamFrame): Record<string, unknown> {
  try {
    const value = decodeJsonPayload(frame.payload)
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function joinBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.byteLength
  }
  return out
}
