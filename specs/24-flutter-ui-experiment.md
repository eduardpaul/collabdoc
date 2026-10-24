# 24 · Flutter UI experiment: same Rust core, Flutter front end

**Phase:** platform (experiment) · **Depends on:** 23 Phase 0 · **Status:** Phase 1 reached on branch `flutter`

Written 2026-10-24. Flutter 3.47.8 (Dart 3.13.7), Linux desktop.

## Question

Can Flutter reach the same Phase 0 result as the GPUI build (spec 23), and what does it cost compared with GPUI?

To keep the comparison fair, both front ends drive the **same Rust core** (`collabdoc-core`: Loro model, reconcile, `Editor`, undo, sync, `.collabdoc`). Only the UI layer differs. Flutter reaches the core through `crates/collabdoc-ffi`, a C ABI with JSON commands.

## Architecture

```
crates/collabdoc-core     unchanged: the document model and every editing rule
crates/collabdoc-ffi      C ABI: cd_open / cd_fork / cd_free / cd_call(JSON) / cd_view / cd_string_free
flutter_app/
  lib/native.dart         dart:ffi binding (~120 lines), Session = one participant
  lib/editor.dart         EditorPane: RichText per block, selection/caret painter,
                          keys → commands, DeltaTextInputClient for typing and IME
  lib/workspace.dart      participants (panes) and sync through the shared hub
  linux/CMakeLists.txt    builds collabdoc-ffi with cargo, bundles it in lib/
  test/                   headless widget tests against the real native core
```

Dart strings are UTF-16, the offsets the core already uses, so the bridge never converts positions.

## Phase 0 result

The same feature set as the GPUI build:
- **Editing:** typing (through the platform text input, IME included), Enter, Backspace/Delete, selection across blocks (keyboard and mouse), double-click for a word, triple-click for a block, arrows with a remembered column, Home/End.
- **Formatting:** bold, italic, underline, strike, inline code and highlight; paragraph, H1–H3 and code block.
- **Clipboard and undo:** plain-text copy/cut/paste; undo/redo per participant.
- **Display:** lists, quotes, figure placeholders.
- **Participants and files:** "+ Peer" (Ctrl+Shift+N) adds a pane as a second synced participant; open and save `.collabdoc`; opens files written by the TypeScript core.

Flutter's Linux embedding has no stable multi-window API, so participants are side-by-side panes in one window rather than separate windows.

**Tests:**
- `flutter test` runs 3 widget tests with real key events and platform text-input deltas. They cover two synced panes, per-participant undo, and stale input from the platform.
- `cargo test -p collabdoc-ffi` covers the bridge.
- `scripts/flutter-smoke.sh` drives the real app under Xvfb and takes screenshots.

## Phase 1 result

Phase 1 makes the editor usable for real documents with several participants. Everything below is in the shared core unless it is drawing.

- **Lists:** bullet, numbered and task lists (Ctrl+Shift+8/7/9 or the toolbar), and Tab / Shift+Tab to nest and lift. Enter splits an item and hands its sub-list to the new item; Enter on an empty item or Backspace at its start leaves the list. Clicking a task box ticks it. Every list command is one undo step, and the tree stays loadable by Tiptap (items start with a paragraph; no empty lists).
- **Links:** Ctrl+K adds, edits or removes the link on the selection or under the caret. Ctrl+click opens it.
- **Markdown clipboard:** copy writes Markdown, including headings, nested lists with ticks, quotes, code fences, inline marks and links. Paste reads it back (`pulldown-cmark`). One paragraph pastes as rich text at the caret. Several blocks go between the halves of the line as one undo step. Ctrl+Shift+V pastes plain text.
- **Remote carets:** each participant publishes its selection as encoded Loro cursors in an ephemeral store, in the TS shape (`{anchor, focus, user}` keyed by peer id). Other panes paint the selection, a caret and a name tag in that participant's color. The tag shows while they move. Carets stay on their characters while text changes on either side. Throttling (20 Hz), the 5 s heartbeat and the 15 s expiry follow spec 07. Closing a pane removes its caret. The TS core resolves a caret written by Rust (`ts_compat`).
- **Long documents:**
  - The bridge sends only blocks that changed, and the block order only when it changed: view 3.9 → 0.8 ms per keystroke on the 50-page document.
  - The block list is virtualised (`super_sliver_list`). Frame build drops from 15.4 to 1.7 ms (p50) and raster from 16.7 to 6.8 ms on the same document.
