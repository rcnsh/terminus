#!/bin/sh
# Builds terminus.app from the Swift package.
#   ./build.sh            -> build/terminus.app
#   ./build.sh install    -> also copy to /Applications and open it
#
# Signed with SIGN_IDENTITY (and SIGN_KEYCHAIN, optionally, the keychain
# holding it); without it, with the terminus self-signed certificate if it's in
# your keychain, else ad-hoc. Releases are signed with that certificate by
# scripts/package-mac.sh, so every version has the same code identity and
# macOS keeps its permissions and the device token's Keychain access.
set -eu
cd "$(dirname "$0")"
swift build -c release --arch arm64
OUT="$(swift build -c release --arch arm64 --show-bin-path)"
APP=build/terminus.app
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Frameworks"
cp "$OUT/Terminus" "$APP/Contents/MacOS/Terminus"
install_name_tool -add_rpath @executable_path/../Frameworks "$APP/Contents/MacOS/Terminus"
# Sparkle, for updates. Its XPC services are only for sandboxed apps.
ditto "$OUT/Sparkle.framework" "$APP/Contents/Frameworks/Sparkle.framework"
rm -rf "$APP/Contents/Frameworks/Sparkle.framework/Versions/B/XPCServices" "$APP/Contents/Frameworks/Sparkle.framework/XPCServices"
cp Support/Info.plist "$APP/Contents/Info.plist"
mkdir -p "$APP/Contents/Resources"
cp Support/AppIcon.icns "$APP/Contents/Resources/AppIcon.icns"
TERMINUS_CERT=C4EE234DA75ED3CD7699A31394C276801F93C4A9
if [ -z "${SIGN_IDENTITY:-}" ] && security find-identity -p codesigning | grep -q "$TERMINUS_CERT"; then
  SIGN_IDENTITY=$TERMINUS_CERT
fi
sign() { codesign --force --sign "${SIGN_IDENTITY:--}" ${SIGN_KEYCHAIN:+--keychain "$SIGN_KEYCHAIN"} "$@"; }
# Inside out: Sparkle's helpers, the framework, then the app.
FW="$APP/Contents/Frameworks/Sparkle.framework/Versions/B"
sign "$FW/Autoupdate"
sign "$FW/Updater.app"
sign "$APP/Contents/Frameworks/Sparkle.framework"
sign --identifier sh.rcn.terminus "$APP"
echo "built $APP"
if [ "${1:-}" = install ]; then
  pkill -x Terminus 2>/dev/null || true
  rm -rf /Applications/terminus.app
  cp -R "$APP" /Applications/terminus.app
  open /Applications/terminus.app
  echo "installed /Applications/terminus.app"
fi
