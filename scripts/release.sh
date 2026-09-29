#!/bin/sh
# Build both apps, upload them to R2 and point /download/* at them.
#
#   scripts/release.sh --dry-run   # build and hash, upload nothing
#   scripts/release.sh             # build, upload, tag v<version>
#
# The version is the Android versionName. The Android release key must be
# set up in ~/.gradle/gradle.properties (TERMINUS_*), or the APK would be
# debug-signed and refuse to install over the real one.
set -eu
cd "$(dirname "$0")/.."
ROOT=$(pwd)
DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

VERSION=$(sed -n 's/.*versionName = "\(.*\)".*/\1/p' apps/android/app/build.gradle.kts)
[ -n "$VERSION" ] || { echo "no versionName found"; exit 1; }
grep -q "^TERMINUS_KEYSTORE=" "$HOME/.gradle/gradle.properties" 2>/dev/null || { echo "Android release key not configured (TERMINUS_KEYSTORE)"; exit 1; }
if [ $DRY -eq 0 ] && git rev-parse "v$VERSION" >/dev/null 2>&1; then
  echo "v$VERSION is already tagged; bump versionName first"; exit 1
fi
# The tag must name exactly what was built: no uncommitted changes.
if [ $DRY -eq 0 ] && [ -n "$(git status --porcelain)" ]; then
  echo "uncommitted changes; commit them before releasing"; exit 1
fi

mkdir -p build
echo "== terminus $VERSION"
echo "== tests"
# Not `pnpm test && echo`: under set -e a failure on the left of && does not
# stop the script, so a failing suite would still build, upload and tag.
if ! pnpm --silent check >"$ROOT/build/test.log" 2>&1; then
  tail -40 "$ROOT/build/test.log"; echo "== tests or typecheck FAILED; nothing released"; exit 1
fi
echo "api tests and typecheck pass"

OUT="$ROOT/build/release/$VERSION"
rm -rf "$OUT"
mkdir -p "$OUT"

echo "== android"
(cd apps/android && JAVA_HOME="${JAVA_HOME:-/Applications/Android Studio.app/Contents/jbr/Contents/Home}" ./gradlew :app:assembleRelease --console=plain -q)
APK="$OUT/terminus-$VERSION.apk"
cp apps/android/app/build/outputs/apk/release/app-release.apk "$APK"

echo "== mac"
(cd apps/macos && ./build.sh >/dev/null)
ZIP="$OUT/terminus-$VERSION-mac.zip"
ditto -c -k --keepParent apps/macos/build/terminus.app "$ZIP"

sha() { shasum -a 256 "$1" | cut -d' ' -f1; }
size() { stat -f%z "$1"; }
cat > "$OUT/latest.json" <<EOF
{
  "version": "$VERSION",
  "released": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "android": { "file": "releases/$VERSION/terminus-$VERSION.apk", "sha256": "$(sha "$APK")", "size": $(size "$APK") },
  "mac": { "file": "releases/$VERSION/terminus-$VERSION-mac.zip", "sha256": "$(sha "$ZIP")", "size": $(size "$ZIP") }
}
EOF
cat "$OUT/latest.json"

if [ $DRY -eq 1 ]; then
  echo "== dry run: nothing uploaded (files in $OUT)"
  exit 0
fi

echo "== upload"
cd apps/api
# Wrangler, not `cf r2 objects put`: cf 1.0.0-beta.5 percent-encodes the
# slashes in the key, which R2 needs literal.
pnpm exec wrangler r2 object put "terminus-downloads/releases/$VERSION/terminus-$VERSION.apk" --file "$APK" --content-type application/vnd.android.package-archive --remote
pnpm exec wrangler r2 object put "terminus-downloads/releases/$VERSION/terminus-$VERSION-mac.zip" --file "$ZIP" --content-type application/zip --remote
# latest.json last, so /download/* never points at a file that isn't there yet.
pnpm exec wrangler r2 object put "terminus-downloads/latest.json" --file "$OUT/latest.json" --content-type application/json --remote
cd "$ROOT"

git tag -a "v$VERSION" -m "terminus $VERSION"
echo "== released $VERSION"
echo "   next: git push origin main v$VERSION"
echo "   and deploy the Worker if the API changed since the last deploy: pnpm run deploy"
