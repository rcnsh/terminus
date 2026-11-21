#!/bin/sh
set -eu
cd "$(dirname "$0")"
CHROME="${CHROME:-$(ls -d "$HOME"/Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-*/chrome-headless-shell 2>/dev/null | tail -1)}"
page="file://$PWD/banner.html"
"$CHROME" --headless --hide-scrollbars --allow-file-access-from-files \
  --window-size=1280,672 --force-device-scale-factor=1 --virtual-time-budget=5000 \
  --screenshot="$PWD/../../apps/web/public/assets/og.png" "$page#og" >/dev/null 2>&1
ls -l ../../apps/web/public/assets/og.png
