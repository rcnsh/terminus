#!/bin/sh
set -eu
cd "$(dirname "$0")/../.."
. scripts/vendor/vendor-lib.sh
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
sed 's/from"preact"/from".\/preact.mjs"/g' "$WORK/p/package/hooks/dist/hooks.module.js" >"$NEW/hooks.mjs"
cp "$WORK/h/package/dist/htm.module.js" "$NEW/htm.mjs"
licence "$WORK/p/package/LICENSE" "$NEW/LICENSE-preact"
licence "$WORK/h/package/LICENSE" "$NEW/LICENSE-htm"
sed -i.bak '/^\/\/# sourceMappingURL=/d; s#//\# sourceMappingURL=[^ ]*$##' "$NEW"/*.mjs
rm -f "$NEW"/*.bak
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
