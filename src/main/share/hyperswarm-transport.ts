import type { DialTarget, ListenHandle, PeerConnection, PeerTransport } from './transport'

/**
 * Real Hyperswarm transport. Loaded lazily so unit tests never touch native
 * modules. Callers should catch load failures and show them in the UI.
 */
export class HyperswarmTransport implements PeerTransport {
  readonly kind = 'hyperswarm' as const

  async listen(
    _topic: Uint8Array,
    _onConnection: (conn: PeerConnection) => void
  ): Promise<ListenHandle> {
    const swarm = await loadSwarm()
    const topic = Buffer.from(_topic)
    swarm.join(topic, { server: true, client: false })
    swarm.on('connection', (socket: HyperswarmSocket) => {
      _onConnection(wrapSocket(socket, 'holepunched'))
    })
    const ready = swarm.flush()
    return {
      publicKey: new Uint8Array(swarm.keyPair.publicKey),
      topic: _topic,
      ready,
      stop: async () => {
        await swarm.destroy()
      }
    }
  }

  async dial(target: DialTarget, opts: { timeoutMs?: number } = {}): Promise<PeerConnection> {
    const swarm = await loadSwarm()
    swarm.join(Buffer.from(target.topic), { server: false, client: true })
    const timeout = opts.timeoutMs ?? 30_000
    return new Promise<PeerConnection>((resolve, reject) => {
      const timer = setTimeout(() => {
        void swarm.destroy()
        reject(new Error('Could not reach the host directly (network restrictions)'))
      }, timeout)
      const onConn = (socket: HyperswarmSocket): void => {
        clearTimeout(timer)
        swarm.removeListener('connection', onConn)
        resolve(wrapSocket(socket, 'direct'))
      }
      swarm.on('connection', onConn)
      void swarm.flush()
    })
  }
}

type HyperswarmSocket = {
  remotePublicKey: Uint8Array
  handshakeHash?: Uint8Array
  rawBytesWritten?: number
  rawStream?: { remoteHost?: string; remotePort?: number }
  write: (data: Uint8Array) => boolean
  on: (event: string, listener: (...args: never[]) => void) => void
  destroy: () => void
}

type Swarm = {
  keyPair: { publicKey: Uint8Array }
  join: (topic: Buffer, opts: { server: boolean; client: boolean }) => void
  flush: () => Promise<void>
  destroy: () => Promise<void>
  on: (event: string, listener: (socket: HyperswarmSocket) => void) => void
  removeListener: (event: string, listener: (socket: HyperswarmSocket) => void) => void
}

async function loadSwarm(): Promise<Swarm> {
  const mod = (await import('hyperswarm')) as unknown as {
    default?: new () => Swarm
  } & (new () => Swarm)
  const Ctor = (mod.default ?? mod) as new () => Swarm
  return new Ctor()
}

function wrapSocket(
  socket: HyperswarmSocket,
  connectionType: PeerConnection['connectionType']
): PeerConnection {
  // A peer dropping off the network surfaces as an 'error' (ECONNRESET) on
  // the secret stream before 'close'. With no listener that is an uncaught
  // exception in the main process — the host would die with its guest.
  socket.on('error', (() => undefined) as never)
  return {
    remotePublicKey: new Uint8Array(socket.remotePublicKey),
    handshakeHash: new Uint8Array(socket.handshakeHash ?? socket.remotePublicKey),
    connectionType,
    remoteAddress: socket.rawStream?.remoteHost
      ? `${socket.rawStream.remoteHost}:${socket.rawStream.remotePort ?? '?'}`
      : undefined,
    get bufferedAmount() {
      return socket.rawBytesWritten ?? 0
    },
    write(bytes) {
      return socket.write(bytes) !== false
    },
    onData(listener) {
      socket.on('data', listener as never)
    },
    onDrain(listener) {
      socket.on('drain', listener as never)
    },
    onClose(listener) {
      socket.on('close', listener as never)
    },
    destroy() {
      socket.destroy()
    }
  }
}
