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
  ID=sh.rcn.terminus.beta
else
  VERSION=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' apps/macos/Support/Info.plist)
  OUT="$RELEASES/$VERSION"
  NAME=terminus
  ID=sh.rcn.terminus
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
# Every nested framework and helper too, not just the app's own seal.
codesign --verify --deep --strict "$APP"
# The hardened runtime on the app and everything inside it that runs (build.sh).
for code in "$APP" "$APP/Contents/Frameworks/Sparkle.framework" "$APP/Contents/Frameworks/MapLibre.framework" \
  "$APP/Contents/Frameworks/Sparkle.framework/Versions/B/Autoupdate" "$APP/Contents/Frameworks/Sparkle.framework/Versions/B/Updater.app"; do
  if ! codesign -dv "$code" 2>&1 | grep -q '^CodeDirectory .*flags=.*runtime'; then
    echo "$code isn't signed with the hardened runtime" >&2
    exit 1
  fi
done
if [ "${PUBLISH:-}" = true ] && codesign -dv "$APP" 2>&1 | grep -q '^Signature=adhoc'; then
  echo "$APP is signed ad-hoc; refusing to package a release to publish" >&2
  exit 1
fi
DR=$(codesign -d -r- "$APP" 2>&1 | grep designated)
echo "$DR"
# Signed with a certificate, the app must name it: macOS ties the app's
# permissions and login item to this requirement, and a release with another
# would lose them on every Mac. The leaf's SHA-1 comes from the identity
# itself (a hash already, or looked up by name), not a copy kept here.
if [ -n "${SIGN_IDENTITY:-}" ]; then
  if echo "$SIGN_IDENTITY" | grep -Eq '^[0-9A-Fa-f]{40}$'; then
    LEAF=$SIGN_IDENTITY
  else
    LEAF=$(security find-identity -p codesigning ${SIGN_KEYCHAIN:+"$SIGN_KEYCHAIN"} | grep -F "\"$SIGN_IDENTITY\"" | awk 'NR==1 { print $2 }')
  fi
  LEAF=$(echo "$LEAF" | tr 'A-F' 'a-f')
  [ -n "$LEAF" ] || { echo "can't find the certificate for $SIGN_IDENTITY" >&2; exit 1; }
  echo "$DR" | grep -Fq "identifier \"$ID\"" && echo "$DR" | grep -Fq "certificate leaf = H\"$LEAF\"" || {
    echo "the app's designated requirement isn't $ID signed by certificate $LEAF; refusing to package it" >&2
    exit 1
  }
fi

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
