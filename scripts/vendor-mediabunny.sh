#!/bin/sh
# Mediabunny, which the timelapse page (apps/web/public/admin/timelapse/)
# encodes its video with, copied from npm into apps/web/public/vendor/ and
# served from our own domain, like MapLibre (scripts/vendor-map.sh). Its
# browser build is one self-contained module. MPL-2.0: the licence goes with
# it, and the file is never edited. Re-run with a new version to update, then
# change the path in apps/web/public/admin/timelapse/timelapse.js.
#
#   scripts/vendor-mediabunny.sh [version]
set -eu
cd "$(dirname "$0")/.."
MB=${1:-1.61.3}
OUT=apps/web/public/vendor
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
(cd "$WORK" && npm pack --silent "mediabunny@$MB" >/dev/null)
mkdir -p "$WORK/mb"
tar xzf "$WORK/mediabunny-$MB.tgz" -C "$WORK/mb"
rm -rf "$OUT/mediabunny@"*
mkdir -p "$OUT/mediabunny@$MB"
cp "$WORK/mb/package/dist/bundles/mediabunny.min.mjs" "$OUT/mediabunny@$MB/"
cp "$WORK/mb/package/LICENSE" "$OUT/mediabunny@$MB/LICENSE"
# Source-map comments point at files not copied.
sed -i.bak '/^\/\/# sourceMappingURL=/d' "$OUT/mediabunny@$MB/mediabunny.min.mjs" && rm -f "$OUT/mediabunny@$MB/"*.bak
du -sh "$OUT/mediabunny@$MB"
