#!/bin/sh
# MapLibre GL JS and the PMTiles reader for the web app's map, copied from
# npm into apps/web/public/vendor/ and served from our own domain (no CDN:
# the site's CSP stays same-site, and the service worker keeps them for
# offline). Re-run with new versions to update, then change the paths in
# apps/web/public/app/map.js and sw.js.
#
#   scripts/vendor-map.sh [maplibre-version] [pmtiles-version]
set -eu
cd "$(dirname "$0")/.."
ML=${1:-6.11.2}
PM=${2:-4.5.0}
OUT=apps/web/public/vendor
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
(cd "$WORK" && npm pack --silent "maplibre-gl@$ML" "pmtiles@$PM" >/dev/null)
mkdir -p "$WORK/ml" "$WORK/pm"
tar xzf "$WORK/maplibre-gl-$ML.tgz" -C "$WORK/ml"
tar xzf "$WORK/pmtiles-$PM.tgz" -C "$WORK/pm"
rm -rf "$OUT/maplibre-gl@"* "$OUT/pmtiles@"*
mkdir -p "$OUT/maplibre-gl@$ML" "$OUT/pmtiles@$PM"
# The module, the code it shares with its workers, the worker, the styles.
for f in maplibre-gl.mjs maplibre-gl-shared.mjs maplibre-gl-worker.mjs maplibre-gl.css; do
  cp "$WORK/ml/package/dist/$f" "$OUT/maplibre-gl@$ML/"
done
cp "$WORK/ml/package/LICENSE.txt" "$OUT/maplibre-gl@$ML/"
# The self-contained build, made importable as a module.
{ cat "$WORK/pm/package/dist/pmtiles.js"; printf '\nexport const { Protocol, PMTiles } = pmtiles;\n'; } >"$OUT/pmtiles@$PM/pmtiles.mjs"
cp "$WORK/pm/package/LICENSE" "$OUT/pmtiles@$PM/" 2>/dev/null || true
# Source-map comments point at files not copied.
sed -i.bak '/^\/\/# sourceMappingURL=/d' "$OUT"/*/*.mjs && rm -f "$OUT"/*/*.bak
du -sh "$OUT"/*
