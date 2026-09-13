export type ShareErrorCode =
  'wrong-code' | 'version-mismatch' | 'doc-mismatch' | 'full' | 'removed' | 'timeout' | 'stalled'

export class ShareProtocolError extends Error {
  constructor(
    readonly code: ShareErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'ShareProtocolError'
  }
}
