# 23 · Migrate to Rust: Loro core + GPUI desktop editor

**Phase:** platform · **Depends on:** 01–22 as they stand · **Status:** Phase 0 done on `rust` (GPUI). The phases continue on the Flutter front end over the same core (spec 24, branch `flutter`), where Phases 1 and 2 are done.

Written 2026-10-24 against `collabdoc` `main` at `dbc0328`.

## Summary

Replace Electron (Chromium + Node + React/Tiptap) with **one native Rust binary**: the document core on Loro's Rust crate and the UI drawn by **GPUI** (Zed's GPU UI framework). The goals are a single binary, the lowest resource use we can reach, and no webview.

The migration goes feature by feature. The Electron app keeps shipping until the Rust build reaches parity. Both builds read and write the same `.collabdoc` files and the same Loro updates, so documents move freely between them during the migration.

## Decisions

| Question | Decision | Why |
| --- | --- | --- |
| Language | **Rust** | Loro is written in Rust (full API, no FFI). There are Rust crates for P2P (iroh), MCP (rmcp), processes, keychain and docx. |
| UI | **GPUI** (`gpui` 0.2.2, Apache-2.0) | No webview. GPU text rendering with per-run styles (weight, italic, colour, background, underline, strike), platform IME, key bindings. Zed shows it handles collaborative editing well. |
| Rejected | Qt (LGPL static linking conflicts with a single binary), Iced (no rich-text editing building blocks), Tauri / MyGo (webview) | See the discussion on this branch's history |
| Editor model | **Model-driven block editor** | The editor never owns text. Every keystroke becomes "blocks should now read like this", and `Document::reconcile` turns that into Loro ops. ProseMirror + `loro-prosemirror` work the same way. |
| File / wire format | **Unchanged** (`loro-prosemirror` tree, `.collabdoc` container) | Mixed Electron/Rust use during the migration; no data migration |

## Architecture

```
crates/
  collabdoc-core/      no UI. Loro document model, the same tree as src/core:
    schema.rs          names shared with src/shared/constants.ts
    tree.rs            loro-prosemirror tree ⇄ flat ViewBlocks (lists, quotes, figures)
    document.rs        Document: reconcile, per-participant undo, history cuts, fork, import/export
    editing.rs         Editor: selection, typing, Enter/Backspace, marks, block kinds (UTF-16 offsets)
    file.rs            .collabdoc container (byte-compatible with collabdoc-file.ts)
    sync.rs            in-process Hub (the SyncHub shape; a network transport plugs in here)
  collabdoc-gpui/      the `collabdoc` binary
    editor_view.rs     draws ViewBlocks with GPUI text runs; keys/mouse/IME → Editor
    workspace.rs       open document, participants (windows), save/open
    theme.rs           dark theme of the Electron app, embedded Inter + JetBrains Mono
third_party/xattr      one-line libc fix gpui 0.2.2 needs on Linux (see Cargo.toml [patch])
```

Rules carried over from the TS app:
- **Agents never touch Loro.** They will use the same block/locator tool surface, ported into `collabdoc-core`.
- **Every participant has its own undo stack**, and undo never reverts someone else's edits. Typing is one step until 1 s idle or a block switch (`humanCommitCutter`). Commands such as bold or heading are their own steps.
- Commit origins `actor:<id>` / `sys:*`, millisecond timestamps, and the mark expand table (`TEXT_STYLE_CONFIG`) are identical.

## Phase 0: editor + Loro backend (done)

**Delivered**
- `collabdoc-core`: the document model above.
- `collabdoc` binary (GPUI):
  - **Editing:** typing, Enter, Backspace/Delete, cross-block selection, mouse (click, drag, double-click for a word, triple-click for a block), arrows with a remembered column, Home/End.
  - **Formatting:** bold, italic, underline, strike, inline code and highlight (shortcuts and toolbar); paragraph, H1–H3 and code block.
  - **Clipboard and undo:** copy/cut/paste as plain text; undo/redo.
  - **Rendering:** bullet, ordered and task lists; quotes; figures shown as read-only placeholders.
  - **Participants:** "+ Peer window" (Ctrl+Shift+N) opens a second participant synced live through Loro. Carets ride along with a collaborator's edits (Loro cursors).
  - **Files:** open/save `.collabdoc`.
