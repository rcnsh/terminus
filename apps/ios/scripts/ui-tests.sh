#!/bin/sh
# Runs the UI tests against a dev stub of their own, started here and
# stopped after (by its PID: other stubs on the Mac are left alone).
#   scripts/ui-tests.sh [simulator-udid] [suite, e.g. NowUITests]
# With no simulator, the booted one. Screenshots go to build/shots, to look
# at; the results to build/ui-tests.xcresult. The stub listens on PORT
# (8799 unless set) and logs to build/stub.log, where the sign-in tests read
# their codes. Each suite sets the stub's clock and hours it needs itself.
set -eu
cd "$(dirname "$0")/.."
SIM=${1:-booted}
SUITE=${2:-}
PORT=${PORT:-8799}
if [ "$SIM" = booted ]; then SIM=$(xcrun simctl list devices booted -j | python3 -I -c 'import json,sys; print([d["udid"] for r in json.load(sys.stdin)["devices"].values() for d in r if d["state"]=="Booted"][0])'); fi
mkdir -p build
rm -rf build/shots build/ui-tests.xcresult
scripts/fetch-maplibre.sh
xcodegen generate -q

PORT=$PORT node ../api/scripts/dev-stub.mjs > build/stub.log 2>&1 &
STUB=$!
trap 'kill $STUB 2>/dev/null' EXIT INT TERM
for _ in 1 2 3 4 5 6 7 8 9 10; do
  curl -s -o /dev/null "http://127.0.0.1:$PORT/" && break
  sleep 1
done

ONLY=TerminusUITests
[ -n "$SUITE" ] && ONLY="TerminusUITests/$SUITE"
STATUS=0
TEST_RUNNER_TERMINUS_STUB="http://127.0.0.1:$PORT" \
TEST_RUNNER_TERMINUS_STUB_LOG="$PWD/build/stub.log" \
TEST_RUNNER_TERMINUS_SHOTS="$PWD/build/shots" \
  xcodebuild test -project terminus.xcodeproj -scheme Terminus -destination "id=$SIM" \
    -only-testing:"$ONLY" -collect-test-diagnostics never \
    -resultBundlePath build/ui-tests.xcresult -quiet || STATUS=$?

# Each test, and why any failed.
xcrun xcresulttool get test-results tests --path build/ui-tests.xcresult | python3 -I -c '
import json, sys
count = {}
def walk(n, suite=""):
    if n.get("nodeType") == "Test Suite": suite = n.get("name", "")
    if n.get("nodeType") == "Test Case":
        r = n.get("result", "?"); count[r] = count.get(r, 0) + 1
        if r != "Passed":
            print(r, suite, n.get("name"))
            for c in n.get("children", []):
                if c.get("nodeType") == "Failure Message": print("   ", c.get("name", "")[:400])
    for c in n.get("children", []): walk(c, suite)
for t in json.load(sys.stdin)["testNodes"]: walk(t)
print(", ".join(f"{v} {k.lower()}" for k, v in sorted(count.items())))
'
exit $STATUS
