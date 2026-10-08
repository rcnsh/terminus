#!/bin/sh
# MapLibre Native for the Mac app's map, built from source and kept in the
# repo as apps/macos/Vendor/MapLibre.xcframework.zip (a SwiftPM binaryTarget).
# No macOS build is published, so this builds one: Metal, on the main run
# loop, arm64 and x86_64. It takes a while the first time (Bazel).
#
#   scripts/vendor-maplibre-mac.sh [checkout]
#
# The checkout defaults to ~/dev/vendor/maplibre-native, cloned if missing.
# Bazel gives an iOS-style flat framework; macOS wants the versioned layout
# (Versions/A, Resources/Info.plist) to sign and load it, so it's repacked.
#
# The tag is pinned to its commit (the peeled ios-v6.31.0^{}), so a tag
# moved upstream stops the build instead of changing what's built. A new
# version: change both, from
#   git ls-remote https://github.com/maplibre/maplibre-native 'refs/tags/<tag>^{}'
#
# Afterwards it writes the zip's SHA-256 to MapLibre.xcframework.zip.sha256,
# which CI checks, and prints the tag, commit and hash for the commit
# message. The build isn't reproducible (Bazel, Xcode and the toolchain all
# leave their mark), so the hash records what was committed; it doesn't
# prove which source it came from. The tag and commit say that.
set -eu
cd "$(dirname "$0")/.."
TAG=ios-v6.31.0
COMMIT=01791ad02c1bfe3b22c42a97619b972aba962f82
SRC=${1:-$HOME/dev/vendor/maplibre-native}
OUT=apps/macos/Vendor/MapLibre.xcframework.zip

if [ ! -d "$SRC" ]; then
  git clone --recurse-submodules --branch "$TAG" --depth 1 https://github.com/maplibre/maplibre-native "$SRC"
else
  (cd "$SRC" && git fetch --depth 1 origin tag "$TAG" && git checkout -q --detach "refs/tags/$TAG" &&
    git submodule update --init --recursive)
fi
HEAD=$(git -C "$SRC" rev-parse HEAD)
if [ "$HEAD" != "$COMMIT" ]; then
  echo "$SRC is at $HEAD, not $TAG's pinned commit $COMMIT: the tag moved, or the checkout is elsewhere" >&2
  exit 1
fi
# Untracked and changed files count, in the submodules too: only the tag's own source is built.
DIRTY=$(git -C "$SRC" status --porcelain --ignore-submodules=none)
if [ -n "$DIRTY" ]; then
  echo "$SRC has local changes; build from a clean checkout of $TAG:" >&2
  printf '%s\n' "$DIRTY" >&2
  exit 1
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
(cd "$(dirname "$OUT")" && shasum -a 256 "$(basename "$OUT")" > "$(basename "$OUT").sha256")
SUM=$(cut -d' ' -f1 "$OUT.sha256")
echo "wrote $OUT ($(du -h "$OUT" | cut -f1)) and $OUT.sha256"
echo "MapLibre Native $TAG, commit $COMMIT, zip sha256 $SUM"
