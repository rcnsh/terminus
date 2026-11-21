#!/bin/sh
set -eu
cd "$(dirname "$0")"
CHROME="${CHROME:-$(ls -d "$HOME"/Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-*/chrome-headless-shell 2>/dev/null | tail -1)}"
data=$(node ../../scripts/loc.mjs --json | base64 | tr -d '\n')
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
for scheme in light dark; do
  "$CHROME" --headless --hide-scrollbars --allow-file-access-from-files \
    --window-size=1280,360 --force-device-scale-factor=2 --virtual-time-budget=5000 \
    --screenshot="$tmp/$scheme.png" "file://$PWD/loc.html#$scheme=$data" >/dev/null 2>&1
  cwebp -quiet -q 90 "$tmp/$scheme.png" -o "loc-$scheme.webp"
done
ls -l loc-*.webp
