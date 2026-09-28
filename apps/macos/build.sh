#!/bin/sh
# Builds nusbus.app from the Swift package. Ad-hoc signed: fine for your own
# Mac, not for distribution.
#   ./build.sh            -> build/nusbus.app
#   ./build.sh install    -> also copy to /Applications and open it
set -eu
cd "$(dirname "$0")"
swift build -c release --arch arm64
BIN="$(swift build -c release --arch arm64 --show-bin-path)/Nusbus"
APP=build/nusbus.app
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
cp "$BIN" "$APP/Contents/MacOS/Nusbus"
cp Support/Info.plist "$APP/Contents/Info.plist"
codesign --force --sign - --identifier sh.rcn.nusbus "$APP"
echo "built $APP"
if [ "${1:-}" = install ]; then
  pkill -x Nusbus 2>/dev/null || true
  rm -rf /Applications/nusbus.app
  cp -R "$APP" /Applications/nusbus.app
  open /Applications/nusbus.app
  echo "installed /Applications/nusbus.app"
fi
