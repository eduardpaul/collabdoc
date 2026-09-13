import { readMeta } from '../../core/document'
import { DocumentRegistry } from '../../core/registry'
import type { DocumentStore } from '../persist/store'
import type { GuestProfile } from './handshake'
import { ShareGuest } from './guest'
import { ShareHost, type HostGuest } from './host'
import { HyperswarmTransport } from './hyperswarm-transport'
import { MemoryNetwork, MemoryTransport } from './memory-transport'
import type { PeerTransport } from './transport'
import { bytesToHex } from '../../shared/share-crypto'

export type ShareUiState = {
  active: boolean
  announcing: boolean
  code: string | null
  link: string | null
  role: 'host' | 'guest' | null
  guests: HostGuest[]
  status: string
  lockedUntil: number
  failedAttempts: number
  hostEnded: boolean
  readOnly: boolean
}

const idle = (): ShareUiState => ({
  active: false,
  announcing: false,
  code: null,
  link: null,
  role: null,
  guests: [],
  status: '',
  lockedUntil: 0,
  failedAttempts: 0,
  hostEnded: false,
  readOnly: false
})

export class ShareService {
  private host: ShareHost | null = null
  private guest: ShareGuest | null = null
  private state: ShareUiState = idle()
  private readonly memoryNet = new MemoryNetwork()

  constructor(
    private readonly registry: DocumentRegistry,
    private readonly persist: DocumentStore,
    private readonly send: (state: ShareUiState) => void,
    private readonly activity: (summary: string) => void
  ) {}

  private transport(): PeerTransport {
    if (process.env.COLLABDOC_SHARE_TRANSPORT === 'memory') {
      return new MemoryTransport(this.memoryNet)
    }
    return new HyperswarmTransport()
  }

  async start(docId: string, hostName: string): Promise<ShareUiState> {
    await this.stop()
    await this.persist.flush(docId)
    const entry = this.registry.get(docId)
    if (!entry) throw new Error('Document is not open')
    this.state = { ...idle(), announcing: true, role: 'host', status: 'announcing…' }
    this.send(this.state)
    const meta = readMeta(entry.hub.doc)
    this.host = new ShareHost({
      hub: entry.hub,
      transport: this.transport(),
      assets: this.persist.assets,
      docId: meta.docId,
      title: meta.title || 'Untitled',
      hostName,
      onEvent: (event) => {
        if (event.type === 'ready') {
          this.state = {
            ...this.state,
            active: true,
            announcing: false,
            code: event.code,
            link: event.link,
            status: 'live'
          }
          this.activity(`Share started · ${event.code}`)
        }
        if (event.type === 'guest-joined') {
          this.state = { ...this.state, guests: [...this.state.guests, event.guest] }
          this.activity(`Guest joined · ${event.guest.name} (${event.guest.connection})`)
        }
        if (event.type === 'guest-left') {
          this.state = {
            ...this.state,
            guests: this.state.guests.filter((g) => g.id !== event.id)
          }
          this.activity(`Guest left · ${event.reason}`)
        }
        if (event.type === 'auth-failed') {
          this.state = {
            ...this.state,
            failedAttempts: this.state.failedAttempts + 1,
            lockedUntil: event.lockedUntil
          }
          this.activity(`Share auth failed · ${event.message}`)
        }
        if (event.type === 'rotated') {
          this.state = { ...this.state, code: event.code, link: event.link }
          this.activity('Share code rotated')
        }
        if (event.type === 'stopped') {
          this.state = idle()
          this.activity('Share stopped')
        }
        this.send(this.state)
      }
    })
    await this.host.start()
    return this.state
  }

  async stop(): Promise<void> {
    await this.host?.stop()
    await this.guest?.disconnect()
    this.host = null
    this.guest = null
    this.state = idle()
    this.send(this.state)
  }

  async removeGuest(id: string): Promise<void> {
    await this.host?.removeGuest(id)
  }

  async join(
    code: string,
    profile: GuestProfile,
    expectedDocId?: string
  ): Promise<{ docId: string; title: string }> {
    await this.stop()
    this.state = { ...idle(), role: 'guest', status: 'finding host…', active: true }
    this.send(this.state)
    this.guest = new ShareGuest({
      transport: this.transport(),
      assets: this.persist.assets,
      profile,
      onEvent: (event) => {
        if (event.type === 'status') {
          this.state = { ...this.state, status: event.status }
        }
        if (event.type === 'host-ending') {
          this.state = {
            ...this.state,
            hostEnded: true,
            readOnly: true,
            status: 'Host ended the session'
          }
          this.activity('Host ended the session')
        }
        if (event.type === 'error') {
          this.state = { ...this.state, status: event.message }
        }
        if (event.type === 'rotated') {
          this.state = { ...this.state, code: event.code, link: event.link }
        }
        this.send(this.state)
      }
    })
    try {
      const joined = await this.guest.connect(code, expectedDocId)
      if (this.registry.has(joined.docId)) {
        /* already open locally — still attach the replica hub? replace. */
        this.registry.close(joined.docId)
      }
      this.registry.register(joined.hub)
      this.persist.follow(joined.docId)
      this.state = {
        ...this.state,
        active: true,
        status: 'joined',
        code
      }
      this.send(this.state)
      this.activity(`Joined session · ${profile.name}`)
      return { docId: joined.docId, title: joined.title }
    } catch (error) {
      this.state = {
        ...idle(),
        status: error instanceof Error ? error.message : 'Join failed'
      }
      this.send(this.state)
      throw error
    }
  }

  snapshot(): ShareUiState {
    return this.state
  }

  installKeyHex(): string {
    return bytesToHex(crypto.getRandomValues(new Uint8Array(32)))
  }
}
