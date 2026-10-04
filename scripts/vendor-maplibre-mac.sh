#!/bin/sh
# MapLibre Native for the Mac app's map, built from source and kept in the
# repo as apps/macos/Vendor/MapLibre.xcframework.zip (a SwiftPM binaryTarget).
# No macOS build is published, so this builds one: Metal, on the main run
# loop, arm64 and x86_64. It takes a while the first time (Bazel).
#
#   scripts/vendor-maplibre-mac.sh [tag] [checkout]
#
# The checkout defaults to ~/dev/vendor/maplibre-native, cloned if missing.
# Bazel gives an iOS-style flat framework; macOS wants the versioned layout
# (Versions/A, Resources/Info.plist) to sign and load it, so it's repacked.
set -eu
cd "$(dirname "$0")/.."
TAG=${1:-ios-v6.31.0}
SRC=${2:-$HOME/dev/vendor/maplibre-native}
OUT=apps/macos/Vendor/MapLibre.xcframework.zip

if [ ! -d "$SRC" ]; then
  git clone --recurse-submodules --branch "$TAG" --depth 1 https://github.com/maplibre/maplibre-native "$SRC"
fi
(cd "$SRC" && bazelisk build //platform/macos:MapLibre.dynamic \
  --//:renderer=metal --//platform/macos:macos_loop=cfrunloop --compilation_mode=opt)

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
unzip -q "$SRC/bazel-bin/platform/macos/MapLibre.dynamic.xcframework.zip" -d "$WORK/in"
FLAT=$(find "$WORK/in" -name MapLibre.framework -type d | head -1)
XC="$WORK/out/MapLibre.xcframework"
SLICE=$(basename "$(dirname "$FLAT")")
FW="$XC/$SLICE/MapLibre.framework"
mkdir -p "$FW/Versions/A/Resources"
cp "$WORK/in/MapLibre.xcframework/Info.plist" "$XC/Info.plist"
cp "$FLAT/MapLibre" "$FW/Versions/A/MapLibre"
cp -R "$FLAT/Headers" "$FLAT/Modules" "$FW/Versions/A/"
cp "$FLAT/Info.plist" "$FW/Versions/A/Resources/Info.plist"
# Only the languages the app speaks; MapLibre's strings are its accessibility labels.
for l in Base en zh-Hans; do
  [ -d "$FLAT/$l.lproj" ] && cp -R "$FLAT/$l.lproj" "$FW/Versions/A/Resources/"
done
cp "$FLAT"/*.pdf "$FW/Versions/A/Resources/" 2>/dev/null || true
cp "$SRC/LICENSE.md" "$SRC/LICENSES.core.md" "$FW/Versions/A/Resources/"
ln -s A "$FW/Versions/Current"
for f in MapLibre Headers Modules Resources; do ln -s "Versions/Current/$f" "$FW/$f"; done

mkdir -p "$(dirname "$OUT")"
rm -f "$OUT"
# --keepParent: the zip holds MapLibre.xcframework/, as SwiftPM expects; ditto keeps the symlinks.
xattr -cr "$XC"
ditto -c -k --norsrc --noextattr --noqtn --keepParent "$XC" "$OUT"
echo "wrote $OUT ($(du -h "$OUT" | cut -f1)) from MapLibre Native $TAG"
