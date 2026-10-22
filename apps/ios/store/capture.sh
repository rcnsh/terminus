#!/bin/sh
# Takes the App Store screenshots' captures (captures/en, captures/zh) on an
# iPhone simulator at 1320×2868 (6.9", an iPhone 17 Pro Max), against a dev
# stub of its own: StoreShotsUITests, one test a scene, with the status bar's
# time set to the scene's. Then node frame.mjs frames them.
#   store/capture.sh [simulator-udid] [scene, e.g. test3Map]
# With no simulator, the booted one. The stub listens on PORT (8791 unless
# set), so a stub already on 8787 is left alone.
set -eu
cd "$(dirname "$0")/.."
SIM=${1:-booted}
ONLY=${2:-}
PORT=${PORT:-8791}
if [ "$SIM" = booted ]; then SIM=$(xcrun simctl list devices booted -j | python3 -I -c 'import json,sys; print([d["udid"] for r in json.load(sys.stdin)["devices"].values() for d in r if d["state"]=="Booted"][0])'); fi
mkdir -p build store/captures/en store/captures/zh
rm -rf build/store-shots
scripts/fetch-maplibre.sh
xcodegen generate -q

PORT=$PORT node ../api/scripts/dev/dev-stub.mjs > build/store-stub.log 2>&1 &
STUB=$!
trap 'kill $STUB 2>/dev/null; xcrun simctl status_bar "$SIM" clear' EXIT INT TERM
for _ in 1 2 3 4 5 6 7 8 9 10; do
  curl -s -o /dev/null "http://127.0.0.1:$PORT/" && break
  sleep 1
done

# The app asks for location on its first launch: answered, as a person would.
xcrun simctl privacy "$SIM" grant location sh.rcn.terminus 2>/dev/null || true

# The scene's test and its status bar's time. The widgets read the phone's
# own clock, so their scene shows the real one.
scene() {
  test=$1
  time=$2
  [ -n "$ONLY" ] && [ "$ONLY" != "$test" ] && return 0
  for lang in en zh; do
    # "clock": the real time, a minute on, when the test takes its shot.
    shown=$time
    # frame.mjs redraws the home screen's status bar with it (2-widget.time).
    [ "$time" = clock ] && shown=$(date -v+1M +%H:%M) && echo "$shown" > "store/captures/$lang/2-widget.time"
    xcrun simctl status_bar "$SIM" override --time "$shown" --dataNetwork wifi --wifiMode active --wifiBars 3 \
      --cellularMode active --cellularBars 4 --batteryState charged --batteryLevel 100
    TEST_RUNNER_TERMINUS_STUB="http://127.0.0.1:$PORT" \
    TEST_RUNNER_STORE_LANG=$lang \
    TEST_RUNNER_TERMINUS_SHOTS="$PWD/build/store-shots" \
      xcodebuild test -project terminus.xcodeproj -scheme Terminus -destination "id=$SIM" \
        -only-testing:"TerminusUITests/StoreShotsUITests/$test" -collect-test-diagnostics never -quiet
  done
}
# The widgets' scene last: it moves the stub's clock to the real time.
scene test1LeaveBy 09:26
scene test3Map 09:26
scene test4Buses 09:26
scene test5OnTheBus 09:47
scene test2Widget clock

for f in build/store-shots/*.png; do
  name=$(basename "$f")
  cp "$f" "store/captures/${name%%-*}/${name#*-}"
done
ls store/captures/en store/captures/zh
