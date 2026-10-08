#!/bin/sh
# Mediabunny, which the timelapse page (apps/web/public/admin/timelapse/)
# encodes its video with, copied from npm into apps/web/public/vendor/ and
# served from our own domain, like MapLibre (scripts/vendor-map.sh). Its
# browser build is one self-contained module. MPL-2.0: the licence goes with
# it, and the file is never edited. Re-run with a new version to update, then
# change the path in apps/web/public/admin/timelapse/timelapse.js.
#
# The tarball is checked against the npm integrity pinned below before it's
# unpacked (scripts/vendor-lib.sh), and the files written are recorded in
# vendor/SHA256SUMS. Another version needs its integrity passed in:
#
#   scripts/vendor-mediabunny.sh [version]
#   MEDIABUNNY_INTEGRITY=sha512-… scripts/vendor-mediabunny.sh 1.62.0
#
# (from `npm view mediabunny@1.62.0 dist.integrity`). Then pin the new
# version and integrity here.
set -eu
cd "$(dirname "$0")/.."
. scripts/vendor-lib.sh
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
# Source-map comments point at files not copied.
sed -i.bak '/^\/\/# sourceMappingURL=/d' "$OUT/mediabunny@$MB/mediabunny.min.mjs" && rm -f "$OUT/mediabunny@$MB/"*.bak
record mediabunny@
du -sh "$OUT/mediabunny@$MB"