- **Compatibility:** files written by the TS core open in Rust, and the TS core reads files the Rust editor wrote (`tests/ts_compat.rs`, using `src/core` itself).

**Tests:** `cargo test` runs 39 core tests (including seeded random editing sessions that check the incremental view against a fresh read of the tree, and that two participants converge), 3 cross-language tests and 2 headless GPUI tests (`gpui` test platform). The GPUI tests drive real key bindings and IME text input, including two synced windows with per-participant undo. `scripts/gpui-smoke.sh` runs the real binary under Xvfb + Mesa llvmpipe and takes screenshots.

**Measured** (release build, Linux x86-64, no GPU: Mesa llvmpipe under Xvfb):

| | |
| --- | --- |
| Binary | 20 MB, one file, fonts embedded (~3 MB of it) |
| Runtime libraries | libc, libgcc_s, libm, xcb/xkbcommon (+ Wayland, Vulkan and fontconfig loaded at run time) |
| Memory, empty document | 116 MB RSS |
| Memory, 50-page document (526 blocks, 22,550 words) | 150 MB RSS / 130 MB PSS. ~60 MB of that is the software Vulkan driver (`libLLVM` 46 MB, `lvp` 7 MB), which a machine with a GPU does not load; the app's own heap is ~41 MB |
| Typing, core only, middle of that document | 2.5 ms per keystroke (`cargo run --release -p collabdoc-core --example generate`) |

