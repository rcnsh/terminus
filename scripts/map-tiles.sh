#!/bin/sh
# The street map's files, onto R2 under map/ (served by apps/api/src/map.ts):
#   campus.pmtiles   the campus cut from the latest Protomaps build of
#                    OpenStreetMap, zoom 12 and up (about 3.3 MB)
#   fonts/           Noto Sans label glyphs (Regular, Medium, Italic)
#   sprites/v4/      the light and dark map icons
#
#   scripts/map-tiles.sh --dry-run          # build into ./build/map, upload nothing
#   scripts/map-tiles.sh                    # build and upload, for terminus.rcn.sh
#   CHANNEL=beta scripts/map-tiles.sh       # the same for beta.terminus.rcn.sh
#   CHANNEL=both scripts/map-tiles.sh       # both
#
# Each site reads the map from its own downloads bucket (cloudflare.config.ts).
#
# Runs from the "map tiles" workflow (Actions tab, Run workflow), or from a
# Mac signed in to Cloudflare. A couple of times a year is plenty: it only
# picks up new buildings and paths. Needs `pmtiles` on the PATH
# (brew install pmtiles); on Linux it downloads it.
# Map data (c) OpenStreetMap contributors, ODbL.
set -eu
cd "$(dirname "$0")/.."
DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1
case "${CHANNEL:-stable}" in
  stable) BUCKETS=terminus-downloads ;;
  beta) BUCKETS=terminus-beta-downloads ;;
  both) BUCKETS="terminus-downloads terminus-beta-downloads" ;;
  *) echo "CHANNEL is stable, beta or both, not $CHANNEL"; exit 1 ;;
esac
# Must match MAP_BOUNDS in apps/api/src/map.ts.
BBOX=103.755,1.280,103.830,1.332
PMTILES_VERSION=1.31.2
OUT="$PWD/build/map"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
rm -rf "$OUT"
mkdir -p "$OUT"

if ! command -v pmtiles >/dev/null 2>&1; then
  case "$(uname -s)-$(uname -m)" in
    Linux-x86_64) asset=Linux_x86_64 ;;
    Linux-aarch64) asset=Linux_arm64 ;;
    *) echo "install pmtiles first: brew install pmtiles"; exit 1 ;;
  esac
  curl -fsSL "https://github.com/protomaps/go-pmtiles/releases/download/v$PMTILES_VERSION/go-pmtiles_${PMTILES_VERSION}_$asset.tar.gz" | tar xz -C "$WORK" pmtiles
  PATH="$WORK:$PATH"
fi

# The newest daily build (they're kept about a week).
build=""
for i in 0 1 2 3 4 5 6 7 8 9 10; do
  d=$(date -u -d "-$i day" +%Y%m%d 2>/dev/null || date -u -v-"$i"d +%Y%m%d)
  if curl -fsI "https://build.protomaps.com/$d.pmtiles" >/dev/null; then build=$d; break; fi
done
[ -n "$build" ] || { echo "no Protomaps build found in the last 10 days"; exit 1; }
echo "Protomaps build $build"
# From zoom 12 up: every client's map stops zooming out at 13 (with
# 512-pixel tiles, one level of tile per level of map), so the world-wide
# levels below were a quarter of the file, downloaded by every phone and Mac
# for offline use and never drawn. 12 is a level to spare.
pmtiles extract "https://build.protomaps.com/$build.pmtiles" "$OUT/campus.pmtiles" --bbox="$BBOX" --minzoom=12
pmtiles verify "$OUT/campus.pmtiles"
size=$(wc -c <"$OUT/campus.pmtiles" | tr -d ' ')
# About 3.3 MB; far off that and the cut went wrong.
if [ "$size" -lt 1000000 ] || [ "$size" -gt 20000000 ]; then
  echo "campus.pmtiles is $size bytes; not uploading"; exit 1
fi

# Fonts and icons, from Protomaps' assets repository.
git clone -q --depth 1 --filter=blob:none --sparse https://github.com/protomaps/basemaps-assets "$WORK/assets"
git -C "$WORK/assets" sparse-checkout set --no-cone "/fonts/Noto Sans Regular/" "/fonts/Noto Sans Medium/" "/fonts/Noto Sans Italic/" "/sprites/v4/light*" "/sprites/v4/dark*"
mkdir -p "$OUT/sprites/v4"
cp -R "$WORK/assets/fonts" "$OUT/fonts"
cp "$WORK/assets/sprites/v4/"light* "$WORK/assets/sprites/v4/"dark* "$OUT/sprites/v4/"
echo "assets at basemaps-assets $(git -C "$WORK/assets" rev-parse --short HEAD)"
for f in "Noto Sans Regular" "Noto Sans Medium" "Noto Sans Italic"; do
  n=$(find "$OUT/fonts/$f" -name '*.pbf' | wc -l | tr -d ' ')
  [ "$n" -eq 256 ] || { echo "$f has $n glyph files, expected 256"; exit 1; }
done

if [ $DRY -eq 1 ]; then
  echo "dry run: built into $OUT ($size bytes of tiles), uploaded nothing"
  exit 0
fi

# Wrangler, not `cf r2 objects put`: cf 1.0.0-beta.5 percent-encodes the
# slashes in the key, which R2 needs literal. It's installed in apps/api, so
# run from there, as release.sh does. Eight at a time.
cd apps/api
export OUT
for BUCKET in $BUCKETS; do
  export BUCKET
  find "$OUT/fonts" "$OUT/sprites" -type f -print0 |
    xargs -0 -P 8 -I{} sh -c '
      file="$1"; key="map/${file#"$OUT"/}"
      case "$file" in *.pbf) t=application/x-protobuf ;; *.png) t=image/png ;; *) t=application/json ;; esac
      pnpm exec wrangler r2 object put "$BUCKET/$key" --file "$file" --content-type "$t" --remote >/dev/null || { echo "failed: $key"; exit 255; }
    ' _ {}
  # The tiles last, once everything they need is there.
  pnpm exec wrangler r2 object put "$BUCKET/map/campus.pmtiles" --file "$OUT/campus.pmtiles" --content-type application/vnd.pmtiles --remote >/dev/null
  echo "uploaded the map (build $build, $size bytes) and its fonts and icons to $BUCKET"
done
