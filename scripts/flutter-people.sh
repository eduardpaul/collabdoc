#!/usr/bin/env bash
# Phase 5 on the Flutter build: the first launch asks a name (with handle
# and color); a document with a second participant shows each other's
# carets; the People tab lists who is here, their role and what they do;
# the peer claims a block (Ctrl+Alt+L) and your pane outlines it with
# their name. Screenshots, then the profile and the document's authors as
# stored. Needs Xvfb, xdotool and ImageMagick.
#
#   scripts/flutter-people.sh [bundle/collabdoc] [out-dir]
set -euo pipefail
BIN=${1:-flutter_app/build/linux/x64/debug/bundle/collabdoc}
OUT=${2:-target/flutter-people}
BIN=$(realpath "$BIN")
mkdir -p "$OUT"
OUT=$(realpath "$OUT")
rm -f "$OUT"/*.png

export COLLABDOC_USER_DATA="$OUT/userdata" COLLABDOC_DOCUMENTS_DIR="$OUT/documents"
rm -rf "${COLLABDOC_USER_DATA:?}" "${COLLABDOC_DOCUMENTS_DIR:?}"
export DISPLAY=${SMOKE_DISPLAY:-:99}
export XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-$(mktemp -d)}
if ! xdpyinfo >/dev/null 2>&1; then
  Xvfb "$DISPLAY" -screen 0 1600x1000x24 >/dev/null 2>&1 &
  XVFB=$!
  trap 'kill $XVFB 2>/dev/null' EXIT
  sleep 1
fi

shot() { sleep "${2:-1}"; import -window root -crop 1500x900+0+0 +repage "$OUT/$1.png"; }
# Text goes through the input method; keys right after it must wait for it.
say() { xdotool type --delay 20 "$1"; sleep 0.4; }

timeout 300 "$BIN" >"$OUT/app.log" 2>&1 &
APP=$!
sleep 9
W=$(xdotool search --name "^CollabDoc$" | head -1)
xdotool windowmove --sync "$W" 0 0
xdotool windowsize --sync "$W" 1500 900
shot 1-first-launch 1.5

# Name (the handle follows it), a color, Save.
xdotool mousemove 750 206 click 1; sleep 0.3
say "Ana Lopez"
xdotool mousemove 428 289 click 1
shot 2-profile 0.5
xdotool mousemove 411 327 click 1
shot 3-saved 1

# A document; Peer 2 joins and selects the last line.
xdotool mousemove 456 146 click 1; sleep 1.5
say "Launch notes"
xdotool key ctrl+alt+1 End Return
say "Ana drafts the intro."
xdotool key Return
say "Bo reviews the plan."
sleep 0.6
xdotool key ctrl+shift+n; sleep 1.5
xdotool key ctrl+End shift+Home
shot 4-carets 1

# People, from your pane.
xdotool mousemove 536 17 click 1
shot 5-people 1.5

# Peer 2 claims the line it selected; your pane outlines it.
xdotool mousemove 900 400 click 1; sleep 0.3
xdotool key ctrl+End shift+Home ctrl+alt+l
shot 6-claim 1.5

xdotool windowclose "$W" 2>/dev/null || kill "$APP"
sleep 2
kill "$APP" 2>/dev/null || true
echo "screenshots in $OUT"
echo "profile.json:"; cat "$COLLABDOC_USER_DATA/profile.json"; echo
