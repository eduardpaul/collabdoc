#!/usr/bin/env bash
# The egui editor spike in a browser (spec 25): build the WebAssembly module,
# serve it, or check it in headless Chromium.
#
#   scripts/egui-web.sh build          # target/egui-web/{index.html,pkg/}
#   scripts/egui-web.sh serve [port]   # build, then http://localhost:8765
#   scripts/egui-web.sh check [port]   # build, serve, drive it with Playwright
#
# Needs the wasm32-unknown-unknown target and wasm-bindgen-cli at the version
# in Cargo.lock (cargo install wasm-bindgen-cli --version <it> --locked).
# wasm-opt (binaryen) shrinks the module when it is installed.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=target/egui-web
PORT=${2:-8765}

build() {
  cargo build --release --target wasm32-unknown-unknown -p collabdoc-egui --lib --features web
  rm -rf "${OUT:?}/pkg"
  mkdir -p "$OUT"
  wasm-bindgen --target web --no-typescript --out-dir "$OUT/pkg" \
    target/wasm32-unknown-unknown/release/collabdoc_egui.wasm
  if command -v wasm-opt >/dev/null; then
    wasm-opt -Oz --enable-bulk-memory --enable-nontrapping-float-to-int \
      -o "$OUT/pkg/collabdoc_egui_bg.wasm" "$OUT/pkg/collabdoc_egui_bg.wasm"
  fi
  cp crates/collabdoc-egui/web/index.html "$OUT/"
  echo "built $OUT ($(du -h "$OUT/pkg/collabdoc_egui_bg.wasm" | cut -f1) wasm," \
    "$(gzip -c "$OUT/pkg/collabdoc_egui_bg.wasm" | wc -c | awk '{printf "%.1f MB", $1/1048576}') gzipped)"
}

case "${1:-build}" in
  build) build ;;
  serve)
    build
    echo "http://localhost:$PORT"
    python3 -m http.server --directory "$OUT" "$PORT"
    ;;
  check)
    build
    python3 -m http.server --directory "$OUT" "$PORT" >/dev/null 2>&1 &
    SERVER=$!
    trap 'kill $SERVER 2>/dev/null' EXIT
    sleep 1
    node scripts/egui-web-check.cjs "http://localhost:$PORT/" "$OUT"
    ;;
  *) echo "usage: $0 build|serve|check [port]" >&2; exit 2 ;;
esac
