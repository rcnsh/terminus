#!/bin/sh
# Builds terminus.app from the Swift package.
#   ./build.sh                    -> build/terminus.app
#   ./build.sh install            -> also copy to /Applications and open it
#   CHANNEL=beta ./build.sh       -> build/terminus beta.app: sh.rcn.terminus.beta,
#                                    for beta.terminus.rcn.sh, updating from its appcast
#
# Signed with SIGN_IDENTITY (and SIGN_KEYCHAIN, optionally, the keychain
# holding it); without it, with the terminus self-signed certificate if it's in
# your keychain, else ad-hoc. Releases are signed with that certificate by
# scripts/package-mac.sh, so every version has the same code identity and
# macOS keeps its permissions across updates.
set -eu
cd "$(dirname "$0")"
swift build -c release --arch arm64
OUT="$(swift build -c release --arch arm64 --show-bin-path)"
CHANNEL=${CHANNEL:-stable}
case "$CHANNEL" in
  stable) NAME=terminus; ID=sh.rcn.terminus; ICON=Support/AppIcon.icns ;;
  beta) NAME="terminus beta"; ID=sh.rcn.terminus.beta; ICON=Support/AppIcon-beta.icns ;;
  *) echo "CHANNEL is stable or beta"; exit 1 ;;
esac
APP="build/$NAME.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Frameworks"
cp "$OUT/Terminus" "$APP/Contents/MacOS/Terminus"
install_name_tool -add_rpath @executable_path/../Frameworks "$APP/Contents/MacOS/Terminus"
# Sparkle, for updates. Its XPC services are only for sandboxed apps.
ditto "$OUT/Sparkle.framework" "$APP/Contents/Frameworks/Sparkle.framework"
rm -rf "$APP/Contents/Frameworks/Sparkle.framework/Versions/B/XPCServices" "$APP/Contents/Frameworks/Sparkle.framework/XPCServices"
# MapLibre, for the map (Vendor/, from scripts/vendor-maplibre-mac.sh). It's
# built for Intel too; this app is arm64 only, so that half is left out.
ditto "$OUT/MapLibre.framework" "$APP/Contents/Frameworks/MapLibre.framework"
ML="$APP/Contents/Frameworks/MapLibre.framework/Versions/A/MapLibre"
lipo "$ML" -thin arm64 -output "$ML.arm64" && mv "$ML.arm64" "$ML"
cp Support/Info.plist "$APP/Contents/Info.plist"
if [ "$CHANNEL" = beta ]; then
  # Its own app to macOS (permissions, login item, notifications), its own
  # site and its own updates. The Sparkle key is the same.
  PB() { /usr/libexec/PlistBuddy -c "$1" "$APP/Contents/Info.plist"; }
  PB "Set :CFBundleIdentifier $ID"
  PB "Set :CFBundleName $NAME"
  PB "Set :CFBundleDisplayName $NAME"
  PB "Set :SUFeedURL https://beta.terminus.rcn.sh/download/appcast.xml"
  PB "Add :TerminusSite string https://beta.terminus.rcn.sh"
  # Its own version line, from scripts/release-beta.sh. Sparkle compares the build.
  if [ -n "${BETA_VERSION:-}" ]; then PB "Set :CFBundleShortVersionString $BETA_VERSION"; fi
  if [ -n "${BETA_BUILD:-}" ]; then PB "Set :CFBundleVersion $BETA_BUILD"; fi
fi
mkdir -p "$APP/Contents/Resources"
cp "$ICON" "$APP/Contents/Resources/AppIcon.icns"
# Chinese (phase 10): macOS shows it when the app or the Mac is set to it.
cp -R Support/zh-Hans.lproj "$APP/Contents/Resources/"
TERMINUS_CERT=C4EE234DA75ED3CD7699A31394C276801F93C4A9
if [ -z "${SIGN_IDENTITY:-}" ] && security find-identity -p codesigning | grep -q "$TERMINUS_CERT"; then
  SIGN_IDENTITY=$TERMINUS_CERT
fi
sign() { codesign --force --sign "${SIGN_IDENTITY:--}" ${SIGN_KEYCHAIN:+--keychain "$SIGN_KEYCHAIN"} "$@"; }
# Inside out: Sparkle's helpers, the frameworks, then the app.
FW="$APP/Contents/Frameworks/Sparkle.framework/Versions/B"
sign "$FW/Autoupdate"
sign "$FW/Updater.app"
sign "$APP/Contents/Frameworks/Sparkle.framework"
sign "$APP/Contents/Frameworks/MapLibre.framework"
sign --identifier "$ID" "$APP"
echo "built $APP"
if [ "${1:-}" = install ]; then
  # Both channels' executables are named Terminus: quit only this one.
  pkill -f "/Applications/$NAME.app/" 2>/dev/null || true
  rm -rf "/Applications/$NAME.app"
  cp -R "$APP" "/Applications/$NAME.app"
  open "/Applications/$NAME.app"
  echo "installed /Applications/$NAME.app"
fi