- **Polish:**
  - Home/End go to the edges of the line on screen in a wrapped paragraph.
  - Dragging a selection past the top or bottom of the list scrolls.

Two fixes came out of the fuzz test (`random_edits.rs`, now with list commands and Markdown paste, 2000 seeds × 2 scenarios):
- After a merge, `normalize` removes containers that concurrent deletes left empty.
- When two participants move the same block at once, each leaves a copy with the same `blockId`. `normalize` now gives the later copy a fresh id, so lookups by id stay unambiguous.

**Tests:** 9 widget tests (lists, links, clipboard, carets, Home/End, drag-scroll, among others), 8 bridge tests, 70 core tests, the seeded fuzz and the TS round trips.

**Known limits:**
- Moving blocks (list commands) copies them, as `loro-prosemirror` does. Someone else's concurrent typing inside a moved block can be lost.
- Pasting Markdown blocks inside a list or quote inserts them as plain text.
- Figures copy as their label.

## Measured against the GPUI build

Same machine, release builds, Linux x86-64 without a GPU (Mesa software rendering under Xvfb). In both builds roughly 50–60 MB of the memory is the software graphics driver (`libLLVM`), which a machine with a GPU does not load.

| | GPUI (spec 23) | Flutter |
| --- | --- | --- |
| What ships | **1 file**, 20 MB | **A folder**, 28 MB: executable, `lib/` (Flutter engine 17 MB, Rust core 4 MB, Dart AOT 3.5 MB, file-dialog plugin), `data/` (ICU, assets, fonts) |
| Memory, empty document | 116 MB RSS | 236 MB RSS / 214 MB PSS |
| Memory, 50-page document (526 blocks) | 150 MB RSS / 130 MB PSS | 293 MB RSS / 271 MB PSS (318 MB after typing) |
| Per keystroke on that document, before drawing | 2.5 ms (core) | 3.0 ms (core) + 3.9 ms (whole view as JSON; JIT test VM); Phase 1: 0.8 ms (changed blocks only) |
| Typing and keys | Same event loop; ordered | Keys reach Dart before typed text, which comes through the platform input method. A key pressed within a few ms of a character can overtake it. Handled: stale input is detected (`TextEditingDelta.oldText`) and lands at the caret, like Flutter's own text field; nothing is corrupted |
| Text rendering | GPUI text runs | `RichText` + `RenderParagraph` (mature: shaping, bidi, hit testing, IME rects) |
| Accessibility | Limited in GPUI | Flutter semantics; would need wiring for a custom editor |
| Toolkit maturity | Pre-1.0, needs the `xattr` patch | Stable, large ecosystem, also mobile and web |
| Build tooling | `cargo` only | Flutter SDK + `cargo` (CMake calls cargo) |
| Hot reload while building UI | No | Yes |

## Conclusion for the decision

- **The goal was a single binary and the lowest resource use.** GPUI meets both: one 20 MB file and about half of Flutter's memory. Flutter can't ship as one file (the engine, AOT code and assets are separate files) and uses roughly twice the memory in this setup.
- **Flutter is quicker to build UI with.** Hot reload, a mature text stack, built-in semantics and stable APIs, and it would also reach mobile.
- **The editing core is shared.** Choosing a front end does not throw away editor work: all editing rules, sync and file compatibility live in `collabdoc-core`, and both front ends stay thin (`editor_view.rs` ≈ 1,250 lines, `editor.dart` ≈ 1,100 lines).

## If Flutter goes further

Done in Phase 1: changed-blocks bridge, virtualised list. Next:
1. Set the IME candidate rect (`setEditableSizeAndTransform` / `setCaretRect`).
2. Windows/macOS: build `collabdoc_ffi.dll` / `.dylib` from the runner build files, the way `linux/CMakeLists.txt` does now.
3. Keep concurrent edits inside a moved block. This needs Loro `MovableList` children or a move-aware merge, and the TS core would have to change in step.
4. Identity and presence beyond panes (spec 07): a user profile, the participant list and claims, and presence over the P2P transport (`Hub` already relays the bytes).

