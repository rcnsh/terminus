#!/bin/sh
# Renders banner.html to the site's link preview image
# (apps/web/public/assets/og.png). The README's pictures come from the real
# site instead (node .github/readme/shots.mjs), and its banner from hero.html
# (node .github/readme/hero.mjs).
# Needs a headless Chromium (Playwright's, or set CHROME).
set -eu
cd "$(dirname "$0")"
CHROME="${CHROME:-$(ls -d "$HOME"/Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-*/chrome-headless-shell 2>/dev/null | tail -1)}"
page="file://$PWD/banner.html"
"$CHROME" --headless --hide-scrollbars --allow-file-access-from-files \
  --window-size=1280,672 --force-device-scale-factor=1 --virtual-time-budget=5000 \
  --screenshot="$PWD/../../apps/web/public/assets/og.png" "$page#og" >/dev/null 2>&1
ls -l ../../apps/web/public/assets/og.png
