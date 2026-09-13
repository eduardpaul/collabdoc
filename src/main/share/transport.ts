export type ConnectionType = 'direct' | 'holepunched' | 'relay' | 'local'

export type PeerConnection = {
  readonly remotePublicKey: Uint8Array
  readonly handshakeHash: Uint8Array
  readonly connectionType: ConnectionType
  /** `host:port` of the other end when the transport knows it (diagnostics). */
  readonly remoteAddress?: string
  readonly bufferedAmount: number
  write(bytes: Uint8Array): boolean
  onData(listener: (chunk: Uint8Array) => void): void
  onDrain(listener: () => void): void
  onClose(listener: () => void): void
  destroy(): void
  /** Test hook: freeze the pipe without destroying it (AC-08.7). */
  pause?(): void
  resume?(): void
}

export type ListenHandle = {
  publicKey: Uint8Array
  topic: Uint8Array
  ready: Promise<void>
  stop(): Promise<void>
}

export type DialTarget = { code: string; hostPublicKey?: Uint8Array; topic: Uint8Array }

/**
 * How peers find each other. Hyperswarm is one implementation; MemoryTransport
 * is the one tests and CI use. A relay transport can implement this later.
 */
export interface PeerTransport {
  readonly kind: 'hyperswarm' | 'memory'
  listen(topic: Uint8Array, onConnection: (conn: PeerConnection) => void): Promise<ListenHandle>
  dial(target: DialTarget, opts?: { timeoutMs?: number }): Promise<PeerConnection>
}
