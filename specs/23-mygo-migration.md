# 23 · Migrate from Electron to MyGo

**Phase:** platform · **Depends on:** 01–22 as they stand · **Status:** plan

Written 2026-10-24 against `collabdoc` commit `dbc0328` and MyGo v0.6.2 (`github.com/egoist/mygo`, published 2026-10-21).

## Summary

Swap the Electron shell (Chromium + Node main process) for a MyGo app: one Go binary showing the existing React renderer in the system webview (WebKitGTK on Linux/WSLg, WebView2 on Windows, WKWebView on macOS). Go takes over everything the Node main process does today, except the Loro document core. That stays one TypeScript implementation and runs in the page, the way the renderer's existing in-page (browser) mode already runs it.

The migration goes one feature at a time. The renderer is shared by both shells, so the Electron app keeps shipping until the MyGo build reaches parity. Electron is deleted only at the end.

## 1. What is being migrated

| Layer               | Lines (non-test) | Runs today in   | Fate under MyGo                                                                                |
| ------------------- | ---------------: | --------------- | ---------------------------------------------------------------------------------------------- |
| `src/renderer`      |           13,632 | Chromium        | **Stays** (React 19, Tiptap 3, Vite). Gets a MyGo `window.api` adapter.                        |
| `src/core`          |            5,724 | main + renderer | **Stays TypeScript**, runs in the page (see Decision A).                                       |
| `src/shared`        |            1,850 | main + renderer | Stays. `tools.ts` is also exported as JSON for Go; `share-crypto.ts` gets a Go twin.           |
| `src/main`          |            7,168 | Node main       | **Ported to Go**, module by module (§4).                                                       |
| `src/preload`       |              489 | Electron        | Replaced by the MyGo generated client + adapter. `index.d.ts` becomes the contract.            |
| `e2e`, `scripts`    |            1,049 | Playwright/Node | Browser e2e stays. Electron e2e and the launchers are replaced.                                |
| Tests in `src/main` |            2,829 | Vitest          | Re-written as Go tests, with fixtures shared with the TS suites where the logic is duplicated. |

The renderer talks to main through **47 `ipcMain.handle` channels**, 8 push channels (`documents:state`, `documents:listing`, `share:state`, `share:activity`, `mcp:state`, `agents:event`, `agents:backend`, `app:command`), and one `MessagePort` per open document.

Electron APIs in use, and their MyGo equivalents:

| Electron                                         | Used for                                | MyGo                                                                |
| ------------------------------------------------ | --------------------------------------- | ------------------------------------------------------------------- |
| `BrowserWindow` (size, min size, `show:false`)   | main window                             | `mygo.NewWindow(WindowOptions)`                                     |
| `will-navigate`, `setWindowOpenHandler`          | block navigation, open links externally | `Page().OnWillNavigate`, `Page().SetWindowOpenHandler`              |
| `shell.openExternal` (+ `explorer.exe` on WSL)   | links                                   | `Shell` (keep the WSL branch from `wsl.ts`)                         |
| `requestSingleInstanceLock`, `second-instance`   | one process per profile (CRDT safety)   | `App.RequestSingleInstanceLock`, `OnSecondInstance`                 |
| `Menu` (File menu + edit/view/window roles)      | `app:command`                           | `NewMenu`/`MenuItem` + a `mygo.NewEvent[string]("appCommand")`      |
| `dialog.showOpenDialog/showSaveDialog`           | open, save, export, pick folder         | dialogs `Open`, `Save`                                              |
| `safeStorage`                                    | `agents/secrets.ts`                     | `Secrets` (capped at 2,560 bytes, see M8)                           |
| `app.getPath('userData'/'documents')`, `setPath` | profile dir, `COLLABDOC_USER_DATA`      | `App.Path(PathUserData/PathDocuments)`, `App.SetPath`               |
| `before-quit` + async flush                      | persist + kill CLI runs before exit     | `OnBeforeQuit` → `PreventDefault`, work in a goroutine, then `Quit` |
| `ipcMain.handle` / `webContents.send`            | request/response + push                 | `mygo.Bind` services + `mygo.NewEvent[T]`                           |
| `MessageChannelMain` port per document           | binary Loro frames                      | Not needed: the hub runs in the page (Decision A)                   |

