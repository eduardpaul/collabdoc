#!/usr/bin/env bash
# Drives the Flutter build on a virtual display and takes screenshots:
# typing, a heading, a second participant pane syncing live with each other's
# carets, per-participant undo, save, a remote selection. Needs Xvfb, xdotool, ImageMagick (`import`) and Mesa GL.
#
#   scripts/flutter-smoke.sh [bundle/collabdoc] [out-dir]
set -euo pipefail
BIN=${1:-flutter_app/build/linux/x64/debug/bundle/collabdoc}
OUT=${2:-target/flutter-smoke}
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
sleep 8
W=$(xdotool search --name "^CollabDoc$" | head -1)
xdotool windowmove --sync "$W" 0 0
xdotool windowsize --sync "$W" 1400 760
xdotool windowfocus --sync "$W"
sleep 1
# Keys reach Dart before typed text reaches it through the platform input
# method, so pause briefly between typing and arrow/shortcut keys, as a
# person would.
xdotool mousemove 300 200 click 1; sleep 0.3
xdotool type --delay 20 "Shared notes"; sleep 0.1
xdotool key ctrl+alt+1 End Return
xdotool type --delay 20 "Written by You in pane one."; sleep 0.1
xdotool key ctrl+shift+n; sleep 1.5
xdotool key ctrl+End Return
xdotool type --delay 20 "Peer 2 adds a line from pane two."; sleep 0.1
xdotool key Up Home
xdotool type --delay 20 "Edited: "
sleep 1
import -window root -crop 1400x760+0+0 +repage "$OUT/1-two-participants.png"

xdotool mousemove 300 600 click 1; sleep 0.3
xdotool key ctrl+End
xdotool type --delay 20 " Undo me"
sleep 1.2
xdotool key ctrl+z
sleep 1
import -window root -crop 1400x760+0+0 +repage "$OUT/2-undo-is-per-participant.png"
xdotool key ctrl+s
sleep 1
import -window root -crop 1400x760+0+0 +repage "$OUT/3-saved.png"
# Pane two selects its line with Shift+Home; pane one shows it in Peer 2's color.
xdotool mousemove 1000 600 click 1; sleep 0.3
xdotool key ctrl+End shift+Home
sleep 1
import -window root -crop 1400x760+0+0 +repage "$OUT/4-remote-selection.png"
kill "$APP" 2>/dev/null || true

echo "screenshots and demo.collabdoc in $OUT"
cargo run -q -p collabdoc-core --example dump -- "$OUT/demo.collabdoc"
