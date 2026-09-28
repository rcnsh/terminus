#!/bin/sh
# Builds terminus.app from the Swift package. Ad-hoc signed: fine for your own
# Mac, not for distribution.
#   ./build.sh            -> build/terminus.app
#   ./build.sh install    -> also copy to /Applications and open it
set -eu
cd "$(dirname "$0")"
swift build -c release --arch arm64
BIN="$(swift build -c release --arch arm64 --show-bin-path)/Terminus"
APP=build/terminus.app
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
cp "$BIN" "$APP/Contents/MacOS/Terminus"
cp Support/Info.plist "$APP/Contents/Info.plist"
mkdir -p "$APP/Contents/Resources"
cp Support/AppIcon.icns "$APP/Contents/Resources/AppIcon.icns"
codesign --force --sign - --identifier sh.rcn.terminus "$APP"
echo "built $APP"
if [ "${1:-}" = install ]; then
  pkill -x Nusbus 2>/dev/null || true
  pkill -x Terminus 2>/dev/null || true
  rm -rf /Applications/nusbus.app
  rm -rf /Applications/terminus.app
  cp -R "$APP" /Applications/terminus.app
  open /Applications/terminus.app
  echo "installed /Applications/terminus.app"
fi
