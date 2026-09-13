import type { FrameLink } from '@core/link'
import { DocumentRegistry, type RegistryDebugEntry } from '@core/registry'
import { PORT_MESSAGE_TYPE } from './port-message'

/**
 * Where documents live. In the desktop app that is the main process, reached
 * over IPC plus one MessagePort per document. With no `window.api` (plain
 * Vite for UI work, Playwright in a browser) an in-page registry plays the
 * same role over a web `MessageChannel`, so the client code path — frames
 * included — is identical.
 */
export interface DocumentHost {
  readonly kind: 'ipc' | 'in-page'
  create(options: { title?: string }): Promise<{ docId: string; title: string }>
  attach(docId: string): Promise<MessagePort>
  release(docId: string): Promise<void>
  debug(): Promise<RegistryDebugEntry[]>
}

const ATTACH_TIMEOUT_MS = 5000

function ipcHost(api: NonNullable<Window['api']>): DocumentHost {
  const documents = api.documents
  return {
    kind: 'ipc',
    async create(options) {
      const result = await documents.create(options)
      if (!result.ok) throw new Error(result.error)
      return { docId: result.docId, title: result.title }
    },
    attach(docId) {
      return new Promise<MessagePort>((resolve, reject) => {
        const timer = window.setTimeout(() => {
          window.removeEventListener('message', onMessage)
          reject(new Error('Timed out waiting for the document port'))
        }, ATTACH_TIMEOUT_MS)
        const onMessage = (event: MessageEvent): void => {
          const data = event.data as { type?: string; docId?: string } | null
          if (event.source !== window || data?.type !== PORT_MESSAGE_TYPE || data.docId !== docId) {
            return
          }
          const port = event.ports[0]
          if (!port) return
          window.clearTimeout(timer)
          window.removeEventListener('message', onMessage)
          resolve(port)
        }
        window.addEventListener('message', onMessage)
        void documents.attach(docId).then((result) => {
          if (!result.ok) {
            window.clearTimeout(timer)
            window.removeEventListener('message', onMessage)
            reject(new Error(result.error))
          }
        })
      })
    },
    async release(docId) {
      await documents.release(docId)
    },
    async debug() {
      const result = await documents.debug()
      return result.ok ? result.documents : []
    }
  }
}

function webPortLink(port: MessagePort): FrameLink {
  return {
    send: (frame) => port.postMessage(frame),
    onMessage: (listener) => {
      port.onmessage = (event) => listener(event.data)
    },
    onClose: (listener) => {
      port.addEventListener('close', listener)
    },
    close: () => port.close()
  }
}

/** A registry in this page, with the same reload grace as main. */
export function inPageHost(registry = new DocumentRegistry({ closeDelayMs: 5000 })): DocumentHost {
  const detachers = new Map<string, () => void>()
  return {
    kind: 'in-page',
    async create(options) {
      const entry = registry.create(options)
      return { docId: entry.docId, title: options.title ?? 'Untitled' }
    },
    async attach(docId) {
      detachers.get(docId)?.()
      const channel = new MessageChannel()
      const detach = registry.attach(docId, `page:${docId}`, webPortLink(channel.port1))
      detachers.set(docId, () => {
        detachers.delete(docId)
        detach()
      })
      return channel.port2
    },
    async release(docId) {
      detachers.get(docId)?.()
      const entry = registry.get(docId)
      if (entry && entry.subscribers.size === 0) registry.close(docId)
    },
    async debug() {
      return registry.debug()
    }
  }
}

let current: DocumentHost | null = null

export function documentHost(): DocumentHost {
  if (!current) {
    const api = window.api
    current = api?.documents?.attach ? ipcHost(api) : inPageHost()
    if (current.kind === 'in-page') {
      // Playwright and manual UI work read the hub through this in browser mode.
      window.__collabDebug = () => current!.debug()
    }
  }
  return current
}

export function setDocumentHostForTests(host: DocumentHost | null): void {
  current = host
}

declare global {
  interface Window {
    __collabDebug?: () => Promise<RegistryDebugEntry[]>
  }
}
