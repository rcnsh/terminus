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
case "$VERSION" in *-*) echo "$VERSION is a beta: release it with scripts/release-beta.sh"; exit 1 ;; esac
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
# One APK per CPU type: terminus-<v>.apk (arm64, nearly every phone, and the
# file older apps and links know), -armv7 (older 32-bit phones), -x86_64.
APKS=apps/android/app/build/outputs/apk/stable/release
APK="$OUT/terminus-$VERSION.apk"
cp "$APKS/app-stable-arm64-v8a-release.apk" "$APK"
cp "$APKS/app-stable-armeabi-v7a-release.apk" "$OUT/terminus-$VERSION-armv7.apk"
cp "$APKS/app-stable-x86_64-release.apk" "$OUT/terminus-$VERSION-x86_64.apk"
# The same build as an app bundle, the format Google Play takes. Not
# published anywhere: upload it in Play Console.
cp apps/android/app/build/outputs/bundle/stableRelease/app-stable-release.aab "$OUT/terminus-$VERSION.aab"
echo "Play bundle: $OUT/terminus-$VERSION.aab"

# latest.json gets the new APK, but keeps the current Mac download and
# top-level version: the apps offer an update when that version changes, so
# it only moves once the release workflow has published the Mac app too.
curl -fsS https://terminus.rcn.sh/download/latest.json -o "$OUT/latest.before.json"
python3 - "$OUT/latest.before.json" "$VERSION" "$OUT" > "$OUT/latest.json" <<'EOF'
import hashlib, json, os, sys
path, version, out = sys.argv[1:]
latest = json.load(open(path))
def entry(name):
    p = os.path.join(out, name)
    return {'file': f'releases/{version}/{name}', 'sha256': hashlib.sha256(open(p, 'rb').read()).hexdigest(), 'size': os.path.getsize(p)}
abis = {'arm64-v8a': f'terminus-{version}.apk', 'armeabi-v7a': f'terminus-{version}-armv7.apk', 'x86_64': f'terminus-{version}-x86_64.apk'}
latest['androidAbis'] = {abi: entry(name) for abi, name in abis.items()}
latest['android'] = latest['androidAbis']['arm64-v8a']
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
for f in "terminus-$VERSION.apk" "terminus-$VERSION-armv7.apk" "terminus-$VERSION-x86_64.apk"; do
  pnpm exec wrangler r2 object put "terminus-downloads/releases/$VERSION/$f" --file "$OUT/$f" --content-type application/vnd.android.package-archive --remote
done
# latest.json last, so /download/* never points at a file that isn't there yet.
pnpm exec wrangler r2 object put "terminus-downloads/latest.json" --file "$OUT/latest.json" --content-type application/json --remote
cd "$ROOT"

git tag -a "v$VERSION" -m "terminus $VERSION"
echo "== released $VERSION"
echo "   next: git push origin main v$VERSION"
echo "   GitHub Actions then builds, signs and uploads the Mac app and publishes the GitHub release:"
echo "   gh run watch -R rcnsh/terminus \$(gh run list -R rcnsh/terminus -w release -L 1 --json databaseId -q '.[0].databaseId')"
echo "   and deploy the Worker if the API changed since the last deploy: pnpm run deploy"
