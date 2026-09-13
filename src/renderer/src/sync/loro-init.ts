import * as loroWeb from 'loro-crdt/web'

/**
 * The renderer uses loro-crdt's `web` build (see the `loro-crdt` alias in the
 * Vite configs) and initialises it once, before React mounts.
 *
 * The `bundler` build Vite would pick in development relies on ESM wasm
 * imports Vite does not support, and the `browser` build loads with a
 * synchronous XHR. The `web` build fetches its `.wasm` by URL: in Vite's dev
 * server that is a served asset; in the packaged app — a `file://` page,
 * which cannot fetch files — the Electron renderer build inlines the asset
 * as a `data:` URL (`assetsInlineLimit`), which fetch does accept.
 */
// The web entry re-exports wasm-bindgen's `init` as its default export; the
// package's typings only declare the named exports.
const init = (loroWeb as unknown as { default: () => Promise<unknown> }).default

let ready: Promise<void> | null = null

export function loroReady(): Promise<void> {
  if (!ready) {
    ready = init().then(() => undefined)
  }
  return ready
}
