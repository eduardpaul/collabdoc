#!/usr/bin/env bash
# Phase 4 on the Flutter build: two participants write; the History tab lists
# their commits by author; a checkpoint is marked; the second participant
# rewrites a line; an entry's diff; the checkpoint viewed read-only and
# restored; the attribution gutter. Screenshots, then the saved document's
# history as the core tells it. Needs Xvfb, xdotool and ImageMagick.
#
#   scripts/flutter-history.sh [bundle/collabdoc] [out-dir]
set -euo pipefail
BIN=${1:-flutter_app/build/linux/x64/debug/bundle/collabdoc}
OUT=${2:-target/flutter-history}
BIN=$(realpath "$BIN")
mkdir -p "$OUT"
OUT=$(realpath "$OUT")
rm -f "$OUT"/*.png "$OUT/demo.collabdoc"

export COLLABDOC_USER_DATA="$OUT/userdata" COLLABDOC_DOCUMENTS_DIR="$OUT/documents"
rm -rf "$COLLABDOC_USER_DATA" "$COLLABDOC_DOCUMENTS_DIR"
export DISPLAY=${SMOKE_DISPLAY:-:99}
export XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-$(mktemp -d)}
if ! xdpyinfo >/dev/null 2>&1; then
  Xvfb "$DISPLAY" -screen 0 1600x1000x24 >/dev/null 2>&1 &
  XVFB=$!
  trap 'kill $XVFB 2>/dev/null' EXIT
  sleep 1
fi

shot() { sleep "${2:-1}"; import -window root -crop 1500x900+0+0 +repage "$OUT/$1.png"; }

timeout 300 "$BIN" "$OUT/demo.collabdoc" >"$OUT/app.log" 2>&1 &
APP=$!
sleep 9
W=$(xdotool search --name "^CollabDoc$" | head -1)
xdotool windowmove --sync "$W" 0 0
xdotool windowsize --sync "$W" 1500 900
sleep 1

# You write a heading and a line; Peer 2 joins and adds one.
xdotool mousemove 300 200 click 1; sleep 0.3
xdotool type --delay 20 "Release plan"; sleep 0.2
xdotool key ctrl+alt+1 End Return
xdotool type --delay 20 "Ship the editor in March."; sleep 1.5
xdotool key ctrl+shift+n; sleep 1.5
xdotool key ctrl+End Return
xdotool type --delay 20 "Peer 2 adds: and the history tab."; sleep 1.5

# History (from your pane): entries per author, then a checkpoint.
xdotool mousemove 300 200 click 1; sleep 0.3
xdotool mousemove 405 17 click 1
shot 1-history 1.5
xdotool mousemove 1255 875 click 1; sleep 0.3
xdotool type --delay 20 "Draft 1"; xdotool key Return
shot 2-checkpoint 1.5

# Peer 2 rewrites your line; its entry's diff.
xdotool mousemove 700 164 click 1; sleep 0.3
xdotool key End shift+Home; sleep 0.2
xdotool type --delay 20 "Ship the editor in April, with history."; sleep 1.5
shot 3-rewritten 1.5
xdotool mousemove 1300 212 click 1
shot 4-diff 1

# View the checkpoint (read-only), then restore it.
xdotool mousemove 1190 172 click 1
shot 5-version 1.5
xdotool mousemove 468 19 click 1
shot 6-restored 2

# The gutter: who wrote each block last.
xdotool mousemove 380 17 click 1
shot 7-authors 1.5

xdotool windowclose "$W" 2>/dev/null || kill "$APP"
sleep 2
kill "$APP" 2>/dev/null || true
echo "screenshots in $OUT"
cargo run -q -p collabdoc-core --example history -- "$OUT/demo.collabdoc"
