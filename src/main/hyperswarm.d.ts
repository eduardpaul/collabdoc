declare module 'hyperswarm' {
  export default class Hyperswarm {
    keyPair: { publicKey: Uint8Array }
    join(topic: Uint8Array | Buffer, opts: { server: boolean; client: boolean }): void
    flush(): Promise<void>
    destroy(): Promise<void>
    on(event: string, listener: (socket: never) => void): void
    removeListener(event: string, listener: (socket: never) => void): void
  }
}
