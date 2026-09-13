import { decodeDocFrame, encodeDocFrame, FrameError, type DocFrame } from '../shared/protocol'
import type { SyncHub } from './hub'

/**
 * One end of a byte channel, as the hub sees it. `MessagePortMain`,
 * a web `MessagePort`, and (in 08) a peer stream all adapt to this.
 */
export interface FrameLink {
  send(frame: Uint8Array): void
  onMessage(listener: (data: unknown) => void): void
  onClose(listener: () => void): void
  close(): void
}

export type LinkLogger = (message: string, detail?: unknown) => void

/**
 * Attach a link to a hub: send the current snapshot and presence, then relay
 * updates and ephemeral state both ways until the link closes. Malformed
 * frames are logged and dropped; a frame that Loro cannot import is logged
 * and dropped too — the hub's document is never left half-applied because
 * `import` is atomic per call.
 */
export function bindLink(
  hub: SyncHub,
  subscriberId: string,
  link: FrameLink,
  options: { warn?: LinkLogger; onClose?: () => void } = {}
): () => void {
  const warn =
    options.warn ?? ((message, detail) => console.warn(`[collabdoc] ${message}`, detail ?? ''))
  let open = true

  const unsubscribe = hub.subscribe(subscriberId, (event) => {
    if (!open) return
    try {
      link.send(encodeDocFrame(event.type, event.bytes))
    } catch (error) {
      warn(`could not send ${event.type} to ${subscriberId}`, error)
    }
  })

  const release = (): void => {
    if (!open) return
    open = false
    unsubscribe()
    options.onClose?.()
  }

  link.onMessage((data) => {
    if (!open) return
    let frame: DocFrame
    try {
      frame = decodeDocFrame(data)
    } catch (error) {
      warn(
        `dropped a malformed frame from ${subscriberId}: ${error instanceof FrameError ? error.reason : 'error'}`
      )
      return
    }
    try {
      if (frame.kind === 'update' || frame.kind === 'snapshot') {
        hub.applyUpdate(subscriberId, frame.bytes)
      } else {
        hub.applyEphemeral(subscriberId, frame.bytes)
      }
    } catch (error) {
      warn(`dropped an unimportable ${frame.kind} frame from ${subscriberId}`, error)
    }
  })
  link.onClose(release)

  link.send(encodeDocFrame('snapshot', hub.snapshot()))
  link.send(encodeDocFrame('ephemeral', hub.ephemeralSnapshot()))

  return () => {
    release()
    link.close()
  }
}