Node APIs in use are ordinary for Go: `fs/promises`, `child_process`/`cross-spawn` → `os/exec`; `http` + `@modelcontextprotocol/sdk` → the official Go MCP SDK (`github.com/modelcontextprotocol/go-sdk`); `crypto` → `crypto/*`; `docx` → stays in the page (M5); `hyperswarm` → has no Go implementation (Decision B).

## 2. Decisions

### A. Where the Loro document hub lives: in the page (recommended)

Today `SyncHub`/`DocumentRegistry` (`src/core`) run in Electron main and every renderer, agent and guest attaches to it. Under MyGo there is no Node, so there are three options:

1. **Port `src/core` to Go and run Loro natively.** Rejected for now. The only pure-Go Loro (`Deln0r/loro-go` v0.1.0, alpha) does not handle deletes, rich-text styles, undo or ephemeral state. The official `loro-ffi` bindings need cgo, which gives up MyGo's "no cgo, cross-compile from any machine" property. And the renderer still needs the TypeScript core (it imports 20+ `@core/*` modules), so the core would exist twice and need parity tests forever.
2. **Run the core in a hidden "engine" window.** Possible, but every keystroke would then cross page → Go → page. Hidden webviews may also throttle timers (autosave, reviewer idle triggers).
3. **Run the core in the main page.** `src/renderer/src/sync/host.ts` already has an `in-page` `DocumentHost` that runs `DocumentRegistry` over a web `MessageChannel`, including `peerCall` for an agent session calling a tool. The UI ↔ hub path needs no transport at all. Go does I/O (files, MCP HTTP, CLI processes, P2P sockets) and reaches the hub through a small bridge (M6).

**Recommendation: option 3.** It gives one core, no cgo and the shortest path. What it costs: the authority lives as long as the page, so a page reload or crash drops unsaved ops since the last autosave. Mitigations: autosave drafts (already in spec 04), a flush on `visibilitychange`/before quit, and disabling reload shortcuts in production builds. Option 1 can be revisited once a complete Go Loro binding exists.

### B. P2P transport: go-libp2p in place of Hyperswarm (recommended)

Hyperswarm exists only for JavaScript (Node/Bare). Options:

1. **go-libp2p**: pure Go, Noise handshake, QUIC/TCP, Kademlia DHT discovery, hole punching (DCUtR) with relays as fallback. **Recommended.** The `PeerTransport` interface in `src/main/share/transport.ts` already isolates the transport, and the app-level handshake, proofs and framing (spec 08) port as they are.
2. Keep Hyperswarm in a bundled Bun/Node sidecar. This keeps wire compatibility, but it brings back a JS runtime plus native modules (`sodium-native`, `udx-native`), which defeats the migration.

The cost of option 1: **MyGo and Electron builds cannot share a session with each other.** Hosts and guests must both be on the MyGo build. Sharing ships last (M11), so this matters only after cutover. Spec 08's threat model must be re-checked for libp2p (public DHT/relay nodes and peer IDs instead of the Hyperswarm topic).

### C. Coexistence: two shells, one renderer, until cutover

- `src/renderer` keeps one contract: the `window.api` type in `src/preload/index.d.ts`, moved to `src/renderer/src/host/api.ts`.
- Electron provides it through the preload, as today. MyGo provides it through `src/renderer/src/host/mygo.ts`, an adapter over the generated MyGo client.
- **A namespace the Go side has not implemented yet is left `undefined`.** The renderer already falls back to browser behaviour when `window.api` or one of its parts is missing (`hasNativeDocuments()`, localStorage inbox, in-page host). So each milestone turns one more namespace on, and the MyGo build always runs.
- Electron stays the shipped build until M12. Spec work and bug fixes keep landing in the shared renderer/core during the migration.

## 3. Target layout

```
desktop/                 Go module (MyGo app)
  main.go                window, menu, single instance, lifecycle
  internal/shell/        thin wrapper over MyGo APIs (MyGo is pre-1.0; contain the churn)
  internal/files/        dialogs, read/save bytes, markdown import/export
  internal/persist/      atomic writes, drafts, recents, assets, .collabdoc header
  internal/profile/      profile.json
  internal/inbox/        per-user inbox
  internal/hubbridge/    Go ⇄ page tool-call / attach bridge
  internal/mcp/          document MCP server (go-sdk, streamable HTTP, bearer token)
  internal/secrets/      master key in MyGo Secrets + AES-GCM file
  internal/sources/      knowledge MCP sources (stdio / HTTP clients, folder source)
  internal/agents/       CLI profiles, detection, runs, stream parsers, runtime
  internal/share/        libp2p transport, handshake, proofs, frames, host/guest
mygo.config.ts           devUrl http://127.0.0.1:5174 (vite.web.config.ts), frontendDist out/web
src/renderer/src/host/   api.ts (contract), mygo.ts (adapter), electron passthrough
```

