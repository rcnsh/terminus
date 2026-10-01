#!/bin/sh
# Release a beta: everything at beta.terminus.rcn.sh, from this commit.
#
#   scripts/release-beta.sh 2.0.1-beta.1 --dry-run   # tests and builds, nothing uploaded
#   scripts/release-beta.sh 2.0.1-beta.1             # also deploys and uploads
#
# In order: the tests; the beta Worker's D1 migrations and the beta Worker
# (Worker first, as for stable); "terminus beta" for Android and the Mac; then
# their downloads, appcast and latest.json, in the beta's own R2 bucket.
#
# A beta version is the next stable version's pre-release (after 2.0.0:
# 2.0.1-beta.1, 2.0.1-beta.2, ...). The build number is the commit count, so
# it only goes up. Nothing touches the stable site, its data or its downloads,
# and there's no tag, GitHub release or CI: it runs on this Mac and signs with
# the same keys as stable (the Android release key in ~/.gradle, and the Mac
# certificate and the Sparkle key in ~/.terminus).
set -eu
cd "$(dirname "$0")/.."
ROOT=$(pwd)
VERSION="${1:?usage: scripts/release-beta.sh <version, e.g. 2.0.1-beta.1> [--dry-run]}"
DRY=0
[ "${2:-}" = "--dry-run" ] && DRY=1
SITE=https://beta.terminus.rcn.sh
BUCKET=terminus-beta-downloads

echo "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+-beta\.[0-9]+$' || { echo "a beta version looks like 2.0.1-beta.1"; exit 1; }
BUILD=$(git rev-list --count HEAD)
BETA_D1=$(sed -n '/^const BETA = {/,/^};/s/.*d1: "\(.*\)".*/\1/p' apps/api/cloudflare.config.ts)
[ -n "$BETA_D1" ] || [ $DRY -eq 1 ] || { echo "the beta's D1 id isn't in apps/api/cloudflare.config.ts yet"; exit 1; }
grep -q "^TERMINUS_KEYSTORE=" "$HOME/.gradle/gradle.properties" 2>/dev/null || { echo "Android release key not configured (TERMINUS_KEYSTORE)"; exit 1; }
SPARKLE_KEY="$HOME/.terminus/sparkle-ed25519.key"
[ -f "$SPARKLE_KEY" ] || { echo "no Sparkle key at $SPARKLE_KEY"; exit 1; }
# What's released must be what's committed (untracked files, like PLAN.md, don't count).
if [ $DRY -eq 0 ] && [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "uncommitted changes; commit them before releasing"; exit 1
fi
if [ $DRY -eq 0 ]; then
  CURRENT=$(curl -fsS "$SITE/download/latest.json" 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin)["version"])' 2>/dev/null || true)
  [ "$CURRENT" != "$VERSION" ] || { echo "$VERSION is already the beta; pick the next number"; exit 1; }
fi

mkdir -p build
OUT="$ROOT/build/release/beta/$VERSION"
rm -rf "$OUT"
mkdir -p "$OUT"
echo "== terminus beta $VERSION (build $BUILD, $(git rev-parse --short HEAD))"

echo "== tests"
if ! pnpm --silent check >"$ROOT/build/test.log" 2>&1; then
  tail -40 "$ROOT/build/test.log"; echo "== tests or typecheck FAILED; nothing released"; exit 1
fi
echo "api tests and typecheck pass"

echo "== android"
(cd apps/android && JAVA_HOME="${JAVA_HOME:-/Applications/Android Studio.app/Contents/jbr/Contents/Home}" \
  ./gradlew :app:assembleBetaRelease -PbetaVersion="$VERSION" -PbetaCode="$BUILD" --console=plain -q)
APK="$OUT/terminus-$VERSION.apk"
cp apps/android/app/build/outputs/apk/beta/release/app-beta-release.apk "$APK"

echo "== mac"
CHANNEL=beta BETA_VERSION="$VERSION" BETA_BUILD="$BUILD" scripts/package-mac.sh
DMG="$OUT/terminus-$VERSION.dmg"
SIG=$("$ROOT/apps/macos/.build/artifacts/sparkle/Sparkle/bin/sign_update" --ed-key-file "$SPARKLE_KEY" -p "$DMG")
printf '%s' "$SIG" | grep -q . || { echo "sign_update gave no signature"; exit 1; }
MIN_OS=$(/usr/libexec/PlistBuddy -c 'Print :LSMinimumSystemVersion' apps/macos/Support/Info.plist)
python3 scripts/appcast.py "$VERSION" "$BUILD" "$MIN_OS" "$SIG" "$DMG" "$SITE" > "$OUT/appcast.xml"

python3 - "$VERSION" "$APK" "$DMG" > "$OUT/latest.json" <<'EOF'
import datetime, hashlib, json, os, sys
version, apk, dmg = sys.argv[1:]
def entry(path):
    return {'file': f'releases/{version}/{os.path.basename(path)}', 'sha256': hashlib.sha256(open(path, 'rb').read()).hexdigest(), 'size': os.path.getsize(path)}
print(json.dumps({
    'version': version,
    'released': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
    'android': entry(apk),
    'mac': entry(dmg),
}, indent=2))
EOF
cat "$OUT/latest.json"

if [ $DRY -eq 1 ]; then
  echo "== dry run: nothing deployed or uploaded (files in $OUT)"
  exit 0
fi

echo "== beta Worker"
(cd apps/api && pnpm exec cf d1 migrations apply "$BETA_D1" && pnpm run deploy:beta)

echo "== upload"
# Wrangler, not `cf r2 objects put`: cf percent-encodes the slashes in the key.
r2() { (cd "$ROOT/apps/api" && pnpm exec wrangler r2 object put "$BUCKET/$1" --file "$2" --content-type "$3" --remote); }
r2 "releases/$VERSION/terminus-$VERSION.apk" "$APK" application/vnd.android.package-archive
r2 "releases/$VERSION/terminus-$VERSION.dmg" "$DMG" application/x-apple-diskimage
r2 appcast.xml "$OUT/appcast.xml" "application/xml; charset=utf-8"
# latest.json last, so /download/* never points at a file that isn't there yet.
r2 latest.json "$OUT/latest.json" application/json
echo "== released beta $VERSION at $SITE"
