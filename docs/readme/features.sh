#!/bin/sh
# Renders clients.html and knows.html to the README's "On your phone, your
# Mac and the web" and "What it knows" pictures, light and dark
# (clients-light.webp, clients-dark.webp, knows-light.webp, knows-dark.webp),
# on a transparent background. Run shots.mjs first when the app's
# screenshots change; this only lays them out.
# Needs a headless Chromium (Playwright's, or set CHROME) and cwebp.
set -eu
cd "$(dirname "$0")"
CHROME="${CHROME:-$(ls -d "$HOME"/Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-*/chrome-headless-shell 2>/dev/null | tail -1)}"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
# Each page's size, as its body sets it.
for page in clients:1100,764 knows:1100,268; do
  name=${page%%:*}
  for scheme in light dark; do
    "$CHROME" --headless --hide-scrollbars --allow-file-access-from-files --default-background-color=00000000 \
      --window-size="${page#*:}" --force-device-scale-factor=2 --virtual-time-budget=10000 \
      --screenshot="$tmp/$name-$scheme.png" "file://$PWD/$name.html#$scheme" >/dev/null 2>&1
    cwebp -quiet -q 90 -alpha_q 100 "$tmp/$name-$scheme.png" -o "$name-$scheme.webp"
  done
done
ls -l clients-*.webp knows-*.webp