## 4. Milestones, smallest first

Each milestone ships a MyGo build that runs end to end. For every milestone, "done" means: Go tests ported from the matching Vitest suite pass, `npm test` and `npm run test:e2e` still pass, and the feature works by hand on WSLg and native Windows.

### M0 · Spikes (no product code)

Answer these before committing to the plan:

- [ ] Toolchain: Go 1.27.3+ and Bun (MyGo requirements; CI and the dev container have Go 1.24 today). Check whether `npm` can stay the package manager with Bun used only by `mygo`.
- [ ] `mygo init` sample runs on **WSL2/WSLg** (GTK 3 + WebKitGTK 4.1) and on Windows (WebView2). Document the `apt` packages.
- [ ] The renderer's web build (`vite.web.config.ts`) loads from `mygo://localhost/` and `http://mygo.localhost` (Windows). Loro wasm must load with the `application/wasm` content type (`sync/loro-init.ts`).
- [ ] WebKit parity: Tiptap input, IME, clipboard (`editor/clipboard.ts`), Mermaid/Infographic rendering, and **`figures/rasterize.ts`** (SVG → canvas → PNG; WebKit taints canvases more readily than Chromium). This blocks docx export of figures.
- [ ] Binding cost: round-trip latency, plus a 1–5 MB `[]byte` (base64) argument, for snapshots and assets.
- [ ] go-libp2p: two NATed machines find each other with a code and hole-punch. Measure how often the relay fallback is used.
- [ ] Hub-in-page lifetime: what reload/crash looks like and how to block reloads in production.

**Done when:** each box has a written result and Decisions A and B are confirmed or revised in this spec.

### M1 · Shell (S)

The MyGo app opens the renderer in browser mode, with no `window.api` namespaces yet. It already works as a local editor with the in-page hub.

- Window 1320×860, min 900×620, background `#0f0f10`, show on ready.
- Single-instance lock with focus on second launch; navigation guard; `window.open` → external browser; WSL `explorer.exe` branch.
- `COLLABDOC_USER_DATA` → `App.SetPath(PathUserData, …)`; app name `collabdoc` so the profile directory matches Electron's.
- `window.api.platform`, `isWsl`, `shell.openExternal`; `hostLabel()` shows the right host.
- `mygo dev` uses the existing Vite web server; `mygo build` embeds `out/web`.
- Source: `src/main/index.ts` (window/lifecycle parts), `src/main/wsl.ts` (detection only; Chromium flags are dropped).

### M2 · App menu, profile, inbox (S)

- File menu (New, Open…, Import Markdown…, Export ▸ Markdown / with Comments / Word, Save, Save As…) with the same accelerators, emitting `app:command`. Edit/View/Window roles where MyGo has them.
- `profile.get/save` → `internal/profile` (`src/main/profile.ts`, 64 lines).
- `inbox.list/add/markRead` → `internal/inbox` (`src/main/inbox.ts`, 78 lines; `inbox.test.ts`).
- Tests: Go ports of `inbox.test.ts`. Golden JSON files are read by both the TS and Go suites so both read the same on-disk format.

### M3 · Plain file I/O (S)

- `documents.readBytes`, `documents.saveBytes`, `documents.importMarkdown`, `documents.exportMarkdown` (with `extras` assets), `sources.pickFolder` via MyGo dialogs.
- Source: `src/main/documents.ts`, the Markdown handlers in `src/main/documents/ipc.ts`.
- Same validation as today (`ipc-fail.ts` result shapes: `{ ok, error }`).

### M4 · Persistence: `.collabdoc`, autosave, drafts, recents (M–L)

`src/main/persist/store.ts` (484 lines) mixes two jobs that now live in different places:

