#!/bin/bash
# term-shot.sh — 実Terminal.appウィンドウでコマンドを実行し screencapture -l で撮影する。
# usage: term-shot.sh <name> <out.png> <workdir> [font_size] -- <command...>
# 窓はスクリプト終了まで保持し、撮影後に解放する。秘密値は表示しない。
set -euo pipefail

NAME="$1"; OUT="$2"; DIR="$3"; FONT="${4:-20}"; shift 4
[ "${1:-}" = "--" ] && shift
TAG="DEMOSHOT_${NAME}_$$"
CAPDIR="$(cd "$(dirname "$0")" && pwd)"
WINID="$CAPDIR/bin/winid"
RUNNER="$(mktemp -t "term-shot-${NAME}-XXXX").sh"
SENT="$(mktemp -t "term-shot-wait-${NAME}-XXXX")"

{
  echo '#!/bin/bash'
  printf 'printf "\\033]0;%s\\007"\n' "$TAG"
  echo 'clear'
  printf 'cd %s\n' "$(printf '%q' "$DIR")"
  printf '%s\n' "$*"
  echo 'echo ""'
  printf 'echo "── %s ──"\n' "${NAME}"
  printf 'while [ -f %s ]; do sleep 0.3; done\n' "$(printf '%q' "$SENT")"
} > "$RUNNER"
chmod +x "$RUNNER"

osascript -e "tell application \"Terminal\" to do script \"$RUNNER\"" >/dev/null

# AppleScript側に窓名が見えるまで待つ（CG側より遅れることがある）
WIDS=""
for _ in $(seq 1 80); do
  WIDS="$("$WINID" - "$TAG" | tr '\n' ' ')"
  if [ -n "${WIDS// }" ] && osascript -e "tell application \"Terminal\" to exists (first window whose name contains \"$TAG\")" 2>/dev/null | grep -q true; then
    break
  fi
  sleep 0.5
done
if [ -z "${WIDS// }" ]; then
  echo "term-shot: window not found for $TAG" >&2
  rm -f "$SENT" "$RUNNER"
  exit 1
fi

ORIG_FONT=$(osascript <<EOF || true
tell application "Terminal"
  set w to (first window whose name contains "$TAG")
  set origFont to font size of w
  set bounds of w to {60, 40, 1660, 990}
  set font size of w to $FONT
  return origFont
end tell
EOF
)
echo "ORIG_FONT=$ORIG_FONT" >&2

sleep "${TERM_SHOT_WAIT:-2.5}"

# 複数IDが残る場合に備え、撮れるまで順に試す
SHOT_OK=0
for WID in $WIDS; do
  if screencapture -l"$WID" -o -x "$OUT" 2>/dev/null && [ -s "$OUT" ]; then
    SHOT_OK=1
    break
  fi
done
rm -f "$SENT" "$RUNNER"
[ "$SHOT_OK" = 1 ] || { echo "term-shot: screencapture failed for $TAG ($WIDS)" >&2; exit 1; }
echo "$WID"
