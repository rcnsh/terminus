#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
VERSION=6.31.0
SHA256=de3aaa435dd86768b06d90245e630d068dd7eef1491afae7217d1654c52c462a
URL="https://github.com/maplibre/maplibre-native/releases/download/ios-v$VERSION/MapLibre.dynamic.xcframework.zip"
OUT=Vendor/MapLibre.xcframework
if [ -f "$OUT/.version" ] && [ "$(cat "$OUT/.version")" = "$VERSION" ]; then exit 0; fi
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
curl -fsSL "$URL" -o "$TMP/maplibre.zip"
echo "$SHA256  $TMP/maplibre.zip" | shasum -a 256 -c - >/dev/null
mkdir -p "$TMP/x"
unzip -q "$TMP/maplibre.zip" -d "$TMP/x"
rm -rf "$OUT"
mkdir -p Vendor
mv "$TMP/x/MapLibre.xcframework" "$OUT"
echo "$VERSION" > "$OUT/.version"
echo "MapLibre $VERSION in $OUT"