**Electron baseline**, measured on the same machine and document (built `out/`, launched through Playwright, the 50-page file opened through the app's own Open command):

| | Electron |
| --- | --- |
| Runtime | 283 MB (`electron/dist`, unpacked) plus the app |
| Processes | 6 (main, renderer, GPU, network service, 2 zygotes) |
| Memory, start screen | 405 MB PSS (764 MB RSS summed over processes) |
| Memory, 50-page document | 447 MB PSS (810 MB RSS summed); 489 MB PSS after 60 keystrokes |
| Typing at the end of that document, keystroke to next frame | 17.6 ms p50, 35 ms p95 |

Spec 24 compares this with the Flutter build.

**Known gaps** (each belongs to a later phase):
- Enter at the end of a list item that has a nested list starts the nested list instead of a new sibling item (ProseMirror's `splitListItem` moves the nested list along).
- No list/quote toggles, no indent/outdent.
- Home/End go to the block's start and end, not the visual line's.
- Paste is plain text. No links UI, no auto-scroll while selecting by drag.
- Mentions and hard breaks make a block read-only for now.
- No presence (remote carets), comments, history, autosave or agents.
- Every render builds an element for every block; a virtualised list (GPUI `list`) is needed before very long documents (Phase 1).
- The per-keystroke reconcile still walks every block in plain Rust (no Loro reads for untouched blocks); fine at 2.5 ms for 50 pages, revisit for 500.

## Phases, one feature at a time

Each phase ends with `cargo test` green, the Electron app untouched, and files still interchangeable. The TS sources listed are what gets ported, with their Vitest suites rewritten as Rust tests.

| # | Feature (spec) | Port from | Done when |
| --- | --- | --- | --- |
| 1 | **Editor completeness (01, 06)**: list toggle/indent/outdent, PM-style list split, quotes, task toggle, links (insert/edit/open), rich paste (Markdown/HTML → blocks), visual-line Home/End, drag auto-scroll, word-wise moves, find/replace | `editor/schema.ts`, `clipboard.ts`, `markdown.ts`, `SearchReplace.tsx` | Typing-latency check under 16 ms per keystroke on a 50-page doc; parity cases from `core-parity.test.ts` pass. **Done** on `flutter` (spec 24, Phase 1 result) |
| 2 | **Persistence (04)**: autosave + drafts, recovery, recents, Markdown import/export, `Documents/CollabDoc` defaults, start screen | `src/main/persist/*`, `core/markdown.ts`, `StartScreen.tsx` | Ports of `store/recents/atomic/autosave` tests; a crash in the middle of typing loses ≤ 1 s. **Done** on `flutter` (spec 24, Phase 2 result) |
| 3 | **Inline nodes and figures (01)**: mentions and hard breaks editable, images (assets), Mermaid rendered natively (`merman` or `mermaid-rs-renderer` → SVG → GPUI), infographic as a placeholder | `editor/figures/*`, `persist/assets.ts` | Figures from the TS fixtures render; images round-trip. **Done** on `flutter` (spec 24, Phase 3 result; Mermaid by `mermaid-rs-renderer` → `resvg` → PNG) |
| 4 | **History and attribution (05)**: per-actor history list, diffs, checkpoints, restore | `core/history*.ts`, `checkpoints.ts`, `authors.ts`, `HistoryPanel.tsx` | Ports of `history*.test.ts`. **Done** on `flutter` (spec 24, Phase 4 result; both cores tell the same history) |
| 5 | **Identity and presence (07)**: profile, participant list, remote carets and selections (an ephemeral store; the Rust crate has none, so a small LWW map with timeouts) | `core/participants.ts`, `sync/presence-store.ts` | Two windows show each other's caret; ≤ 2 KB/s per peer |
| 6 | **Comments and mentions (09, 10)**: threads, anchors, inbox | `core/comments.ts`, `anchors.ts`, `mentions.ts`, `inbox.ts`, `CommentsPanel.tsx` | Ports of `comments/mentions/inbox` tests |
| 7 | **Document MCP server (16)**: loopback streamable HTTP with `rmcp`, bearer token, client roles | `src/main/mcp/*`, `core/tools/*`, `shared/tools.ts` | Port of `DocumentMcpServer.test.ts`; Claude Code edits a doc |
| 8 | **CLI agent backends and runtime (12–15, 17, 18)**: profiles, detection, runs, stream parsers, sources | `src/main/agents/*` | Ports of the agent tests; `fake-cli.js` flows pass |
| 9 | **P2P sharing (08)** on **iroh** (dial by key, hole punching, relay fallback); handshake, proofs and frames ported; `PeerTransport` + memory transport for tests | `src/main/share/*`, `shared/share-crypto.ts` | Port of `share.test.ts`; two machines share by code |
| 10 | **Settings, secrets (11, 20)**: keychain via `keyring`, sources, backends UI | `agents/secrets.ts`, `settings/*` | Secrets never on disk in clear |
| 11 | **Word export (22)**: `docx-rs`, figures rasterised with `resvg` | `core/docx/*` | Port of `build.test.ts`; output opens in Word |
| 12 | **Cutover**: installers (deb/AppImage, MSI, dmg), signing, CI matrix, delete Electron, Node, React and the TS sources not used by anything else | — | Release binary ships; `npm` gone from the repo |

## Single binary and resources

- **One executable.** Fonts are embedded; there are no Node, Chromium or web assets.
- **Linux runtime libraries** come from the system, as any native app: libc, X11/xcb/Wayland, xkbcommon, Vulkan loader + driver, fontconfig/freetype. Machines without a GPU use Mesa's software Vulkan (llvmpipe). That is how the screenshots and smoke test here run.
- Release profile: LTO, one codegen unit, stripped, `panic = "abort"`.
- Measure every phase against Electron: binary size, idle RSS, RSS with a 50-page document, typing latency.

## Risks

| Risk | Mitigation |
| --- | --- |
| GPUI is pre-1.0 and changes with Zed | Pin `gpui = "0.2.2"`; GPUI calls stay in `collabdoc-gpui`, editing rules in the core; upgrade deliberately |
| gpui 0.2.2 needs the `xattr` patch on Linux | Vendored one-line fix behind `[patch.crates-io]`; drop when gpui moves to `xattr` 1.x |
| WSLg Vulkan support varies | Verified on Mesa llvmpipe under Xvfb; check WSLg (`dzn`) on a real machine in Phase 1 |
| Accessibility: GPUI's screen-reader support is limited | Track upstream; keep the editor's text model exposable (it is plain blocks + spans) |
| Writing our own editor | Model-driven design, so rules are unit-tested without a UI; headless GPUI tests for input routing |
| Mermaid parity in pure Rust | Phase 3 trial picked `mermaid-rs-renderer` (all 10 diagram types legible, +3.5 MB) over `merman` (closer to mermaid.js, +18 MB, HTML labels); its known gap is a labelled chained edge |
| iroh ≠ Hyperswarm, so Electron and Rust builds cannot share a live session | Files and Loro updates stay compatible; sharing between the two builds is not a goal |
