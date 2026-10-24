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

The rest of spec 23's Phase 1 followed:
- **Quotes:** Ctrl+Shift+B or the Quote button toggles a quote, as Tiptap's `toggleBlockquote` does.
  - If the lines are all quoted, they leave their innermost quote, and the rest of that quote stays around them.
  - Otherwise they are wrapped. A line in a list brings the whole list, because an item cannot start with a quote.
  - Enter on an empty quoted line, or Backspace at the start of a quote, lifts the line out.
- **Word moves:** Ctrl+←/→ (Shift to select) move by word as Chromium does on Linux, and Ctrl+Backspace/Delete delete a word. Word bounds come from Unicode segmentation.
- **Find and replace:** Ctrl+F / Ctrl+H open a bar like the TS one: match case, n/N, previous/next, replace one or all.
  - Replace all is one undo step.
  - The new text keeps the marks the replaced text shared (ProseMirror's `insertText`).
- **HTML clipboard:** copy offers HTML beside the Markdown text. Paste prefers HTML, as ProseMirror does. Flutter's clipboard is text-only, so the GTK runner has a `collabdoc/clipboard` channel.
  - Copy writes Tiptap's tags, so the TS app reads task lists back.
  - The reader takes the styles other editors write: Google Docs' font-weight spans inside a normal-weight `<b>`, `text-decoration`, `vertical-align`.
  - It also handles VS Code's `white-space: pre` code, `<pre><code class=language-…>` and Mermaid, task checkboxes, and omitted `</li>`.
- **Mermaid paste:** pasted Mermaid source asks "Insert as Mermaid diagram?", as in the TS app.
- **Parity:** `crates/collabdoc-core/tests/fixtures/from-rust.collabdoc` holds every block kind, list, quote and mark the Rust editor makes, made through editor commands.
  - The vitest `editor/rust-parity.test.ts` loads it with the real Tiptap schema through `loro-prosemirror`. It checks the document is valid and has the same types, marks, link targets, task ticks, code language, Mermaid source and unique blockIds.
  - The app's own `DocumentStore` opens it without warnings.

Fixes found along the way:
- Undo after a merge could leave containers empty or the document blockless; undo and redo now run the same tidy-up as an import.
- Typing, Enter or paste on a figure did nothing, so a figure at the end of a document trapped the caret. They now start a line after the figure (from its end) or before it (from its start).
- Enter in the find field also reached the document. Keys that a field in the pane leaves unhandled are no longer the document's.

Two fixes came out of the fuzz test (`random_edits.rs`, now with list commands and Markdown paste, 2000 seeds × 2 scenarios):
- After a merge, `normalize` removes containers that concurrent deletes left empty.
- When two participants move the same block at once, each leaves a copy with the same `blockId`. `normalize` now gives the later copy a fresh id, so lookups by id stay unambiguous.

**Tests:**
- 19 Flutter widget and unit tests (plus one opt-in perf test).
- 8 bridge tests and 5 launcher tests.
- 98 core tests, including the seeded fuzz, now with quotes and Markdown paste (2000 seeds × 2 scenarios).
- The TS round trips, and the TS parity test in `npm test` (309 tests pass).

**Known limits:**
- Moving blocks (list and quote commands) copies them, as `loro-prosemirror` does. Someone else's concurrent typing inside a moved block can be lost.
- Pasting blocks inside a list or quote inserts them as plain text.
- Figures copy as their label. Pasted images wait for assets (Phase 3). Hard breaks (`<br>`) start a new block, because the model has no hard-break node yet.

**Against Electron**, on the same machine and 50-page document. Flutter's keystroke time is the sum of its measured parts: core edit 2.7 ms, bridge 0.8 ms, frame build, raster.

| | Electron | Flutter, GPU renderer | Flutter, software renderer | GPUI (spec 23) |
| --- | --- | --- | --- | --- |
| Ships as | 283 MB runtime plus the app | 10.9 MB, one file | same file | 20 MB, one file |
| Processes | 6 | 1 | 1 | 1 |
| Memory, document open | 447 MB PSS (810 MB RSS summed) | 237 MB PSS (259 RSS) | 139 MB PSS (162 RSS) | 130 MB PSS (150 RSS) |
| After 60 keystrokes | 489 MB PSS | 246 MB PSS | 145 MB PSS | — |
| Keystroke to frame, p50 | 17.6 ms (p95 35) | ≈ 15 ms (raster 9.1 on llvmpipe) | ≈ 9 ms (raster 3.5, p95 6.9) | — |

Flutter on its software renderer uses about a third of Electron's memory. It meets Phase 1's 16 ms typing target on this document; Electron does not.

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

## Single file and lower memory with Flutter (measured 2026-10-24)

Same container as above: Linux x86-64, no GPU (Mesa llvmpipe under Xvfb), release build, the 50-page document (526 blocks), 1400×760 window unless noted. RSS is read 8 s after start.

### Memory

| Setting | RSS | PSS | Raster per frame while typing (p50 / p95) |
| --- | --- | --- | --- |
| Default: Impeller over OpenGL | 259 MB | 236 MB | 9.5 / 23 ms |
| Skia over OpenGL (`fl_dart_project_set_enable_impeller(project, FALSE)`) | 231 MB | 208 MB | 6.5 / 22 ms |
| Skia, smaller resource cache (`Skia.setResourceCacheMaxBytes` 16 MB) | 226 MB | 203 MB | — |
| **Skia software rasterizer** (Impeller off + `FLUTTER_LINUX_RENDERER=software`) | **161 MB** | **139 MB** | **3.2 / 5.5 ms** |
| Same, empty document | 147 MB | 124 MB | — |
| Same, 4K screen (3840×2100) | — | — | 20 / 30 ms |
| glibc tuning (`MALLOC_ARENA_MAX`, trim threshold, periodic `malloc_trim`) | −0 to −7 MB | | — |

**Where the software build's 161 MB goes:**
- malloc heap: 39 MB (engine, Skia, GTK, fontconfig).
- Mesa's LLVM and gallium driver: 38 MB.
- Engine library: 11 MB.
- Other anonymous memory, mostly the Dart heap and thread stacks: 18 MB.
- Other system libraries: 9 MB.
- Dart AOT code: 5 MB.
- Rust core: 4 MB.
- GTK: 4 MB.

**The renderer is the big lever.**
- Impeller is the default and needs software rendering turned off together with it: the engine aborts with "Impeller DlText cannot be drawn to a Skia canvas".
- Software rendering is also the fastest option on a machine without a GPU. The cost grows with pixel count, though; at 4K it is still about 50 fps while typing.
- On a machine with a GPU, the GL path would rasterize faster. The memory gap would be different from this container's: the GPU driver's own memory replaces llvmpipe's.

**What the stock embedder cannot avoid:**
- The GTK embedder always creates an EGL display, so the GL driver (38 MB here) is loaded even in software mode. With no EGL vendor available the app exits ("No provider of eglGetPlatformDisplayEXT").
- Release builds accept no engine switches, so Dart heap limits (`--old_gen_heap_size`) cannot be set.
- Both need a custom embedder, below.

### One file

| Option | Result | Platforms |
| --- | --- | --- |
| **Self-extracting launcher.** A small Rust executable with the bundle appended as a zstd tar. First run unpacks into the user cache under a content hash, then every run `exec`s the app. Prototype: about 80 lines, using the `tar` and `zstd` crates. | **11.0 MB single file** (10.7 MB with `--split-debug-info --obfuscate`, which shrinks `libapp.so` from 5.1 to 4.1 MB). First run unpacks in 454 ms; later starts add 6 ms. RSS is identical to the folder build, because `exec` replaces the launcher. | Linux and macOS as is. Windows has no `exec`: spawn the app and exit. Unpack into `%LOCALAPPDATA%`; sign it so SmartScreen and antivirus trust it. |
| **AppImage** (`appimagetool`). | **12.6 MB single file**, same memory. Mounts itself with FUSE. Without `fusermount` it needs `APPIMAGE_EXTRACT_AND_RUN=1` (tested). | Linux only; the standard there. |
| Fewer files inside the bundle. Link the Rust core into the runner and load it with `DynamicLibrary.process()`. Replace the `file_selector` and `url_launcher` plugins with Rust (`rfd`, `open`). | The engine `.so`, `libapp.so`, `icudtl.dat` and `flutter_assets/` remain. Tidier, but still a folder. | All |
| Truly one ELF with nothing unpacked. | Not possible with released Flutter. The engine ships only as a shared library, and the embedder takes the assets folder and ICU data as file paths. It needs a custom engine build plus an in-memory loader. | — |
| macOS | A `.app` is a folder by design and users expect it, distributed as a `.dmg`. | macOS |

### Custom embedder (larger effort)

A Rust or C embedder on the Flutter embedder API (`FlutterEngineRun`) instead of the GTK one would:
- drop GTK, about 10 MB with its libraries;
- not create EGL in software mode, so the 38 MB GL driver is gone;
- accept engine and Dart switches, including heap limits.

Expect it to sit around 110–120 MB with the 50-page document; that figure is an estimate. The cost is everything GTK provides today, owned by us: windows, input, IME, clipboard, accessibility bridge, dialogs. It also means keeping up with embedder API changes.

### Recommendation

1. **Ship one file** with the self-extracting launcher on Linux and Windows (one tool for both; AppImage is a fine alternative on Linux), and a `.dmg` on macOS.
2. **Turn Impeller off and use the software renderer** when there is no GPU, or as a user setting; measure on real GPUs before making it the default everywhere. Software rendering takes the 50-page document from 259 to 161 MB: still above GPUI's 150 MB, but in the same range instead of twice as much.
3. Add `--split-debug-info --obfuscate` to release builds.
4. Skip glibc tuning; it didn't pay off.
5. Consider a custom embedder only if the last ~40–50 MB matters more than the maintenance.

### Implemented

- **`crates/collabdoc-launcher`** packs the bundle into one file. `scripts/flutter-onefile.sh` builds the release app with `--split-debug-info --obfuscate` and writes `dist/collabdoc-linux-x86_64`.
  - Size: 10.9 MB, of which the launcher is 1.06 MB.
  - Memory: the same as the folder build in both renderers (257 / 158 MB on the 50-page document).
  - First run checks the payload's hash and unpacks it atomically. Later runs `exec` the app directly, and older versions are removed from the cache.
  - The Windows launcher cross-compiles (`x86_64-pc-windows-gnu`, GUI subsystem; it starts the app and exits) but has not been run on Windows.
- **Renderer setting:** the status bar of the first pane shows the running renderer, with a menu for the next start (Automatic / GPU / Software).
  - The choice is stored in `$XDG_CONFIG_HOME/collabdoc/settings.ini` and `COLLABDOC_RENDERER` overrides it.
  - The GTK runner resolves it before the engine starts. Automatic means software when there is no `/dev/dri/renderD*` (or `LIBGL_ALWAYS_SOFTWARE=1`).
  - Software always turns Impeller off with it, so `FLUTTER_LINUX_RENDERER=software` set by hand now works instead of aborting.

## Conclusion for the decision

- **The goal was a single binary and the lowest resource use.** GPUI meets both: one 20 MB file and about half of Flutter's memory with Flutter's default renderer. Flutter's build is a folder, but the launcher above ships it as one 10.9 MB file. The software renderer brings it to 158 MB on the 50-page document, against GPUI's 150 MB.
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
