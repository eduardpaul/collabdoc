#!/usr/bin/env bash
# Drives the real `collabdoc` binary on a virtual display and takes screenshots:
# typing, a heading, a second participant window syncing live, per-participant
# undo, save. Needs Xvfb, xdotool, ImageMagick (`import`) and a Vulkan driver
# (Mesa's llvmpipe works without a GPU).
#
#   scripts/gpui-smoke.sh [path/to/collabdoc] [out-dir]
set -euo pipefail
BIN=${1:-target/debug/collabdoc}
OUT=${2:-target/gpui-smoke}
BIN=$(realpath "$BIN")
mkdir -p "$OUT"
OUT=$(realpath "$OUT")
rm -f "$OUT"/*.png "$OUT/demo.collabdoc"

export DISPLAY=${SMOKE_DISPLAY:-:99}
export XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-$(mktemp -d)}
if ! xdpyinfo >/dev/null 2>&1; then
  Xvfb "$DISPLAY" -screen 0 1600x1000x24 >/dev/null 2>&1 &
  XVFB=$!
  trap 'kill $XVFB 2>/dev/null' EXIT
  sleep 1
fi

timeout 120 "$BIN" "$OUT/demo.collabdoc" >"$OUT/app.log" 2>&1 &
APP=$!
sleep 5
W1=$(xdotool search --name "CollabDoc" | head -1)
xdotool windowmove --sync "$W1" 0 0
xdotool windowfocus --sync "$W1"
xdotool type --delay 20 "Shared notes"
xdotool key ctrl+alt+1 End Return
xdotool type --delay 20 "Written by You in window one."

xdotool key ctrl+shift+n
sleep 3
W2=$(xdotool search --name "CollabDoc" | grep -v "^$W1$" | head -1)
xdotool windowmove --sync "$W2" 640 280
xdotool windowfocus --sync "$W2"
xdotool key ctrl+End Return
xdotool type --delay 20 "Peer 2 adds a line from the second window."
xdotool key Up Home
xdotool type --delay 20 "Edited: "
sleep 1
import -window root "$OUT/1-two-participants.png"

xdotool windowfocus --sync "$W1"
xdotool key ctrl+End
xdotool type --delay 20 " Undo me"
sleep 1.2
xdotool key ctrl+z
sleep 1
import -window root "$OUT/2-undo-is-per-participant.png"
xdotool key ctrl+s
sleep 1
import -window root "$OUT/3-saved.png"
kill "$APP" 2>/dev/null || true

echo "screenshots and demo.collabdoc in $OUT"
cargo run -q -p collabdoc-core --example dump -- "$OUT/demo.collabdoc"
