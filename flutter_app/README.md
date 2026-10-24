# CollabDoc · Flutter front end (experiment)

A Flutter desktop editor over the Rust document core (`crates/collabdoc-core`), reached through `crates/collabdoc-ffi`. Plan, results and the comparison with the GPUI build: [`specs/24-flutter-ui-experiment.md`](../specs/24-flutter-ui-experiment.md).

```bash
flutter run -d linux -a ../notes.collabdoc   # Linux CMake builds collabdoc-ffi with cargo
cargo build -p collabdoc-ffi
COLLABDOC_FFI_LIB=$PWD/../target/debug/libcollabdoc_ffi.so flutter test
```

`lib/editor.dart` draws blocks and maps keys, mouse and platform text input to core commands; every editing rule is in Rust.
