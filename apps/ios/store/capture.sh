#!/bin/sh
# Takes the App Store screenshots' captures (captures/en, captures/zh) on an
# iPhone simulator at 1320×2868 (6.9", an iPhone 17 Pro Max), against a dev
# stub of its own: StoreShotsUITests, one test a scene, with the status bar's
# time set to the scene's. Then node frame.mjs frames them.
#   store/capture.sh [simulator-udid] [scene, e.g. test3Map]
# DEVICE=ipad or DEVICE=duo writes captures/<device>/ instead, for the iPad
# 13" and the open iPhone Duo sets; TURN=1 turns the device on its side
# first, for the iPad's wide set (the open Duo is wide as it's held), and
# PANES=1 says the app shows two panes, as on both. SHOT_DISPLAY=<n>
# takes each screenshot with simctl from that display (simctl io <sim>
# enumerate lists them), as XCUITest's own comes out sideways or black on
# those two; ROTATE=<degrees> then turns it upright.
# With no simulator, the booted one. The stub listens on PORT (8791 unless
# set), so a stub already on 8787 is left alone.
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
  # The test leaves <name>.ready where it wants a screenshot and waits for <name>.png.
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

# Built once and installed before the grant: a simulator that has never had
# the app ignores a grant for it, and every scene then shows the location card.
DD=build/store-dd
xcodebuild build-for-testing -project terminus.xcodeproj -scheme Terminus -destination "id=$SIM" \
  -derivedDataPath "$DD" -quiet
xcrun simctl install "$SIM" "$DD/Build/Products/Debug-iphonesimulator/Terminus.app"
# The app asks for location on its first launch: answered, as a person would.
xcrun simctl privacy "$SIM" grant location-always sh.rcn.terminus

# The scene's test and its status bar's time. The widgets read the phone's
# own clock, so their scene shows the real one.
scene() {
  test=$1
  time=$2
  [ -n "$ONLY" ] && [ "$ONLY" != "$test" ] && return 0
  for lang in en zh; do
    # "clock": the real time, a minute on, when the test takes its shot.
    # frame.mjs redraws the home screen's status bar with it (2-widget.time),
    # so the override leaves the time alone: simctl refuses any 00:MM.
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
# The widgets' scene last: it moves the stub's clock to the real time.
scene test1LeaveBy 09:26
scene test3Map 09:26
scene test4Buses 09:26
scene test5OnTheBus 09:47
# The iPad and the Duo show Nearby instead: their home screens' widgets
# can't be laid out from a test the way the iPhone's are.
if [ -n "${DEVICE:-}" ]; then scene test2Nearby 09:26; else scene test2Widget clock; fi

for f in build/store-shots/*.png; do
  name=$(basename "$f")
  cp "$f" "$CAP/${name%%-*}/${name#*-}"
done
ls "$CAP/en" "$CAP/zh"
