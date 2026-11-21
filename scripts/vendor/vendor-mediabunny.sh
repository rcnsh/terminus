#!/bin/sh
set -eu
cd "$(dirname "$0")/../.."
. scripts/vendor/vendor-lib.sh
MB=${1:-1.61.3}
version mediabunny "$MB"
MB_SUM=$(integrity mediabunny "$MB" 1.61.3 'sha512-kUqLKVXQVwHR62GkOJxYosAmXERJbqnXBgJDTtRlxHEYviVkMg/Evhl9XN6kedqS5LP1tV4kFKyzY/V4a4ofow==' MEDIABUNNY_INTEGRITY)
OUT=apps/web/public/vendor
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
MB_TGZ=$(fetch mediabunny "$MB" "$MB_SUM")
mkdir -p "$WORK/mb"
tar xzf "$MB_TGZ" -C "$WORK/mb"
rm -rf "$OUT/mediabunny@"*
mkdir -p "$OUT/mediabunny@$MB"
cp "$WORK/mb/package/dist/bundles/mediabunny.min.mjs" "$OUT/mediabunny@$MB/"
licence "$WORK/mb/package/LICENSE" "$OUT/mediabunny@$MB/LICENSE"
sed -i.bak '/^\/\/# sourceMappingURL=/d' "$OUT/mediabunny@$MB/mediabunny.min.mjs"
rm -f "$OUT/mediabunny@$MB/"*.bak
record mediabunny@
du -sh "$OUT/mediabunny@$MB"
