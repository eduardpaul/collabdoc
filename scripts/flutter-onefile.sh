#!/usr/bin/env bash
# Builds the Flutter app in release mode and packs it into one executable
# with crates/collabdoc-launcher: dist/collabdoc-linux-x86_64.
#
# First run unpacks the app into ~/.cache/collabdoc/app/<hash>/ (about half
# a second); later runs start it directly. Dart symbols for crash reports go
# to dist/symbols/.
#
#   scripts/flutter-onefile.sh [out]
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=${1:-dist/collabdoc-linux-x86_64}
mkdir -p "$(dirname "$OUT")" dist/symbols

(cd flutter_app && flutter build linux --release \
  --split-debug-info=../dist/symbols --obfuscate)
cargo build --release -p collabdoc-launcher
target/release/collabdoc-launcher flutter_app/build/linux/x64/release/bundle "$OUT"
