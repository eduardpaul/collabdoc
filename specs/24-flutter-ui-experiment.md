# 24 · Flutter UI experiment: same Rust core, Flutter front end

**Phase:** platform (experiment) · **Depends on:** 23 Phase 0 · **Status:** Phase 0 reached on branch `flutter`

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

## Measured against the GPUI build

Same machine, release builds, Linux x86-64 without a GPU (Mesa software rendering under Xvfb). In both builds roughly 50–60 MB of the memory is the software graphics driver (`libLLVM`), which a machine with a GPU does not load.

| | GPUI (spec 23) | Flutter |
| --- | --- | --- |
| What ships | **1 file**, 20 MB | **A folder**, 28 MB: executable, `lib/` (Flutter engine 17 MB, Rust core 4 MB, Dart AOT 3.5 MB, file-dialog plugin), `data/` (ICU, assets, fonts) |
| Memory, empty document | 116 MB RSS | 236 MB RSS / 214 MB PSS |
| Memory, 50-page document (526 blocks) | 150 MB RSS / 130 MB PSS | 293 MB RSS / 271 MB PSS (318 MB after typing) |
| Per keystroke on that document, before drawing | 2.5 ms (core) | 3.0 ms (core) + 3.9 ms (whole view as JSON; JIT test VM) |
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

1. Send only changed blocks over the bridge (key + revision) instead of the whole view per keystroke.
2. Virtualise the block list (`ListView.builder` + `SliverList`) for long documents.
3. Set the IME candidate rect (`setEditableSizeAndTransform` / `setCaretRect`).
4. Windows/macOS: build `collabdoc_ffi.dll` / `.dylib` from the runner build files, the way `linux/CMakeLists.txt` does now.
