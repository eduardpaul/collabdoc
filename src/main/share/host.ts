import { bindLink } from '../../core/link'
import type { SyncHub } from '../../core/hub'
import { SHARE_MAX_PEERS, SHARE_ASSET_CHUNK_BYTES } from '../../shared/constants'
import {
  deriveSessionSecret,
  deriveTopic,
  formatJoinLink,
  formatShareCode,
  generateShareCode,
  bytesToHex
} from '../../shared/share-crypto'
import { decodeJsonPayload } from '../../shared/stream-frames'
import type { DocumentAssets } from '../persist/assets'
import { ShareProtocolError, runHostHandshake } from './handshake'
import { FramePump } from './frames'
import { pumpAsLink } from './peer-link'
import { ProofLimiter } from './proofs'
import type { ListenHandle, PeerConnection, PeerTransport } from './transport'
import { bytesToBase64, base64ToBytes } from '../../shared/base64'

export type HostGuest = {
  id: string
  name: string
  color: string
  handle: string
  userId: string
  installPublicKey: string
  connection: PeerConnection['connectionType']
  publicKeyHex: string
}

export type ShareHostEvent =
  | { type: 'ready'; code: string; link: string }
  | { type: 'guest-joined'; guest: HostGuest }
  | { type: 'guest-left'; id: string; reason: string }
  | { type: 'auth-failed'; message: string; lockedUntil: number }
  | { type: 'rotated'; code: string; link: string }
  | { type: 'stopped' }

export class ShareHost {
  readonly limiter = new ProofLimiter()
  readonly guests = new Map<
    string,
    { guest: HostGuest; conn: PeerConnection; detach: () => void; pump: FramePump }
  >()
  private denied = new Set<string>()
  private listen: ListenHandle | null = null
  private secret: Uint8Array = new Uint8Array()
  code = ''
  link = ''
  stopped = false

  constructor(
    private readonly opts: {
      hub: SyncHub
      transport: PeerTransport
      assets: DocumentAssets
      docId: string
      title: string
      hostName: string
      onEvent: (event: ShareHostEvent) => void
    }
  ) {}

  async start(): Promise<{ code: string; link: string }> {
    this.code = formatShareCode(generateShareCode())
    this.secret = new Uint8Array(await deriveSessionSecret(this.code))
    const topic = await deriveTopic(this.secret)
    this.listen = await this.opts.transport.listen(topic, (conn) => {
      void this.onConn(conn)
    })
    await this.listen.ready
    this.link = formatJoinLink(this.listen.publicKey, this.code)
    this.opts.onEvent({ type: 'ready', code: this.code, link: this.link })
    return { code: this.code, link: this.link }
  }

  async stop(): Promise<void> {
    this.stopped = true
    for (const item of this.guests.values()) {
      item.pump.send('control', { type: 'host-ending' })
      item.detach()
      item.conn.destroy()
    }
    this.guests.clear()
    await this.listen?.stop()
    this.listen = null
    this.opts.onEvent({ type: 'stopped' })
  }

  async removeGuest(id: string): Promise<void> {
    const item = this.guests.get(id)
    if (!item) return
    this.denied.add(item.guest.publicKeyHex)
    if (item.guest.installPublicKey) this.denied.add(item.guest.installPublicKey)
    item.pump.send('error', { code: 'removed', message: 'removed' })
    item.detach()
    item.conn.destroy()
    this.guests.delete(id)
    this.opts.onEvent({ type: 'guest-left', id, reason: 'removed' })
    await this.rotate()
  }

  private async rotate(): Promise<void> {
    const previous = this.listen
    this.code = formatShareCode(generateShareCode())
    this.secret = new Uint8Array(await deriveSessionSecret(this.code))
    const topic = await deriveTopic(this.secret)
    this.listen = await this.opts.transport.listen(topic, (conn) => {
      void this.onConn(conn)
    })
    await this.listen.ready
    this.link = formatJoinLink(this.listen.publicKey, this.code)
    for (const item of this.guests.values()) {
      item.pump.send('control', { type: 'rotate', code: this.code, link: this.link })
    }
    await previous?.stop()
    this.opts.onEvent({ type: 'rotated', code: this.code, link: this.link })
  }

