import { bytesToHex } from '../../shared/share-crypto'
import type { DialTarget, ListenHandle, PeerConnection, PeerTransport } from './transport'

type HostSlot = {
  publicKey: Uint8Array
  onConnection: (conn: PeerConnection) => void
}

/** One in-process DHT: hosts keyed by topic hex and by public-key hex. */
export class MemoryNetwork {
  readonly hostsByTopic = new Map<string, HostSlot>()
  readonly hostsByKey = new Map<string, HostSlot>()
  failDial = false
  dialDelayMs = 0

  reset(): void {
    this.hostsByTopic.clear()
    this.hostsByKey.clear()
    this.failDial = false
    this.dialDelayMs = 0
  }
}

const defaultNetwork = new MemoryNetwork()

export function memoryNetwork(): MemoryNetwork {
  return defaultNetwork
}

export class MemoryTransport implements PeerTransport {
  readonly kind = 'memory' as const

  constructor(private readonly net: MemoryNetwork = defaultNetwork) {}

  async listen(
    topic: Uint8Array,
    onConnection: (conn: PeerConnection) => void
  ): Promise<ListenHandle> {
    const publicKey = crypto.getRandomValues(new Uint8Array(32))
    const slot: HostSlot = { publicKey, onConnection }
    this.net.hostsByTopic.set(bytesToHex(topic), slot)
    this.net.hostsByKey.set(bytesToHex(publicKey), slot)
    return {
      publicKey,
      topic,
      ready: Promise.resolve(),
      stop: async () => {
        this.net.hostsByTopic.delete(bytesToHex(topic))
        this.net.hostsByKey.delete(bytesToHex(publicKey))
      }
    }
  }

  async dial(target: DialTarget, opts: { timeoutMs?: number } = {}): Promise<PeerConnection> {
    if (this.net.failDial) {
      await delay(opts.timeoutMs ?? 30)
      throw new Error('Could not reach the host directly (network restrictions)')
    }
    if (this.net.dialDelayMs) await delay(this.net.dialDelayMs)
    const slot = target.hostPublicKey
      ? this.net.hostsByKey.get(bytesToHex(target.hostPublicKey))
      : this.net.hostsByTopic.get(bytesToHex(target.topic))
    if (!slot) throw new Error('Could not reach the host directly (network restrictions)')
    const [hostConn, guestConn] = pairedConnections()
    slot.onConnection(hostConn)
    return guestConn
  }
}

function pairedConnections(): [PeerConnection, PeerConnection] {
  const handshakeHash = crypto.getRandomValues(new Uint8Array(32))
  const hostKey = crypto.getRandomValues(new Uint8Array(32))
  const guestKey = crypto.getRandomValues(new Uint8Array(32))
  const a = makeConn(guestKey, handshakeHash)
  const b = makeConn(hostKey, handshakeHash)
  a.pipe = b
  b.pipe = a
  return [a.conn, b.conn]
}

type PipeEnd = {
  conn: PeerConnection
  pipe?: PipeEnd
  paused: boolean
  closed: boolean
  buffer: Uint8Array[]
  data: Array<(chunk: Uint8Array) => void>
  drain: Array<() => void>
  close: Array<() => void>
  buffered: number
}

function makeConn(remotePublicKey: Uint8Array, handshakeHash: Uint8Array): PipeEnd {
  const end: PipeEnd = {
    conn: null as unknown as PeerConnection,
    paused: false,
    closed: false,
    buffer: [],
    data: [],
    drain: [],
    close: [],
    buffered: 0
  }
  const flush = (): void => {
    if (!end.pipe || end.pipe.paused || end.pipe.data.length === 0) return
    while (end.buffer.length) {
      const chunk = end.buffer.shift()!
      end.buffered -= chunk.byteLength
      for (const listener of end.pipe.data) listener(chunk)
    }
    for (const listener of end.drain) listener()
  }
  end.conn = {
    remotePublicKey,
    handshakeHash,
    connectionType: 'local',
    get bufferedAmount() {
      return end.buffered
    },
    write(bytes) {
      if (end.closed || !end.pipe || end.pipe.closed) return false
      end.buffer.push(bytes)
      end.buffered += bytes.byteLength
      queueMicrotask(flush)
      return end.buffered < 4 * 1024 * 1024
    },
    onData(listener) {
      end.data.push(listener)
      if (end.pipe)
        queueMicrotask(() => {
          const other = end.pipe
          if (!other) return
          while (other.buffer.length && end.data.length && !end.paused) {
            const chunk = other.buffer.shift()!
            other.buffered -= chunk.byteLength
            for (const l of end.data) l(chunk)
          }
        })
    },
    onDrain(listener) {
      end.drain.push(listener)
    },
    onClose(listener) {
      end.close.push(listener)
    },
    destroy() {
      if (end.closed) return
      end.closed = true
      for (const listener of end.close) listener()
      if (end.pipe && !end.pipe.closed) end.pipe.conn.destroy()
    },
    pause() {
      end.paused = true
    },
    resume() {
      end.paused = false
      end.pipe &&
        queueMicrotask(() => {
          const other = end.pipe
          if (!other) return
          while (other.buffer.length && !end.paused) {
            const chunk = other.buffer.shift()!
            other.buffered -= chunk.byteLength
            for (const listener of end.data) listener(chunk)
          }
        })
    }
  }
  return end
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
