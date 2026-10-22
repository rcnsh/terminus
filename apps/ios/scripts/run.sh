#!/bin/sh
# Builds the app and runs it on a simulator, against the dev stub by default.
#   scripts/run.sh [simulator-udid] [server]
# With no simulator, the booted one. The server defaults to the stub
# (node apps/api/scripts/dev/dev-stub.mjs, on http://localhost:8787); pass
# "default" for the build's own. Each checkout builds into its own build/dd.
set -eu
cd "$(dirname "$0")/.."
SIM=${1:-booted}
SERVER=${2:-http://localhost:8787}
scripts/fetch-maplibre.sh
xcodegen generate -q
DEST="id=$SIM"
if [ "$SIM" = booted ]; then DEST="id=$(xcrun simctl list devices booted -j | python3 -c 'import json,sys; print([d["udid"] for r in json.load(sys.stdin)["devices"].values() for d in r if d["state"]=="Booted"][0])')"; fi
xcodebuild -project terminus.xcodeproj -scheme Terminus -destination "$DEST" -derivedDataPath build/dd -quiet build
ID=${DEST#id=}
xcrun simctl install "$ID" build/dd/Build/Products/Debug-iphonesimulator/Terminus.app
xcrun simctl terminate "$ID" sh.rcn.terminus 2>/dev/null || true
if [ "$SERVER" = default ]; then
  xcrun simctl launch "$ID" sh.rcn.terminus
else
  SIMCTL_CHILD_TERMINUS_API_BASE="$SERVER" xcrun simctl launch "$ID" sh.rcn.terminus
fi
