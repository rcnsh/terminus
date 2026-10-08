#!/bin/sh
# The street map's files, onto R2 under map/ (served by apps/api/src/map.ts):
#   campus.pmtiles   the campus cut from a Protomaps daily build of
#                    OpenStreetMap, zoom 12 and up (about 3.3 MB)
#   fonts/           Noto Sans label glyphs (Regular, Medium, Italic)
#   sprites/v4/      the light and dark map icons
#
# What goes up is pinned in scripts/map-tiles.lock: the Protomaps build, the
# basemaps-assets commit, and the SHA-256 of the cut and of every font and
# icon file. Every client's MapLibre parses these files, so nothing reaches
# R2 unless it matches the lock, and a new map is a commit someone reviewed.
#
#   scripts/map-tiles.sh --check      # is there a newer build than the lock's?
#   scripts/map-tiles.sh --update     # cut the newest build, rewrite the lock
#   scripts/map-tiles.sh --dry-run    # build the locked files into ./build/map
#   scripts/map-tiles.sh              # build, check against the lock, upload
#   scripts/map-tiles.sh --upload     # upload ./build/map as it is, once it
#                                     # matches the lock (no downloads)
#   CHANNEL=beta scripts/map-tiles.sh # the same for beta.terminus.rcn.sh
#   CHANNEL=both scripts/map-tiles.sh # both
#
# To refresh the map: --update, commit the lock, then upload (here or from
# the "map tiles" workflow). Protomaps keeps its daily builds only about a
# week, so upload within a few days of the update; once the lock's build is
# gone, run --update again. To move the fonts and icons on, run
#   ASSETS_COMMIT=<sha> scripts/map-tiles.sh --update
# with a commit from
#   git ls-remote https://github.com/protomaps/basemaps-assets HEAD
# The fonts and icons keep their paths, and the edge and browsers keep them
# for 30 days (map.ts, edgeFile), so a changed font or icon isn't seen until
# then: purge the zone's cache after uploading one, or move the icons to a
# new folder (sprites/v5, with SPRITES in map.ts).
#
# Each site reads the map from its own downloads bucket (cloudflare.config.ts).
# A couple of times a year is plenty: it only picks up new buildings and
# paths. Uses `pmtiles` from the PATH if it's PMTILES_VERSION (the cut must
# come out byte for byte the same); otherwise, on Linux or an Apple silicon
# Mac, it downloads that release and checks its hash.
# Map data (c) OpenStreetMap contributors, ODbL.
set -eu
cd "$(dirname "$0")/.."
MODE=upload
case "${1:-}" in
  "") ;;
  --dry-run) MODE=dry ;;
  --update) MODE=update ;;
  --check) MODE=check ;;
  --upload) MODE=upload-built ;;
  *) echo "usage: scripts/map-tiles.sh [--check | --update | --dry-run | --upload]"; exit 1 ;;
esac
case "${CHANNEL:-stable}" in
  stable) BUCKETS=terminus-downloads ;;
  beta) BUCKETS=terminus-beta-downloads ;;
  both) BUCKETS="terminus-downloads terminus-beta-downloads" ;;
  *) echo "CHANNEL is stable, beta or both, not $CHANNEL"; exit 1 ;;
esac
# Must match MAP_BOUNDS in apps/api/src/map.ts.
BBOX=103.755,1.280,103.830,1.332
# From zoom 12 up: every client's map stops zooming out at 13 (with
# 512-pixel tiles, one level of tile per level of map), so the world-wide
# levels below were a quarter of the file, downloaded by every phone and Mac
# for offline use and never drawn. 12 is a level to spare.
MINZOOM=12
PMTILES_VERSION=1.31.2
LOCK=scripts/map-tiles.lock
OUT="$PWD/build/map"

sha256() { (sha256sum "$@" 2>/dev/null || shasum -a 256 "$@") | cut -d' ' -f1; }
# One value from the lock (key=value lines; # starts a comment).
locked() { sed -n "s/^$1=//p" "$LOCK"; }

# The newest daily build in the last ten days.
newest_build() {
  for i in 0 1 2 3 4 5 6 7 8 9 10; do
    d=$(date -u -d "-$i day" +%Y%m%d 2>/dev/null || date -u -v-"$i"d +%Y%m%d)
    if curl -fsI "https://build.protomaps.com/$d.pmtiles" >/dev/null; then echo "$d"; return; fi
  done
  echo "no Protomaps build found in the last 10 days" >&2; return 1
}

if [ "$MODE" = check ]; then
  [ -f "$LOCK" ] || { echo "no $LOCK: run scripts/map-tiles.sh --update and commit it"; exit 1; }
  have=$(locked build)
  latest=$(newest_build)
  if [ "$latest" -gt "$have" ]; then
    echo "Protomaps build $latest is newer than the lock's $have."
    echo "To refresh the map: scripts/map-tiles.sh --update, review and commit $LOCK,"
    echo "then upload (scripts/map-tiles.sh, or run the map tiles workflow) within a few days."
    exit 1
  fi
  echo "the lock's build $have is the newest"
  exit 0
