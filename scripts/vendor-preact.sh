#!/bin/sh
# Preact, its hooks and htm for the website's pages, copied from npm into
# apps/web/public/vendor/ and served from our own domain (no CDN, no build:
# the site's CSP stays same-site, and the service worker keeps them for
# offline). htm turns tagged templates into Preact elements without eval, so
# the CSP needs no 'unsafe-eval'. Re-run with new versions to update, then
# change the path in apps/web/public/assets/ui.js and sw.js.
#
# The folder has no "@" in its name, unlike the map's: Cloudflare's static
# assets redirect "@" to "%40", a round trip per module import.
#
# Browsers keep /vendor/ for a year without asking (_headers), so a folder's
# files must never change under the same name: a new htm with the same
# Preact is refused here.
#
#   scripts/vendor-preact.sh [preact-version] [htm-version]
set -eu
cd "$(dirname "$0")/.."
PREACT=${1:-10.29.8}
HTM=${2:-3.1.1}
OUT=apps/web/public/vendor
DIR="$OUT/preact-$PREACT"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
(cd "$WORK" && npm pack --silent "preact@$PREACT" "htm@$HTM" >/dev/null)
mkdir -p "$WORK/p" "$WORK/h"
tar xzf "$WORK/preact-$PREACT.tgz" -C "$WORK/p"
tar xzf "$WORK/htm-$HTM.tgz" -C "$WORK/h"
NEW="$WORK/out"
mkdir -p "$NEW"
cp "$WORK/p/package/dist/preact.module.js" "$NEW/preact.mjs"
# hooks imports "preact" by its package name, which a browser can't resolve.
sed 's/from"preact"/from".\/preact.mjs"/g' "$WORK/p/package/hooks/dist/hooks.module.js" >"$NEW/hooks.mjs"
cp "$WORK/h/package/dist/htm.module.js" "$NEW/htm.mjs"
cp "$WORK/p/package/LICENSE" "$NEW/LICENSE-preact"
cp "$WORK/h/package/LICENSE" "$NEW/LICENSE-htm" 2>/dev/null || true
# Source-map comments point at files not copied.
sed -i.bak '/^\/\/# sourceMappingURL=/d; s#//\# sourceMappingURL=[^ ]*$##' "$NEW"/*.mjs && rm -f "$NEW"/*.bak
if grep -q 'from"preact' "$NEW"/*.mjs; then
  echo "a bare import of preact is left in $NEW" >&2
  exit 1
fi
if [ -d "$DIR" ] && ! diff -rq "$DIR" "$NEW" >/dev/null; then
  echo "$DIR would change under the same name, and browsers keep it a year: rename the folder (e.g. preact-$PREACT-htm-$HTM) and its paths" >&2
  exit 1
fi
rm -rf "$OUT"/preact-*
mkdir -p "$DIR"
cp "$NEW"/* "$DIR"/
du -sh "$DIR"
