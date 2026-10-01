#!/bin/sh
# Release a version: tests, the Android APK to R2, and the tag. Pushing the
# tag runs .github/workflows/release.yml, which builds, signs and packages the
# Mac app, uploads it, marks the version released in latest.json and
# publishes the GitHub release with both files.
#
#   scripts/release.sh --dry-run   # test and build the APK, upload nothing
#   scripts/release.sh             # build, upload, tag v<version>
#
# Bump versionName/versionCode (Android) and CFBundleShortVersionString/
# CFBundleVersion (apps/macos/Support/Info.plist) together first.
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
MAC_VERSION=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' apps/macos/Support/Info.plist)
[ "$MAC_VERSION" = "$VERSION" ] || { echo "Android is $VERSION but the Mac app is $MAC_VERSION; bump both"; exit 1; }
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
(cd apps/android && JAVA_HOME="${JAVA_HOME:-/Applications/Android Studio.app/Contents/jbr/Contents/Home}" ./gradlew :app:assembleStableRelease :app:bundleStableRelease --console=plain -q)
APK="$OUT/terminus-$VERSION.apk"
cp apps/android/app/build/outputs/apk/stable/release/app-stable-release.apk "$APK"
# The same build as an app bundle, the format Google Play takes. Not
# published anywhere: upload it in Play Console.
cp apps/android/app/build/outputs/bundle/stableRelease/app-stable-release.aab "$OUT/terminus-$VERSION.aab"
echo "Play bundle: $OUT/terminus-$VERSION.aab"

# latest.json gets the new APK, but keeps the current Mac download and
# top-level version: the apps offer an update when that version changes, so
# it only moves once the release workflow has published the Mac app too.
sha() { shasum -a 256 "$1" | cut -d' ' -f1; }
size() { stat -f%z "$1"; }
curl -fsS https://terminus.rcn.sh/download/latest.json -o "$OUT/latest.before.json"
python3 - "$OUT/latest.before.json" "releases/$VERSION/terminus-$VERSION.apk" "$(sha "$APK")" "$(size "$APK")" > "$OUT/latest.json" <<'EOF'
import json, sys
path, file, sha256, size = sys.argv[1:]
latest = json.load(open(path))
latest['android'] = {'file': file, 'sha256': sha256, 'size': int(size)}
print(json.dumps(latest, indent=2))
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
# latest.json last, so /download/* never points at a file that isn't there yet.
pnpm exec wrangler r2 object put "terminus-downloads/latest.json" --file "$OUT/latest.json" --content-type application/json --remote
cd "$ROOT"

git tag -a "v$VERSION" -m "terminus $VERSION"
echo "== released $VERSION"
echo "   next: git push origin main v$VERSION"
echo "   GitHub Actions then builds, signs and uploads the Mac app and publishes the GitHub release:"
echo "   gh run watch -R rcnsh/terminus \$(gh run list -R rcnsh/terminus -w release -L 1 --json databaseId -q '.[0].databaseId')"
echo "   and deploy the Worker if the API changed since the last deploy: pnpm run deploy"
