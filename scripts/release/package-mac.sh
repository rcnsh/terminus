#!/bin/sh
# Build, sign and package the Mac app as build/release/<version>/terminus-<version>.dmg:
# a disk image holding terminus.app and an Applications shortcut to drag it onto.
#
#   SIGN_IDENTITY=<certificate SHA-1> SIGN_KEYCHAIN=<keychain> scripts/release/package-mac.sh
#   PUBLISH=true NOTARY_PROFILE=terminus-notary ... scripts/release/package-mac.sh
#
# With CHANNEL=beta (and BETA_VERSION, BETA_BUILD; scripts/release/release-beta.sh
# sets them) it packages "terminus beta.app" as
# build/release/beta/<version>/terminus-<version>.dmg instead. RELEASES
# moves build/release elsewhere (a dry run's build/dry-run).
#
# scripts/release/release.sh and scripts/release/release-beta.sh run this with PUBLISH=true
# and the terminus Developer ID certificate from the login keychain. The app
# and then the disk image are notarised by Apple (notarytool, with the
# credentials stored in the keychain as NOTARY_PROFILE) and the tickets
# stapled to them, so macOS opens a download without asking. Every version
# carries the same code identity, the team's, so macOS keeps the app's
# location permission and login item across updates. The stapling changes
# the disk image, so the Sparkle signature is made after this, never before.
# Without SIGN_IDENTITY it signs ad-hoc, for trying the packaging locally.
set -eu
cd "$(dirname "$0")/../.."
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
if [ "${PUBLISH:-}" = true ] && [ -z "${NOTARY_PROFILE:-}" ]; then
  echo "NOTARY_PROFILE is not set; refusing to package a release that isn't notarised" >&2
  exit 1
fi
TEAM=BUKSCHP3SV

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
# Every binary links only macOS's own libraries (/System, /usr/lib) and the
# app's (@rpath, @executable_path, @loader_path): one linked from Homebrew
# loads on the Mac that built it and nowhere else.
find "$APP" -type f -perm +111 | while IFS= read -r bin; do
  file -b "$bin" | grep -q Mach-O || continue
  foreign=$(otool -L "$bin" | grep -v ':$' | awk '{ print $1 }' | grep -vE '^(/System/|/usr/lib/|@rpath/|@executable_path/|@loader_path/)' || true)
  if [ -n "$foreign" ]; then
    echo "$bin links libraries a Mac doesn't have:" >&2
    echo "$foreign" >&2
    exit 1
  fi
done
if [ "${PUBLISH:-}" = true ] && codesign -dv "$APP" 2>&1 | grep -q '^Signature=adhoc'; then
  echo "$APP is signed ad-hoc; refusing to package a release to publish" >&2
  exit 1
fi
DR=$(codesign -d -r- "$APP" 2>&1 | grep designated)
echo "$DR"
# Signed with a certificate, the app must be ours: macOS ties the app's
# permissions and login item to this requirement (the bundle id, a
# Developer ID from Apple, and the team), and a release with another would
# lose them on every Mac. It names the team rather than the certificate, so
# a renewed certificate keeps it.
if [ -n "${SIGN_IDENTITY:-}" ]; then
  for want in "identifier \"$ID\"" "anchor apple generic" "certificate leaf[subject.OU] = $TEAM"; do
    echo "$DR" | grep -Fq "$want" || {
      echo "the app's designated requirement lacks '$want'; refusing to package it" >&2
      exit 1
    }
  done
fi

# Apple's notary service checks the upload and issues a ticket; stapling it
# lets macOS check a download offline. notarytool exits 0 even when it
# rejects an upload, so the status is read from its answer.
notarise() {
  out=$(xcrun notarytool submit "$1" --keychain-profile "$NOTARY_PROFILE" --wait --output-format json) || {
    echo "notarytool couldn't submit $1" >&2
    exit 1
  }
  status=$(printf '%s' "$out" | python3 -c 'import json, sys; print(json.load(sys.stdin).get("status", ""))')
  if [ "$status" != Accepted ]; then
    id=$(printf '%s' "$out" | python3 -c 'import json, sys; print(json.load(sys.stdin).get("id", ""))')
    echo "Apple's notary service didn't accept $1 ($status); its log: xcrun notarytool log $id --keychain-profile $NOTARY_PROFILE" >&2
    exit 1
  fi
}
if [ "${PUBLISH:-}" = true ]; then
  echo "notarising $APP"
  ZIP=$(mktemp -d)/app.zip
  ditto -c -k --keepParent "$APP" "$ZIP"
  notarise "$ZIP"
  rm -f "$ZIP"
  xcrun stapler staple -q "$APP"
  spctl --assess --type execute "$APP" || { echo "Gatekeeper refuses $APP after notarising" >&2; exit 1; }
fi

STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
cp -R "$APP" "$STAGE/$NAME.app"
ln -s /Applications "$STAGE/Applications"
rm -f "$DMG"
# hdiutil sometimes fails with "Resource busy"; a retry does it.
for try in 1 2 3; do
  hdiutil create -quiet -volname "$NAME" -srcfolder "$STAGE" -fs HFS+ -format UDZO -ov "$DMG" && break
  [ "$try" = 3 ] && exit 1
  sleep 5
done
TS=--timestamp=none
[ "${PUBLISH:-}" = true ] && TS=--timestamp
codesign --force "$TS" --sign "${SIGN_IDENTITY:--}" ${SIGN_KEYCHAIN:+--keychain "$SIGN_KEYCHAIN"} "$DMG"
codesign --verify "$DMG"
hdiutil verify -quiet "$DMG"
if [ "${PUBLISH:-}" = true ]; then
  echo "notarising $DMG"
  notarise "$DMG"
  xcrun stapler staple -q "$DMG"
  spctl --assess --type open --context context:primary-signature "$DMG" ||
    { echo "Gatekeeper refuses $DMG after notarising" >&2; exit 1; }
fi
echo "built $DMG ($(stat -f%z "$DMG") bytes)"
