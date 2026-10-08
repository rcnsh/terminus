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
# Each tarball is checked against the npm integrity pinned below before
# it's unpacked (scripts/vendor-lib.sh), and the files written are recorded
# in vendor/SHA256SUMS. Another version needs its integrity passed in:
#
#   scripts/vendor-preact.sh [preact-version] [htm-version]
#   PREACT_INTEGRITY=sha512-… scripts/vendor-preact.sh 10.30.0
#
# (from `npm view preact@10.30.0 dist.integrity`; HTM_INTEGRITY for htm).
# Then pin the new version and integrity here.
set -eu
cd "$(dirname "$0")/.."
. scripts/vendor-lib.sh
PREACT=${1:-10.29.8}
HTM=${2:-3.1.1}
version preact "$PREACT"
version htm "$HTM"
PREACT_SUM=$(integrity preact "$PREACT" 10.29.8 'sha512-ej2aVZ+vZ8WO7tvlQWRM9N63A0KzF9q4mWJfDUHgYaIofWY9hu74QdnQrjoPMmZi2/nZ5gN0bJCQF49xQqx09Q==' PREACT_INTEGRITY)
HTM_SUM=$(integrity htm "$HTM" 3.1.1 'sha512-983Vyg8NwUE7JkZ6NmOqpCZ+sh1bKv2iYTlUkzlWmA5JD2acKoxd4KVxbMmxX/85mtfdnDmTFoNKcg5DGAvxNQ==' HTM_INTEGRITY)
OUT=apps/web/public/vendor
DIR="$OUT/preact-$PREACT"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
P_TGZ=$(fetch preact "$PREACT" "$PREACT_SUM")
H_TGZ=$(fetch htm "$HTM" "$HTM_SUM")
mkdir -p "$WORK/p" "$WORK/h"
tar xzf "$P_TGZ" -C "$WORK/p"
tar xzf "$H_TGZ" -C "$WORK/h"
NEW="$WORK/out"
mkdir -p "$NEW"
cp "$WORK/p/package/dist/preact.module.js" "$NEW/preact.mjs"
# hooks imports "preact" by its package name, which a browser can't resolve.
sed 's/from"preact"/from".\/preact.mjs"/g' "$WORK/p/package/hooks/dist/hooks.module.js" >"$NEW/hooks.mjs"
cp "$WORK/h/package/dist/htm.module.js" "$NEW/htm.mjs"
licence "$WORK/p/package/LICENSE" "$NEW/LICENSE-preact"
licence "$WORK/h/package/LICENSE" "$NEW/LICENSE-htm"
# Source-map comments point at files not copied.
sed -i.bak '/^\/\/# sourceMappingURL=/d; s#//\# sourceMappingURL=[^ ]*$##' "$NEW"/*.mjs && rm -f "$NEW"/*.bak
if grep -q 'from"preact' "$NEW"/*.mjs; then
  die "a bare import of preact is left in $NEW"
fi
if [ -d "$DIR" ] && ! diff -rq "$DIR" "$NEW" >/dev/null; then
  die "$DIR would change under the same name, and browsers keep it a year: rename the folder (e.g. preact-$PREACT-htm-$HTM) and its paths"
fi
rm -rf "$OUT"/preact-*
mkdir -p "$DIR"
cp "$NEW"/* "$DIR"/
record preact-
du -sh "$DIR"
