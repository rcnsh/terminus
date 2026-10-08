#!/bin/sh
# Build, sign and package the Mac app as build/release/<version>/terminus-<version>.dmg:
# a disk image holding terminus.app and an Applications shortcut to drag it onto.
#
#   SIGN_IDENTITY=<certificate SHA-1> SIGN_KEYCHAIN=<keychain> scripts/package-mac.sh
#
# With CHANNEL=beta (and BETA_VERSION, BETA_BUILD; scripts/release-beta.sh
# sets them) it packages "terminus beta.app" as
# build/release/beta/<version>/terminus-<version>.dmg instead. RELEASES
# moves build/release elsewhere (a dry run's build/dry-run).
#
# scripts/release.sh and scripts/release-beta.sh run this with the terminus
# self-signed certificate,
# from the login keychain. That certificate is not trusted by macOS
# and the app is not notarised, so Gatekeeper still asks on first open; what
# the signature buys is the same code identity on every version, so macOS
# keeps the app's location permission and login item across updates.
# Without SIGN_IDENTITY it signs ad-hoc, for trying the packaging locally.
set -eu
cd "$(dirname "$0")/.."
ROOT=$(pwd)

CHANNEL=${CHANNEL:-stable}
RELEASES=${RELEASES:-$ROOT/build/release}
if [ "$CHANNEL" = beta ]; then
  VERSION="${BETA_VERSION:?BETA_VERSION is needed for a beta}"
  OUT="$RELEASES/beta/$VERSION"
  NAME="terminus beta"
else
  VERSION=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' apps/macos/Support/Info.plist)
  OUT="$RELEASES/$VERSION"
  NAME=terminus
fi
DMG="$OUT/terminus-$VERSION.dmg"
mkdir -p "$OUT"
# A release that's published must be signed with the terminus certificate:
# an ad-hoc signature would break updates and permissions on every Mac.
if [ "${PUBLISH:-}" = true ] && [ -z "${SIGN_IDENTITY:-}" ]; then
  echo "SIGN_IDENTITY is not set; refusing to package a release to publish" >&2
  exit 1
fi

echo "== mac $VERSION ($CHANNEL)"
(cd apps/macos && ./build.sh >/dev/null)
APP="apps/macos/build/$NAME.app"
codesign --verify --strict "$APP"
if [ "${PUBLISH:-}" = true ] && codesign -dv "$APP" 2>&1 | grep -q '^Signature=adhoc'; then
  echo "$APP is signed ad-hoc; refusing to package a release to publish" >&2
  exit 1
fi
codesign -d -r- "$APP" 2>&1 | grep designated

STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
cp -R "$APP" "$STAGE/$NAME.app"
ln -s /Applications "$STAGE/Applications"
rm -f "$DMG"
# hdiutil sometimes fails with "Resource busy" on CI runners; a retry does it.
for try in 1 2 3; do
  hdiutil create -quiet -volname "$NAME" -srcfolder "$STAGE" -fs HFS+ -format UDZO -ov "$DMG" && break
  [ "$try" = 3 ] && exit 1
  sleep 5
done
codesign --force --sign "${SIGN_IDENTITY:--}" ${SIGN_KEYCHAIN:+--keychain "$SIGN_KEYCHAIN"} "$DMG"
codesign --verify "$DMG"
hdiutil verify -quiet "$DMG"
echo "built $DMG ($(stat -f%z "$DMG") bytes)"
