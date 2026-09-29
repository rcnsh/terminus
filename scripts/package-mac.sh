#!/bin/sh
# Build, sign and package the Mac app as build/release/<version>/terminus-<version>.dmg:
# a disk image holding terminus.app and an Applications shortcut to drag it onto.
#
#   SIGN_IDENTITY=<certificate SHA-1> SIGN_KEYCHAIN=<keychain> scripts/package-mac.sh
#
# The release workflow (.github/workflows/release.yml) runs this with the
# terminus self-signed certificate. That certificate is not trusted by macOS
# and the app is not notarised, so Gatekeeper still asks on first open; what
# the signature buys is the same code identity on every version, so macOS
# keeps the app's location permission and login item across updates.
# Without SIGN_IDENTITY it signs ad-hoc, for trying the packaging locally.
set -eu
cd "$(dirname "$0")/.."
ROOT=$(pwd)

VERSION=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' apps/macos/Support/Info.plist)
OUT="$ROOT/build/release/$VERSION"
DMG="$OUT/terminus-$VERSION.dmg"
mkdir -p "$OUT"
KC_ARGS=""
[ -n "${SIGN_KEYCHAIN:-}" ] && KC_ARGS="--keychain $SIGN_KEYCHAIN"

echo "== mac $VERSION"
(cd apps/macos && ./build.sh >/dev/null)
APP=apps/macos/build/terminus.app
codesign --verify --strict "$APP"
codesign -d -r- "$APP" 2>&1 | grep designated

STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
cp -R "$APP" "$STAGE/terminus.app"
ln -s /Applications "$STAGE/Applications"
rm -f "$DMG"
# hdiutil sometimes fails with "Resource busy" on CI runners; a retry does it.
for try in 1 2 3; do
  hdiutil create -quiet -volname terminus -srcfolder "$STAGE" -fs HFS+ -format UDZO -ov "$DMG" && break
  [ "$try" = 3 ] && exit 1
  sleep 5
done
# shellcheck disable=SC2086
codesign --force --sign "${SIGN_IDENTITY:--}" $KC_ARGS "$DMG"
codesign --verify "$DMG"
hdiutil verify -quiet "$DMG"
echo "built $DMG ($(stat -f%z "$DMG") bytes)"
