#!/usr/bin/env bash
# Phase 3 on the Flutter build: opens a Markdown file with a Mermaid diagram,
# a PNG and an SVG image (as data URIs), an infographic and a hard break;
# selects an image and sets its width and alignment; types a hard break and
# an @mention; inserts a diagram and edits its source. Screenshots, then the
# saved draft's blocks. Needs Xvfb, xdotool and ImageMagick.
#
#   scripts/flutter-figures.sh [bundle/collabdoc] [out-dir]
set -euo pipefail
BIN=${1:-flutter_app/build/linux/x64/debug/bundle/collabdoc}
OUT=${2:-target/flutter-figures}
BIN=$(realpath "$BIN")
mkdir -p "$OUT"
OUT=$(realpath "$OUT")
rm -f "$OUT"/*.png

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

PNG=$(convert -size 360x180 gradient:'#c45c26'-'#7aa2f7' -pointsize 28 \
  -fill white -gravity center -annotate 0 'PNG asset' png:- | base64 -w0)
SVG=$(printf '%s' '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="120"><rect width="240" height="120" rx="16" fill="#1f6feb"/><circle cx="60" cy="60" r="34" fill="#ffd33d"/><text x="110" y="70" font-size="26" font-family="sans-serif" fill="white">SVG</text></svg>' | base64 -w0)
cat >"$OUT/figures.md" <<MD
# Figures

A paragraph with a hard break  
on its second line.

\`\`\`mermaid caption="Review flow"
flowchart LR
  A[Write] --> B[Review]
  B --> C[Publish]
\`\`\`

![A gradient](data:image/png;base64,$PNG "An image asset")

![An SVG](data:image/svg+xml;base64,$SVG "An SVG image")

\`\`\`infographic
infographic list-row-simple-horizontal-arrow
data
  lists
    - label Step 1
\`\`\`

Last line.
MD

shot() { sleep "${2:-1}"; import -window root -crop 1100x1000+0+0 +repage "$OUT/$1.png"; }

timeout 180 "$BIN" "$OUT/figures.md" >"$OUT/app.log" 2>&1 &
APP=$!
sleep 9
W=$(xdotool search --name "^CollabDoc$" | head -1)
xdotool windowmove --sync "$W" 0 0
xdotool windowsize --sync "$W" 1100 1000
shot 1-figures 2

# Selecting the image shows its bar: half width, right-aligned.
xdotool mousemove 548 380 click 1
shot 2-selected
xdotool mousemove 484 299 click 1; sleep 0.8
xdotool mousemove 744 299 click 1
shot 3-width-align

# Shift+Enter breaks the line; @ picks someone to mention.
xdotool mousemove 300 101 click 1; sleep 0.3
xdotool key ctrl+End; sleep 0.2
xdotool key shift+Return
xdotool type --delay 30 "Ask "; sleep 0.2
xdotool type --delay 30 "@"
shot 4-picker 1.2
xdotool mousemove 454 519 click 1; sleep 0.8
xdotool type --delay 30 "to review the flow."; sleep 0.3
xdotool key Return; sleep 0.2

# Ctrl+Alt+M inserts a diagram (selected, with its bar); Source… edits it.
xdotool key ctrl+alt+m
shot 5-mention-and-diagram 2.5
xdotool mousemove 398 709 click 1; sleep 1
xdotool key ctrl+a
xdotool type --delay 10 'sequenceDiagram'; xdotool key Return
xdotool type --delay 10 '  Alice->>Bob: Review this?'; xdotool key Return
xdotool type --delay 10 '  Bob-->>Alice: Looks good'; sleep 0.3
xdotool key Tab Tab Return
shot 6-source-edited 2.5

# Closing the window writes the draft.
xdotool windowclose "$W" 2>/dev/null || kill "$APP"
sleep 2
kill "$APP" 2>/dev/null || true
echo "screenshots in $OUT"
for draft in "$COLLABDOC_USER_DATA"/drafts/*.collabdoc; do
  cargo run -q -p collabdoc-core --example dump -- "$draft"
done
