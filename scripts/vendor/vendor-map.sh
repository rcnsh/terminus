#!/bin/sh
set -eu
cd "$(dirname "$0")/../.."
. scripts/vendor/vendor-lib.sh
ML=${1:-6.11.2}
PM=${2:-4.5.0}
version maplibre-gl "$ML"
version pmtiles "$PM"
ML_SUM=$(integrity maplibre-gl "$ML" 6.11.2 'sha512-Xh06pxoipjX/Ad1sUPGhiNh9go9naCNGZZ1IJm3sIeqK1kYGuMaMDSTIGDQ2igOLfVyukJU7kvEOA089VO7Z7g==' MAPLIBRE_INTEGRITY)
PM_SUM=$(integrity pmtiles "$PM" 4.5.0 'sha512-CBeD4SoUluFziGdy/8k7FOjQxQy486n+929W/tWophauvMICpkZ26vGBWhDt/6b1FZQWNaf4jFdT/5+q0Wii5w==' PMTILES_INTEGRITY)
PM_LICENCE_COMMIT=3b10e67edb65c6b04549f74c0279cef8328d859c
PM_LICENCE_URL="https://raw.githubusercontent.com/protomaps/PMTiles/$PM_LICENCE_COMMIT/LICENSE"
PM_LICENCE_SHA256=0371c38f338835f7fc13ed71176f3d92144e22c8b736a31cced57adbbeb647b3
if [ "$PM" != 4.5.0 ]; then
  PM_LICENCE_URL=${PMTILES_LICENSE_URL:?pmtiles@$PM: set PMTILES_LICENSE_URL to its LICENSE at the commit it was published from (npm view pmtiles@$PM gitHead)}
  PM_LICENCE_SHA256=${PMTILES_LICENSE_SHA256:?pmtiles@$PM: set PMTILES_LICENSE_SHA256 to the SHA-256 of that LICENSE}
fi
OUT=apps/web/public/vendor
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
ML_TGZ=$(fetch maplibre-gl "$ML" "$ML_SUM")
PM_TGZ=$(fetch pmtiles "$PM" "$PM_SUM")
PM_LICENCE=$(fetch_file "$PM_LICENCE_URL" "$PM_LICENCE_SHA256" pmtiles-LICENSE)
mkdir -p "$WORK/ml" "$WORK/pm"
tar xzf "$ML_TGZ" -C "$WORK/ml"
tar xzf "$PM_TGZ" -C "$WORK/pm"
rm -rf "$OUT/maplibre-gl@"* "$OUT/pmtiles@"*
mkdir -p "$OUT/maplibre-gl@$ML" "$OUT/pmtiles@$PM"
for f in maplibre-gl.mjs maplibre-gl-shared.mjs maplibre-gl-worker.mjs maplibre-gl.css; do
  cp "$WORK/ml/package/dist/$f" "$OUT/maplibre-gl@$ML/"
done
licence "$WORK/ml/package/LICENSE.txt" "$OUT/maplibre-gl@$ML/LICENSE.txt"
{ cat "$WORK/pm/package/dist/pmtiles.js"; printf '\nexport const { Protocol, PMTiles } = pmtiles;\n'; } >"$OUT/pmtiles@$PM/pmtiles.mjs"
licence "$PM_LICENCE" "$OUT/pmtiles@$PM/LICENSE"
sed -i.bak '/^\/\/# sourceMappingURL=/d' "$OUT/maplibre-gl@$ML"/*.mjs "$OUT/pmtiles@$PM"/*.mjs
rm -f "$OUT/maplibre-gl@$ML"/*.bak "$OUT/pmtiles@$PM"/*.bak
record maplibre-gl@ pmtiles@
du -sh "$OUT/maplibre-gl@$ML" "$OUT/pmtiles@$PM"
