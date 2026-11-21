#!/bin/sh
set -eu
case ${DEVICE:-} in "" | ipad | duo) ;; *) echo "DEVICE is ipad or duo (the watch set is taken by hand)" >&2; exit 1 ;; esac
cd "$(dirname "$0")/.."
SIM=${1:-booted}
ONLY=${2:-}
PORT=${PORT:-8791}
if [ "$SIM" = booted ]; then SIM=$(xcrun simctl list devices booted -j | python3 -I -c 'import json,sys; print([d["udid"] for r in json.load(sys.stdin)["devices"].values() for d in r if d["state"]=="Booted"][0])'); fi
CAP=store/captures${DEVICE:+/$DEVICE}
mkdir -p build "$CAP/en" "$CAP/zh"
rm -rf build/store-shots
scripts/fetch-maplibre.sh
xcodegen generate -q

PORT=$PORT node ../api/scripts/dev/dev-stub.mjs > build/store-stub.log 2>&1 &
STUB=$!
SHOTS=build/store-shots
WATCHER=
if [ -n "${SHOT_DISPLAY:-}" ]; then
  mkdir -p "$SHOTS"
  (while :; do
    for r in "$SHOTS"/*.ready; do
      [ -e "$r" ] || continue
      out=${r%.ready}.png
      xcrun simctl io "$SIM" screenshot --display="$SHOT_DISPLAY" "$out.tmp.png" >/dev/null 2>&1 || continue
      if [ -n "${ROTATE:-}" ]; then sips -r "$ROTATE" "$out.tmp.png" >/dev/null || continue; fi
      mv "$out.tmp.png" "$out" || continue
      rm -f "$r"
    done
    sleep 0.5
  done) &
  WATCHER=$!
fi
trap 'kill $STUB $WATCHER 2>/dev/null; xcrun simctl status_bar "$SIM" clear' EXIT INT TERM
for _ in 1 2 3 4 5 6 7 8 9 10; do
  curl -s -o /dev/null "http://127.0.0.1:$PORT/" && break
  sleep 1
done

DD=build/store-dd
xcodebuild build-for-testing -project terminus.xcodeproj -scheme Terminus -destination "id=$SIM" \
  -derivedDataPath "$DD" -quiet
xcrun simctl install "$SIM" "$DD/Build/Products/Debug-iphonesimulator/Terminus.app"
xcrun simctl privacy "$SIM" grant location-always sh.rcn.terminus

scene() {
  test=$1
  time=$2
  [ -n "$ONLY" ] && [ "$ONLY" != "$test" ] && return 0
  for lang in en zh; do
    clock=
    if [ "$time" = clock ]; then
      date -v+1M +%H:%M > "$CAP/$lang/2-widget.time"
    else
      clock="--time $time"
    fi
    # shellcheck disable=SC2086 # $clock is empty or two words
    xcrun simctl status_bar "$SIM" override $clock --dataNetwork wifi --wifiMode active --wifiBars 3 \
      --cellularMode active --cellularBars 4 --batteryState charged --batteryLevel 100
    TEST_RUNNER_TERMINUS_STUB="http://127.0.0.1:$PORT" \
    TEST_RUNNER_STORE_LANG=$lang \
    TEST_RUNNER_STORE_TURN=${TURN:-0} \
    TEST_RUNNER_STORE_WIDE=${PANES:-0} \
    TEST_RUNNER_STORE_HOST_SHOT=$([ -n "${SHOT_DISPLAY:-}" ] && echo 1 || echo 0) \
    TEST_RUNNER_TERMINUS_SHOTS="$PWD/build/store-shots" \
      xcodebuild test-without-building -project terminus.xcodeproj -scheme Terminus -destination "id=$SIM" \
        -derivedDataPath "$DD" -only-testing:"TerminusUITests/StoreShotsUITests/$test" \
        -collect-test-diagnostics never -quiet
  done
}
scene test1LeaveBy 09:26
scene test3Map 09:26
scene test4Buses 09:26
scene test5OnTheBus 09:47
if [ -n "${DEVICE:-}" ]; then scene test2Nearby 09:26; else scene test2Widget clock; fi

for f in build/store-shots/*.png; do
  name=$(basename "$f")
  cp "$f" "$CAP/${name%%-*}/${name#*-}"
done
ls "$CAP/en" "$CAP/zh"