  private async onConn(conn: PeerConnection): Promise<void> {
    const pump = new FramePump(conn)
    const keyHex = bytesToHex(conn.remotePublicKey)
    try {
      if (this.limiter.locked) {
        pump.send('error', { code: 'wrong-code', message: 'Host is not accepting connections.' })
        conn.destroy()
        return
      }
      const profile = await runHostHandshake(pump, conn, {
        sessionSecret: this.secret,
        docId: this.opts.docId,
        title: this.opts.title,
        hostName: this.opts.hostName,
        accept: () => {
          if (this.denied.has(keyHex)) return 'removed'
          if (this.guests.size >= SHARE_MAX_PEERS) return 'full'
          return null
        }
      })
      if (this.denied.has(keyHex) || this.denied.has(profile.installPublicKey)) {
        pump.send('error', { code: 'removed', message: 'removed' })
        conn.destroy()
        return
      }
      const id = profile.userId || keyHex
      const guest: HostGuest = {
        id,
        name: profile.name,
        color: profile.color,
        handle: profile.handle,
        userId: profile.userId,
        installPublicKey: profile.installPublicKey,
        connection: conn.connectionType,
        publicKeyHex: keyHex
      }
      const link = pumpAsLink(pump, conn)
      const detach = bindLink(this.opts.hub, `guest:${id}`, link, {
        onClose: () => {
          if (this.guests.delete(id)) {
            this.opts.onEvent({ type: 'guest-left', id, reason: 'disconnected' })
          }
        }
      })
      this.guests.set(id, { guest, conn, detach, pump })
      pump.onFrame((frame) => {
        if (frame.tag === 'asset-request') this.sendAsset(pump, frame.payload)
        if (frame.tag === 'resume') this.resume(pump, frame.payload)
      })
      this.opts.onEvent({ type: 'guest-joined', guest })
    } catch (error) {
      const locked = this.limiter.recordFailure(conn.remotePublicKey)
      const message = error instanceof ShareProtocolError ? error.message : 'Handshake failed'
      pump.send('error', {
        code: error instanceof ShareProtocolError ? error.code : 'wrong-code',
        message
      })
      this.opts.onEvent({
        type: 'auth-failed',
        message,
        lockedUntil: this.limiter.lockedUntil
      })
      conn.destroy()
      void locked
    }
  }

  private sendAsset(pump: FramePump, payload: Uint8Array): void {
    const rec = json(payload)
    const hash = typeof rec.hash === 'string' ? rec.hash : ''
    const asset = this.opts.assets.get(this.opts.docId, hash)
    if (!asset) return
    const chunks = Math.max(1, Math.ceil(asset.bytes.byteLength / SHARE_ASSET_CHUNK_BYTES))
    for (let i = 0; i < chunks; i += 1) {
      const part = asset.bytes.subarray(
        i * SHARE_ASSET_CHUNK_BYTES,
        (i + 1) * SHARE_ASSET_CHUNK_BYTES
      )
      pump.send('asset', {
        hash,
        type: asset.mime,
        index: i,
        total: chunks,
        bytes: bytesToBase64(part)
      })
    }
  }

  private resume(pump: FramePump, payload: Uint8Array): void {
    const rec = json(payload)
    const from = typeof rec.fromVersion === 'string' ? base64ToBytes(rec.fromVersion) : null
    const bytes = this.opts.hub.exportFrom(from)
    const tag =
      from && bytes.byteLength < this.opts.hub.snapshot().byteLength ? 'update' : 'snapshot'
    pump.send(tag, bytes)
  }
}

function json(payload: Uint8Array): Record<string, unknown> {
  try {
    const value = decodeJsonPayload(payload)
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}
