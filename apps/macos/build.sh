#!/bin/sh
set -eu
cd "$(dirname "$0")"
swift build -c release --arch arm64 --force-resolved-versions
OUT="$(swift build -c release --arch arm64 --force-resolved-versions --show-bin-path)"
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
codesign --verify --strict --deep "$OUT/Sparkle.framework"
ditto "$OUT/Sparkle.framework" "$APP/Contents/Frameworks/Sparkle.framework"
rm -rf "$APP/Contents/Frameworks/Sparkle.framework/Versions/B/XPCServices" "$APP/Contents/Frameworks/Sparkle.framework/XPCServices"
ditto "$OUT/MapLibre.framework" "$APP/Contents/Frameworks/MapLibre.framework"
ML="$APP/Contents/Frameworks/MapLibre.framework/Versions/A/MapLibre"
lipo "$ML" -thin arm64 -output "$ML.arm64" && mv "$ML.arm64" "$ML"
cp Support/Info.plist "$APP/Contents/Info.plist"
if [ "$CHANNEL" = beta ]; then
  PB() { /usr/libexec/PlistBuddy -c "$1" "$APP/Contents/Info.plist"; }
  PB "Set :CFBundleIdentifier $ID"
  PB "Set :CFBundleName $NAME"
  PB "Set :CFBundleDisplayName $NAME"
  PB "Set :SUFeedURL https://beta.terminus.run/download/appcast.xml"
  PB "Add :TerminusSite string https://beta.terminus.run"
  PB "Add :TerminusAPI string https://beta.terminus.run"
  if [ -n "${BETA_VERSION:-}" ]; then PB "Set :CFBundleShortVersionString $BETA_VERSION"; fi
  if [ -n "${BETA_BUILD:-}" ]; then PB "Set :CFBundleVersion $BETA_BUILD"; fi
fi
mkdir -p "$APP/Contents/Resources"
cp "$ICON" "$APP/Contents/Resources/AppIcon.icns"
cp -R Support/zh-Hans.lproj "$APP/Contents/Resources/"
DEVELOPER_ID_APPLICATION_SHA1=B0692598973AE875C270263F0403FE4495EEF562
if [ -z "${SIGN_IDENTITY:-}" ] && security find-identity -p codesigning | grep -q "$DEVELOPER_ID_APPLICATION_SHA1"; then
  SIGN_IDENTITY=$DEVELOPER_ID_APPLICATION_SHA1
fi
TS=--timestamp=none
if [ "${PUBLISH:-}" = true ] && [ -n "${SIGN_IDENTITY:-}" ]; then TS=--timestamp; fi
sign() { codesign --force --options runtime "$TS" --sign "${SIGN_IDENTITY:--}" ${SIGN_KEYCHAIN:+--keychain "$SIGN_KEYCHAIN"} "$@"; }
FW="$APP/Contents/Frameworks/Sparkle.framework/Versions/B"
sign "$FW/Autoupdate"
sign "$FW/Updater.app"
sign "$APP/Contents/Frameworks/Sparkle.framework"
sign "$APP/Contents/Frameworks/MapLibre.framework"
ENT=Support/Terminus.entitlements
if [ -z "${SIGN_IDENTITY:-}" ]; then
  ENT=$(mktemp -t terminus-ent).plist
  cp Support/Terminus.entitlements "$ENT"
  /usr/libexec/PlistBuddy -c "Add :com.apple.security.cs.disable-library-validation bool true" "$ENT"
fi
sign --identifier "$ID" --entitlements "$ENT" "$APP"
echo "built $APP"
if [ "${1:-}" = install ]; then
  pkill -f "/Applications/$NAME.app/" 2>/dev/null || true
  rm -rf "/Applications/$NAME.app"
  cp -R "$APP" "/Applications/$NAME.app"
  open "/Applications/$NAME.app"
  echo "installed /Applications/$NAME.app"
fi