fi

# Hashes of what's in $OUT, the way the lock records them: the cut's
# SHA-256 and size, and one SHA-256 over the sorted "<sha256>  <path>"
# lines of every font and icon file (paths relative to $OUT).
hash_out() {
  got_pmtiles_sha256=$(sha256 "$OUT/campus.pmtiles")
  got_pmtiles_bytes=$(wc -c <"$OUT/campus.pmtiles" | tr -d ' ')
  list=$(cd "$OUT" && find fonts sprites -type f | LC_ALL=C sort | tr '\n' '\0' |
    xargs -0 sh -c 'sha256sum "$@" 2>/dev/null || shasum -a 256 "$@"' _)
  got_assets_files=$(printf '%s\n' "$list" | wc -l | tr -d ' ')
  got_assets_sha256=$(printf '%s\n' "$list" | (sha256sum 2>/dev/null || shasum -a 256) | cut -d' ' -f1)
}

# Refuses unless $OUT and the settings above are exactly what the lock pins.
verify_out() {
  hash_out
  bad=0
  for k in bbox:"$BBOX" minzoom:"$MINZOOM" pmtiles_version:"$PMTILES_VERSION" \
    build:"$build" assets_commit:"$ASSETS_COMMIT" \
    pmtiles_sha256:"$got_pmtiles_sha256" pmtiles_bytes:"$got_pmtiles_bytes" \
    assets_files:"$got_assets_files" assets_sha256:"$got_assets_sha256"; do
    key=${k%%:*}; val=${k#*:}
    want=$(locked "$key")
    [ "$val" = "$want" ] || { echo "$key is $val, the lock says $want"; bad=1; }
  done
  [ $bad -eq 0 ] || { echo "not what $LOCK pins; uploading nothing (scripts/map-tiles.sh --update to take a new map)"; exit 1; }
  echo "matches $LOCK: build $build, $got_pmtiles_bytes bytes of tiles, $got_assets_files font and icon files"
}

upload() {
  # Wrangler, not `cf r2 objects put`: cf 1.0.0-beta.5 percent-encodes the
  # slashes in the key, which R2 needs literal. It's installed in apps/api,
  # so run from there, as release.sh does. Eight at a time.
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
    echo "uploaded the map (build $build, $got_pmtiles_bytes bytes) and its fonts and icons to $BUCKET"
  done
}

[ "$MODE" = update ] || [ -f "$LOCK" ] || { echo "no $LOCK: run scripts/map-tiles.sh --update and commit it"; exit 1; }

# The files built by an earlier --dry-run (the workflow builds in one step,
# without the token, and uploads in the next, with it).
if [ "$MODE" = upload-built ]; then
  [ -f "$OUT/campus.pmtiles" ] || { echo "nothing in $OUT: run scripts/map-tiles.sh --dry-run first"; exit 1; }
  build=$(locked build); ASSETS_COMMIT=$(locked assets_commit)
  verify_out
  upload
  exit 0
fi

if [ "$MODE" = update ]; then
  build=$(newest_build)
  # Fonts and icons stay where the lock has them unless asked to move.
  if [ -z "${ASSETS_COMMIT:-}" ]; then
    [ -f "$LOCK" ] || { echo "no $LOCK yet: give ASSETS_COMMIT=<basemaps-assets commit>"; exit 1; }
    ASSETS_COMMIT=$(locked assets_commit)
  fi
  case "$ASSETS_COMMIT" in
    *[!0-9a-f]*|"") echo "ASSETS_COMMIT must be a full commit hash"; exit 1 ;;
  esac
  [ ${#ASSETS_COMMIT} -eq 40 ] || { echo "ASSETS_COMMIT must be a full 40-character commit hash"; exit 1; }
else
  build=$(locked build)
  ASSETS_COMMIT=$(locked assets_commit)
  if ! curl -fsI "https://build.protomaps.com/$build.pmtiles" >/dev/null; then
    echo "Protomaps build $build is gone (they're kept about a week)."
    echo "R2 still has what was uploaded. For a new map: scripts/map-tiles.sh --update, then commit $LOCK."
    exit 1
  fi
fi
echo "Protomaps build $build, basemaps-assets $ASSETS_COMMIT"

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
rm -rf "$OUT"
mkdir -p "$OUT"

# The pinned pmtiles: another version may cut the same tiles into a file
# with other bytes, which the lock would refuse.
if ! command -v pmtiles >/dev/null 2>&1 ||
  ! pmtiles version 2>/dev/null | grep -q "^pmtiles $PMTILES_VERSION,"; then
  # Each file's SHA-256, as GitHub lists it on the release; a new
  # PMTILES_VERSION needs new ones.
  case "$(uname -s)-$(uname -m)" in
    Linux-x86_64) file=go-pmtiles_${PMTILES_VERSION}_Linux_x86_64.tar.gz
      sum=3ed7dbf4ec2e6dfe5e25b6f70d1ffc932729f93c86db353bf514dd71010a312f ;;
    Linux-aarch64) file=go-pmtiles_${PMTILES_VERSION}_Linux_arm64.tar.gz
      sum=f8bd47e7ea866863489cad588fbaf2f31f42e5821f7a03f009b3769f05801cb1 ;;
    Darwin-arm64) file=go-pmtiles-${PMTILES_VERSION}_Darwin_arm64.zip
      sum=40528f7f616fcbf91207cd48c8fc023d213f6d86c0cbf1f748732803d1880f3d ;;
    *) echo "install pmtiles $PMTILES_VERSION first"; exit 1 ;;
  esac
  curl -fsSL -o "$WORK/$file" "https://github.com/protomaps/go-pmtiles/releases/download/v$PMTILES_VERSION/$file"
  got=$(sha256 "$WORK/$file")
  [ "$got" = "$sum" ] || { echo "$file has SHA-256 $got, expected $sum; not running it"; exit 1; }
  mkdir "$WORK/bin"
  case "$file" in
    *.zip) unzip -q "$WORK/$file" pmtiles -d "$WORK/bin" ;;
    *) tar xzf "$WORK/$file" -C "$WORK/bin" pmtiles ;;
  esac
  PATH="$WORK/bin:$PATH"
