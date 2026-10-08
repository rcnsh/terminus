#!/bin/sh
# Renders diagram.html to the README's "How it fits together" picture,
# light and dark (diagram-light.webp, diagram-dark.webp).
# Needs a headless Chromium (Playwright's, or set CHROME) and cwebp.
set -eu
cd "$(dirname "$0")"
CHROME="${CHROME:-$(ls -d "$HOME"/Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-*/chrome-headless-shell 2>/dev/null | tail -1)}"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
for scheme in light dark; do
  "$CHROME" --headless --hide-scrollbars --allow-file-access-from-files \
    --window-size=1280,572 --force-device-scale-factor=2 --virtual-time-budget=5000 \
    --screenshot="$tmp/$scheme.png" "file://$PWD/diagram.html#$scheme" >/dev/null 2>&1
  cwebp -quiet -q 90 "$tmp/$scheme.png" -o "diagram-$scheme.webp"
done
ls -l diagram-*.webp
