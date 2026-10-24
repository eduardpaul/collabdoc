#!/usr/bin/env bash
# Kills the Flutter app (SIGKILL) in the middle of typing, starts it again on
# the same file, and reports what was lost: spec 23's Phase 2 bar is "a
# crash in the middle of typing loses ≤ 1 s". Needs Xvfb, xdotool and a built
# bundle (release by default).
#
#   scripts/flutter-crash.sh [bundle/collabdoc] [out-dir]
set -euo pipefail
BIN=$(realpath "${1:-flutter_app/build/linux/x64/release/bundle/collabdoc}")
OUT=${2:-target/flutter-crash}
mkdir -p "$OUT"
OUT=$(realpath "$OUT")
export COLLABDOC_USER_DATA="$OUT/userdata" COLLABDOC_DOCUMENTS_DIR="$OUT/documents"
rm -rf "$COLLABDOC_USER_DATA" "$COLLABDOC_DOCUMENTS_DIR" "$OUT/typed.log"
mkdir -p "$COLLABDOC_DOCUMENTS_DIR"
FILE="$COLLABDOC_DOCUMENTS_DIR/crash.collabdoc"
export DISPLAY=${SMOKE_DISPLAY:-:99}
export XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-$(mktemp -d)}
DELAY_MS=40
TYPE_FOR=${TYPE_FOR:-8}

window() {
  local w
  w=$(xdotool search --name "^CollabDoc$" | head -1)
  xdotool windowmove --sync "$w" 0 0
  xdotool windowsize --sync "$w" 1400 760
  xdotool windowfocus --sync "$w"
}
text_of() {
  cargo run -q --release -p collabdoc-core --example dump -- "$1" 2>/dev/null \
    | sed -n 's/^Paragraph "\(.*\)" spans=.*/\1/p' | tr -d '\n'
}

"$BIN" "$FILE" >/dev/null 2>&1 &
APP=$!
sleep 7
window
xdotool mousemove 500 200 click 1
sleep 0.5
# Type word by word, logging each word once xdotool has sent it.
(
  for i in $(seq 1 400); do
    word="w$i"
    xdotool type --delay "$DELAY_MS" "$word "
    printf '%s ' "$word" >> "$OUT/typed.log"
  done
) &
TYPER=$!
sleep "$TYPE_FOR"
kill -9 "$APP"
KILLED_AT=$(date +%s.%N)
kill "$TYPER" 2>/dev/null || true
wait 2>/dev/null || true
typed=$(cat "$OUT/typed.log")
on_disk=$(text_of "$FILE")

# Start again on the same file: the journal replays, autosave writes it.
"$BIN" "$FILE" >/dev/null 2>&1 &
APP=$!
sleep 8
kill "$APP"
wait 2>/dev/null || true
recovered=$(text_of "$FILE")

typed_n=${#typed}
disk_n=${#on_disk}
rec_n=${#recovered}
lost=$(( typed_n > rec_n ? typed_n - rec_n : 0 ))
echo "typed for ${TYPE_FOR}s at ${DELAY_MS} ms a key: ${typed_n} characters logged"
echo "in the file when the app was killed (autosave alone): ${disk_n} characters"
echo "after restarting (file + journal):                   ${rec_n} characters"
awk -v lost="$lost" -v ms="$DELAY_MS" 'BEGIN { printf "lost: %d characters ≈ %.2f s of typing\n", lost, lost * ms / 1000 }'
case "$recovered" in
  "${typed% }"*) echo "recovered text starts with everything logged: OK" ;;
  *) echo "recovered text differs from the log"; exit 1 ;;
esac
