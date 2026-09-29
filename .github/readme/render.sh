#!/bin/sh
# Renders banner.html to banner-light.webp and banner-dark.webp for the README.
# Needs a headless Chromium (Playwright's, or set CHROME) and cwebp.
set -eu
cd "$(dirname "$0")"
CHROME="${CHROME:-$(ls -d "$HOME"/Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-*/chrome-headless-shell 2>/dev/null | tail -1)}"
page="file://$PWD/banner.html"
for theme in light dark; do
  flag=""; [ "$theme" = dark ] && flag="--blink-settings=preferredColorScheme=0"
  "$CHROME" --headless --hide-scrollbars --allow-file-access-from-files $flag \
    --window-size=1280,580 --force-device-scale-factor=2 --virtual-time-budget=5000 \
    --screenshot="$PWD/banner-$theme.png" "$page" >/dev/null 2>&1
  cwebp -quiet -q 88 "banner-$theme.png" -o "banner-$theme.webp"
  rm "banner-$theme.png"
done
ls -l banner-*.webp