- **Page side (TS):** encode/decode `.collabdoc` (`core/collabdoc-file.ts`, unchanged), dirty tracking by version vector, `AutosaveScheduler` (`persist/autosave.ts` moves to `src/renderer/src/persist/`), flush on blur/`visibilitychange`/quit.
- **Go side:** `atomicWriteFile` (`atomic.ts`), drafts directory and paths (`paths.ts`), recents (`recents.ts`), assets store (`assets.ts`), Open/Save As dialogs, suggested save path under `Documents/CollabDoc`, recovery offers, `locateRecent`/`relocate`.
- Go reads the `.collabdoc` **header** (magic + length + JSON, no Loro) so the start screen lists recents and recoveries without the page.
- Quit sequence: `OnBeforeQuit` → `PreventDefault` → emit `appFlush` → page writes every dirty doc → page calls `App.FlushDone()` → Go quits. A 5 s timeout means a hung page cannot block quitting.
- Tests: ports of `atomic.test.ts`, `recents.test.ts`, `store.test.ts` (Go part), `autosave.test.ts` (stays Vitest). Files written by the Electron build open in the MyGo build: fixtures in `resources/test/`.

### M5 · Word export (S)

- The page already imports `@core/docx`. Move the `exportDocx` build from main into the page (`lib/docx-export.ts`). Go only shows the Save dialog and writes the bytes.
- `docx` moves from `dependencies` to the renderer bundle. `e2e/docx.spec.ts` keeps passing.
- Depends on the M0 rasterize result.

### M6 · Hub bridge (M)

This is the foundation for M7, M10 and M11: Go code calls into the hub in the page.

- `hubbridge.Call(ctx, docId, actorId, tool, args) (ToolResult, error)`: Go emits `hubCall{callId,…}`; the page runs it on `DocumentRegistry` (the `peerCall` path that exists today) and answers with `Hub.Reply(callId, result)`. Includes timeouts, cancellation, and a "no page / doc not open" error.
- `Attach/Release(actorId, docId)`, so an agent or MCP client appears as a participant (presence, attribution) like today's `DocumentSession`.
- Go learns which documents are open from `documents:state`.
- Tests: a Go fake page, plus a Vitest test of the page side.

### M7 · Document MCP server (M–L)

- Port `src/main/mcp/DocumentMcpServer.ts` (874 lines) to `github.com/modelcontextprotocol/go-sdk`: streamable HTTP on loopback, bearer token + rotate, `x-collabdoc-run` run binding, client approval and roles, disconnect, `setupCommand` per backend, `mcp:state` events.
- Tool definitions stay in `src/shared/tools.ts`. A build step writes `tools.json` (name, description, JSON schema), and Go embeds it with `go:embed`, so the wording agents see stays in one place.
- Every tool call goes through `hubbridge.Call`.
- Tests: port `DocumentMcpServer.test.ts` using the Go SDK client.

### M8 · Secrets and knowledge sources (M)

