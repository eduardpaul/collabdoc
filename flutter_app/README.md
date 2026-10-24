# CollabDoc · Flutter front end (experiment)

A Flutter desktop editor over the Rust document core (`crates/collabdoc-core`), reached through `crates/collabdoc-ffi`. Plan, results and the comparison with the GPUI build: [`specs/24-flutter-ui-experiment.md`](../specs/24-flutter-ui-experiment.md).

```bash
flutter run -d linux -a ../notes.collabdoc   # Linux CMake builds collabdoc-ffi with cargo
cargo build -p collabdoc-ffi
COLLABDOC_FFI_LIB=$PWD/../target/debug/libcollabdoc_ffi.so flutter test
```

`lib/editor.dart` draws blocks and maps keys, mouse and platform text input to core commands; every editing rule is in Rust.

**One file:** `../scripts/flutter-onefile.sh` writes `dist/collabdoc-linux-x86_64`. It unpacks itself into `~/.cache/collabdoc/app/` on first run.

**Renderer:** the status bar shows which renderer is running and offers Automatic, GPU or Software for the next start. Software is Skia's CPU rasterizer, about 100 MB lighter. Automatic picks it when the machine has no GPU. The choice lives in `~/.config/collabdoc/settings.ini` (`[display] renderer=…`); `COLLABDOC_RENDERER=gpu|software` overrides it for one run.

| Keys | Does |
| --- | --- |
| Ctrl+B / I / U / E, Ctrl+Shift+X / H | Bold, italic, underline, code, strike, highlight |
| Ctrl+Alt+0 / 1 / 2 / 3 / C | Paragraph, heading 1–3, code block |
| Ctrl+Shift+8 / 7 / 9, Tab, Shift+Tab | Bullet, numbered, task list; nest, lift |
| Ctrl+Shift+B | Quote on or off |
| Ctrl+←/→ (with Shift), Ctrl+Backspace/Delete | Move or select by word; delete a word |
| Ctrl+K, Ctrl+click | Edit link, open link |
| Ctrl+F, Ctrl+H | Find, replace (Enter / Shift+Enter: next / previous; Esc closes) |
| Ctrl+C / X / V, Ctrl+Shift+V | Copy and cut as Markdown text plus HTML; paste HTML, Markdown or text (Mermaid source asks); paste plain text |
| Ctrl+Z, Ctrl+Y / Ctrl+Shift+Z | Undo, redo (per participant) |
| Ctrl+Shift+N | Add a participant pane |
| Ctrl+N, Ctrl+O | New document, open a `.collabdoc` or Markdown file |
| Ctrl+S, Ctrl+Shift+S | Save now (a draft asks where), Save As; everything is also autosaved |
