# CollabDoc · Flutter front end (experiment)

A Flutter desktop editor over the Rust document core (`crates/collabdoc-core`), reached through `crates/collabdoc-ffi`. Plan, results and the comparison with the GPUI build: [`specs/24-flutter-ui-experiment.md`](../specs/24-flutter-ui-experiment.md).

```bash
flutter run -d linux -a ../notes.collabdoc   # Linux CMake builds collabdoc-ffi with cargo
cargo build -p collabdoc-ffi
COLLABDOC_FFI_LIB=$PWD/../target/debug/libcollabdoc_ffi.so flutter test
```

`lib/editor.dart` draws blocks and maps keys, mouse and platform text input to core commands; every editing rule is in Rust.

| Keys | Does |
| --- | --- |
| Ctrl+B / I / U / E, Ctrl+Shift+X / H | Bold, italic, underline, code, strike, highlight |
| Ctrl+Alt+0 / 1 / 2 / 3 / C | Paragraph, heading 1–3, code block |
| Ctrl+Shift+8 / 7 / 9, Tab, Shift+Tab | Bullet, numbered, task list; nest, lift |
| Ctrl+K, Ctrl+click | Edit link, open link |
| Ctrl+C / X / V, Ctrl+Shift+V | Copy, cut and paste as Markdown; paste plain text |
| Ctrl+Z, Ctrl+Y / Ctrl+Shift+Z | Undo, redo (per participant) |
| Ctrl+Shift+N | Add a participant pane |
| Ctrl+S, Ctrl+O | Save, open |