fi

pmtiles extract "https://build.protomaps.com/$build.pmtiles" "$OUT/campus.pmtiles" --bbox="$BBOX" --minzoom="$MINZOOM"
pmtiles verify "$OUT/campus.pmtiles"
size=$(wc -c <"$OUT/campus.pmtiles" | tr -d ' ')
# About 3.3 MB; far off that and the cut went wrong.
if [ "$size" -lt 1000000 ] || [ "$size" -gt 20000000 ]; then
  echo "campus.pmtiles is $size bytes; not uploading"; exit 1
fi

# Fonts and icons, from Protomaps' assets repository.
git init -q "$WORK/assets"
git -C "$WORK/assets" sparse-checkout set --no-cone "/fonts/Noto Sans Regular/" "/fonts/Noto Sans Medium/" "/fonts/Noto Sans Italic/" "/sprites/v4/light*" "/sprites/v4/dark*"
git -C "$WORK/assets" fetch -q --depth 1 --filter=blob:none https://github.com/protomaps/basemaps-assets "$ASSETS_COMMIT"
git -C "$WORK/assets" checkout -q FETCH_HEAD
[ "$(git -C "$WORK/assets" rev-parse HEAD)" = "$ASSETS_COMMIT" ] || { echo "basemaps-assets fetched another commit than $ASSETS_COMMIT"; exit 1; }
mkdir -p "$OUT/sprites/v4"
cp -R "$WORK/assets/fonts" "$OUT/fonts"
cp "$WORK/assets/sprites/v4/"light* "$WORK/assets/sprites/v4/"dark* "$OUT/sprites/v4/"
for f in "Noto Sans Regular" "Noto Sans Medium" "Noto Sans Italic"; do
  n=$(find "$OUT/fonts/$f" -name '*.pbf' | wc -l | tr -d ' ')
  [ "$n" -eq 256 ] || { echo "$f has $n glyph files, expected 256"; exit 1; }
done

if [ "$MODE" = update ]; then
  hash_out
  cat >"$LOCK" <<EOF
# What scripts/map-tiles.sh uploads to R2. Written by --update; a normal
# run uploads nothing unless what it builds matches every line. Protomaps
# keeps a build about a week, so upload soon after committing this.
build=$build
bbox=$BBOX
minzoom=$MINZOOM
pmtiles_version=$PMTILES_VERSION
pmtiles_sha256=$got_pmtiles_sha256
pmtiles_bytes=$got_pmtiles_bytes
assets_commit=$ASSETS_COMMIT
# SHA-256 over the sorted "<sha256>  <path>" lines of every font and icon file.
assets_files=$got_assets_files
assets_sha256=$got_assets_sha256
EOF
  echo
  echo "wrote $LOCK for build $build ($got_pmtiles_bytes bytes of tiles); uploaded nothing."
  echo "The new map is in $OUT to look at. Then:"
  echo "  git diff $LOCK && git add $LOCK && git commit -m 'chore(map): street map from Protomaps build $build'"
  echo "and upload within a few days, before the build is gone:"
  echo "  scripts/map-tiles.sh   (or the map tiles workflow, after pushing)"
  exit 0
fi

verify_out
if [ "$MODE" = dry ]; then
  echo "dry run: built into $OUT, uploaded nothing"
  exit 0
fi
upload
