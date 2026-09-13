# 03 · Document hub in the main process, renderer as a synced client

**Phase:** 1 · **Depends on:** 01, 02 · **Status:** not started

## Summary

Move the source of truth out of the React reducer. The Electron main process owns one `SyncHub` per open document; the renderer holds a client `LoroDoc` bound to Tiptap through `loro-prosemirror`, and exchanges binary Loro frames with main over a `MessagePort`. This is the same shape as lorocollab's browser ↔ server link, with the WebSocket replaced by IPC. Guests (08) and agents (12) will attach to the same hub.

## Current state (collabdoc)

- `state/AppState.tsx` holds `session.content` as a string; `set-content` on every keystroke.
- IPC is request/response only (`documents:open/read/save`) via `ipcRenderer.invoke`.

## Reference (lorocollab)

- `core/hub.ts` — `SyncHub` with `subscribeLocalUpdates`, `applyUpdate`, `applyEphemeral`, fan-out excluding the sender.
- `shared/protocol.ts` — one-byte-tagged binary frames (`snapshot | update | ephemeral`) and the reasoning for not using JSON for document bytes.
- `client/App.tsx` lines 100–220 — client wiring: import snapshot, `subscribeLocalUpdates → send`, `offlineFrom` version vector recorded at disconnect, replay on reconnect.
- `client/extensions/loro-collab.ts` — `LoroSyncPlugin`, `LoroUndoPlugin`, `LoroEphemeralCursorPlugin`, plus `remoteWritebackGuard`, `remoteSelectionKeeper`, `droppedBlockWatcher`. Read the long comments; they document real bugs in `loro-prosemirror` write-back after remote imports.
- `core/reconnect.test.ts`.

## Review before adopting

- lorocollab has exactly one hub for the process lifetime. CollabDoc needs a `DocumentRegistry` in main: `open(docId) → hub`, reference counting (renderer, guests, agents), `close` when the last client detaches and the doc is saved.
- The client `App.tsx` mixes transport, history, roster and mention logic. Extract transport into `renderer/src/sync/DocumentClient.ts` with an explicit state machine (`connecting → live → detached`).
- `remoteWritebackGuard` / `droppedBlockWatcher` exist because of `loro-prosemirror 0.4.x` behaviour. Re-verify against the pinned version with a test that imports a remote update while the local selection is inside the changed block; keep the guards only if the test still fails without them.
- The server's origin/host checks are irrelevant for IPC but come back in 08.
- Ephemeral timeout is 30 s in the hub; presence (07) will want its own.

## Design

- Main: `src/main/documents/registry.ts` (`DocumentRegistry`), `src/main/documents/hub-port.ts` (binds a `MessagePortMain` to a hub: on attach send `snapshot`, then relay `update`/`ephemeral` both ways, tag the port as a hub subscriber id).
- Port creation: renderer calls `documents:attach(docId)`; main creates a `MessageChannelMain`, keeps one end, and posts the other to the renderer via `webContents.postMessage`. Preload forwards the port to the page (`window.postMessage` with transfer) — this keeps `sandbox: true`.
- Renderer: `sync/DocumentClient.ts` wraps a `LoroDoc`, applies snapshot/updates, forwards local updates and ephemeral, and exposes `status`. `useCollabEditor(client)` builds the Tiptap editor with `LoroCollab.configure({ doc, presence })`.
- Reducer changes: `DocumentSession` loses `content`; it keeps `id`, `title`, `path`, `dirty`, `share`. `dirty` is derived from "hub version ≠ last saved version" reported by main (04 finalises this).
- New/open/close document flows become IPC calls that resolve to a `docId`; the renderer attaches after the response.
- Document title edits go through the `meta` map on the client doc, not the reducer, so guests see them.
- Dev ergonomics: keep the ability to run the renderer alone (no `window.api`) with an in-memory hub in the same page, so Vite HMR work does not need Electron. This replaces the current `hasNativeDocuments()` browser fallback.

## Acceptance criteria

- [ ] AC-03.1 Creating a new document in the UI results in exactly one `SyncHub` in main (observable through a `documents:debug` IPC in dev builds) and an editor bound to a client `LoroDoc` that received a `snapshot` frame.
- [ ] AC-03.2 Typing in the editor produces `update` frames to main; each frame is a Loro update (not JSON) with a 1-byte tag; main imports it and its document text equals the editor text (Playwright test reads both).
- [ ] AC-03.3 An update imported into the hub from another subscriber (test harness or a second port) appears in the editor within 50 ms without moving the local caret when the change is in a different block, and without losing typed characters when it is in the same block.
- [ ] AC-03.4 Undo/redo are wired to Loro (`LoroUndoPlugin`), Tiptap `History` is not loaded, and `Mod+Z` after typing reverts only the local user's last change (full behaviour specified in 06).
- [ ] AC-03.5 Closing the document (home, new, open another) detaches the port and, when no other subscriber remains, disposes the hub; memory of main returns to within 10 % of the pre-open baseline after 3 open/close cycles (measured with `process.memoryUsage()` in a test).
- [ ] AC-03.6 Two documents can be opened in two windows simultaneously without cross-talk (each hub receives only its own frames).
- [ ] AC-03.7 If the renderer reloads (dev HMR or `Ctrl+R`), it re-attaches to the same `docId`, receives a fresh snapshot, and no edits made before the reload are lost.
- [ ] AC-03.8 Malformed frames (unknown tag, truncated payload, oversized > 16 MB) are rejected by main with a logged warning and do not crash or corrupt the hub (unit test with fuzzed frames).
- [ ] AC-03.9 `npm run dev` renderer-only mode still works: with no `window.api`, the page uses an in-memory hub and the full editor is usable for UI work.
- [ ] AC-03.10 `state/AppState.tsx` no longer stores document content; `set-content` and `RecentDocument.content` are removed.

## Out of scope

Persistence to disk (04), remote peers (08), presence UI (07).

## Open questions

- One `BrowserWindow` per document vs tabs inside one window. Current shell assumes one document per window with a sidebar of recents; keep that, but make the registry multi-document from day one.
