#!/bin/sh
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
codesign --verify --deep --strict "$APP"
for code in "$APP" "$APP/Contents/Frameworks/Sparkle.framework" "$APP/Contents/Frameworks/MapLibre.framework" \
  "$APP/Contents/Frameworks/Sparkle.framework/Versions/B/Autoupdate" "$APP/Contents/Frameworks/Sparkle.framework/Versions/B/Updater.app"; do
  if ! codesign -dv "$code" 2>&1 | grep -q '^CodeDirectory .*flags=.*runtime'; then
    echo "$code isn't signed with the hardened runtime" >&2
    exit 1
  fi
done
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
if [ -n "${SIGN_IDENTITY:-}" ]; then
  for want in "identifier \"$ID\"" "anchor apple generic" "certificate leaf[subject.OU] = $TEAM"; do
    echo "$DR" | grep -Fq "$want" || {
      echo "the app's designated requirement lacks '$want'; refusing to package it" >&2
      exit 1
    }
  done
fi

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