## Open-source editors: adopt one, or keep our own? (evaluated 2026-10-24)

The four maintained Flutter rich-text editors were read at source level against what CollabDoc needs: a nested block tree with stable block ids, local edits turned into Loro ops, remote ops applied without breaking the local selection, IME composition or undo, per-participant Loro undo, and long documents.

| | super_editor 0.3.0-dev.52 | appflowy_editor 6.2.0 | flutter_quill 11.6.0 | fleather 1.28.0 |
| --- | --- | --- | --- | --- |
| License | MIT | MPL-2.0 / AGPL-3.0 | MIT | MIT / BSD |
| Last release | Jun 2026 (dev series since Jun 2024; last stable 2023) | Dec 2025 | Sep 2026 | Aug 2026 |
| Document model | Flat node list, any string id, int `indent` for lists | Node tree, but ids regenerated on copy/move; lists = children of items | Flat lines, block style on `\n`, `indent` ≤ 5 | Flat lines, closed attribute set |
| Our nested tree + stable ids | Flatten; editing makes uuid ids | Ids not stable (deep copies, `fromJson` drops ids) | Ids duplicated on Enter, overwritten on merge | No ids; merge keeps the *later* line |
| Local change events | Fine-grained but inconsistent (bare `NodeChangeEvent`, inserts without marks) | Text edits = "replace whole delta"; indent = delete + re-create | Positional Deltas; several per keystroke, async | Positional Deltas; several per keystroke |
| Remote apply | None: no selection transform, stale node id crashes, IME not resynced | `isRemote` flag, but selection fix-up is wrong, dropped when read-only | `compose(remote)` transforms caret; enters undo; IME diff can delete remote text | `compose(remote)` transforms caret; enters undo; IME composing not transformed |
| Undo | Replay-based; can be disabled | Fixed `UndoManager`, reverts others' edits; can't be removed cleanly | `History` records remote edits; flag juggling | Private snapshot history, always running |
| IME | Delta model; no preedit underline on Linux | Non-delta; preedit written into the doc as real edits | Non-delta, whole document sent to the IME | Delta model, whole document sent |
| Virtualisation | No | Top-level blocks only | No | No |
| Remote carets | Overlay hooks (build it) | `RemoteSelection` widget (path-based, untransformed) | Build from render boxes | Build from render boxes |
| Adapter estimate (MVP) | 8–12 engineer-weeks + fork | 8–12 weeks + 4–6 hardening + MPL fork | 2–3 engineer-months + fork | 2–3 engineer-months + forks of 2 packages |

**Finding: none of them knows about concurrent edits.** Every one would need a translation layer from its model to our tree, a replacement for its undo, and patches to its input client so remote edits don't corrupt selection or IME composition. Those are the hard parts, and `collabdoc-core` + `editor.dart` already do them (stale-delta detection, Loro-cursor carets, per-participant undo, stable block ids, tested). Adopting an editor would trade a ~1,100-line view we control for a 45–97k-line dependency we must fork.

**Decision: keep the model-driven editor; take building blocks, not an editor.**

| Use directly | For | License |
| --- | --- | --- |
| `super_sliver_list` or `scrollable_positioned_list` | Virtualised block list with jump-to-index (Phase 1) | MIT / BSD |
| `mermaid_flutter` (native Mermaid renderer, 28 diagram types) | Figures (Phase 3); young, pin and test against the TS fixtures | MIT |
| `flutter_svg` | SVG figures and icons | MIT |
| `super_clipboard` | Rich copy/paste (HTML) on desktop | MIT |

**Borrow designs, not code:**
- super_editor: keyboard action catalogue (word moves, Ctrl+Backspace), delta-IME mapping and its known pitfalls, overlay layers.
- appflowy_editor: `RemoteSelection` rendering (remote carets with name flags), drag auto-scroll, triple-click handling.

The Markdown/HTML conversion for paste and export should live in the Rust core (shared with agents and the MCP server), not in a Dart editor package.