- `SecretStore`: a random 32-byte master key stored in MyGo `Secrets` (fits the 2,560-byte limit); secrets in a JSON file sealed with AES-GCM. If no keychain is available (e.g. WSL without libsecret), fail closed with the same message as today's `isEncryptionAvailable() === false` path.
- **Secrets saved by the Electron build cannot be read** (Chromium's `safeStorage` format). On first run, show "re-enter source tokens".
- `McpSourceStore` (`sources.ts`, 357 lines): stdio and streamable-HTTP MCP clients via the Go SDK, Microsoft Learn preset, read-only folder source, `refresh`.
- Tests: ports of `secrets.test.ts`, `sources.test.ts` (uses `resources/test/fake-mcp-server.js`, which stays a Node script or becomes a small Go test binary).

### M9 · CLI agent backends (L)

This is pure process work and a good fit for Go.

- `cli-profiles.ts` (Claude Code, Codex ≥ 0.159.2, Gemini, grok, Antigravity, custom), `findBinary`, version checks (`version.ts`), `detect` with caching, `agents:backend` events.
- `CliBackend.run`: spawn in its own process group (Unix) / job object (Windows), stdin prompt, stream parsing (`stream-parsers.ts`), `redact`, SIGTERM → SIGKILL, scratch dirs, per-run MCP config files (`mcp-config-files.ts`).
- Tests: ports of `cli-profiles.test.ts`, `stream-parsers.test.ts` (same recorded transcripts as fixtures), `CliBackend.test.ts` with `resources/test/fake-cli.js`. `real-cli.test.ts` becomes an opt-in Go test behind `COLLABDOC_REAL_CLI`.

### M10 · Agent runtime (M–L)

- Port `AgentRuntime.ts` (543 lines) + `prompt.ts` + `agents/ipc.ts`: runs, cancel/cancelAgent, listRuns, coalescing and caps, event batching to `agents:event`, dispose on quit (kill all runs before the quit flush ends).
- Agents edit only through the MCP server (M7) → hub bridge (M6), so attribution is unchanged.
- Tests: ports of `AgentRuntime.test.ts`, `multi-user.test.ts`.
- Replaces `e2e/electron-agent.spec.ts` with a MyGo smoke test (see §5).

### M11 · P2P sharing (L)

- `internal/share`: libp2p transport behind a Go `PeerTransport` (plus an in-memory transport for tests), the spec 08 handshake and proofs (`handshake.ts`, `proofs.ts`, a Go twin of `shared/share-crypto.ts` checked against **shared test vectors**), length-prefixed frames (`frames.ts`), backpressure that drops ephemeral frames first.
- The host/guest session logic that needs the hub (`host.ts`, `guest.ts`, `peer-link.ts`) splits in two: Go owns connections and frames; the page attaches each remote peer to the hub as a `FrameLink` whose `send` calls `Share.Send(peerId, bytes)` and whose input arrives on a `shareFrame` event.
- `share.start/stop/removeGuest/join/leave`, `share:state`, `share:activity`; `scripts/share-probe.ts` becomes `go run ./desktop/cmd/share-probe`.
- Tests: port `share.test.ts` on the memory transport, plus a libp2p loopback test.
- Release note: MyGo and Electron builds cannot share sessions with each other (Decision B).

### M12 · Cutover (M)

- Packaging with `mygo build` + MyGo installers: Linux (.deb), Windows (installer), macOS (dmg, signing/notarisation). Icons from `build/`. Optionally MyGo signed auto-updates.
- GitHub Actions matrix (Linux, Windows, macOS): `go test ./...`, `npm test`, `npm run test:e2e`, `mygo build`.
- Delete `src/main`, `src/preload`, `electron.vite.config.ts`, `electron-builder.yml`, `scripts/run-electron-vite.mjs`, `scripts/build-win.mjs`, the Electron and electron-toolkit dependencies, `@modelcontextprotocol/sdk`, `hyperswarm`, `cross-spawn`. Update `README.md`, the specs that say "main process", and `Scope.md` (stack table).
- Data carried over: same `userData` directory (profile, inbox, recents, drafts, assets, `.collabdoc` files). Lost: `safeStorage` secrets (M8), and renderer `localStorage` (identity cache, comment UI state, mention dispatch ids), because the origin changes from `file://` to `mygo://localhost`. Anything that must survive goes to Go before cutover.

## 5. Testing strategy

- **Go**: `go test ./desktop/...` for every ported module. Logic that exists in both languages (share crypto, `.collabdoc` header, recents format, stream parsers) uses one set of fixture files read by both suites.
- **Vitest**: `src/core`, `src/shared`, `src/renderer` suites stay as they are.
- **Playwright (browser build)**: unchanged; it already exercises the in-page hub, which is now the production path.
- **Shell smoke test**: Playwright cannot drive WebKitGTK/WebView2. Use a Go test that launches the built app under `xvfb-run` with a test hook (`COLLABDOC_TEST_SCRIPT`), drives a scripted session through `Page().Eval` (create doc, type, save, reopen, run the fake CLI agent), and checks files on disk. This replaces `e2e/electron-agent.spec.ts`.

## 6. Risks

| Risk                                                                      | Mitigation                                                                                   |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| MyGo is pre-1.0 (v0.6.x), new, one main maintainer, no known importers    | Pin the version; keep every MyGo call inside `internal/shell`; spike in M0 before committing |
| WebKitGTK/WebView2 differ from Chromium (editor input, canvas taint, CSS) | M0 parity checklist; Playwright WebKit project added to the browser e2e                      |
| Hub in page: authority tied to page lifetime                              | Autosave drafts, flush on visibility change and quit, reloads blocked in production          |
| libp2p hole punching ≠ Hyperswarm; relays are third-party infrastructure  | M0 measurement; configurable relays/bootstrap nodes; re-review spec 08 threat model          |
| Lost secrets and localStorage at cutover                                  | Release note + first-run prompt; move needed renderer state to Go before M12                 |
| Two shells drifting during the migration                                  | One renderer contract (`host/api.ts`); Electron frozen to bug fixes after M4                 |

## 7. Out of scope

- Rewriting the renderer in MyGo native UI (`ui` package). The React/Tiptap editor stays a web page.
- Porting `src/core` to Go (Decision A, option 1). Revisit when a full Loro Go binding exists without cgo.
- New product features during the migration.
