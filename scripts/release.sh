#!/bin/sh
# Release a version, from this Mac: the tests, the Android APKs, the signed
# Mac DMG and its Sparkle appcast, all onto R2 with latest.json, then the tag
# and the GitHub release with every file.
#
#   scripts/release.sh --dry-run   # test, build and sign; upload nothing
#   scripts/release.sh             # also upload, tag v<version> and publish
#
# Bump versionName/versionCode (Android), CFBundleShortVersionString/
# CFBundleVersion (apps/macos/Support/Info.plist) and API_VERSION
# (apps/api/src/openapi.ts, the API docs) together first; a test checks.
#
# Signs with the keys on this Mac, as scripts/release-beta.sh does: the
# Android release key in ~/.gradle/gradle.properties (TERMINUS_*), the
# terminus certificate in the login keychain (~/.terminus/mac-signing.p12)
# and the Sparkle key in ~/.terminus/sparkle-ed25519.key. Without them an
# update would refuse to install over the real app.
set -eu
cd "$(dirname "$0")/.."
ROOT=$(pwd)
DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

[ "$(uname -s)" = Darwin ] || { echo "releases run on a Mac: the Mac app is built and signed here"; exit 1; }
VERSION=$(sed -n 's/.*versionName = "\(.*\)".*/\1/p' apps/android/app/build.gradle.kts)
[ -n "$VERSION" ] || { echo "no versionName found"; exit 1; }
case "$VERSION" in *-*) echo "$VERSION is a beta: release it with scripts/release-beta.sh"; exit 1 ;; esac
PLIST=apps/macos/Support/Info.plist
MAC_VERSION=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$PLIST")
[ "$MAC_VERSION" = "$VERSION" ] || { echo "Android is $VERSION but the Mac app is $MAC_VERSION; bump both"; exit 1; }
BUILD=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$PLIST")
ANDROID_BUILD=$(sed -n 's/.*versionCode = \([0-9]*\).*/\1/p' apps/android/app/build.gradle.kts | head -1)
[ "$BUILD" = "$ANDROID_BUILD" ] || { echo "Mac build is $BUILD but Android versionCode is $ANDROID_BUILD; bump both"; exit 1; }

grep -q "^TERMINUS_KEYSTORE=" "$HOME/.gradle/gradle.properties" 2>/dev/null || { echo "Android release key not configured (TERMINUS_KEYSTORE)"; exit 1; }
# The terminus self-signed certificate, by its SHA-1: every version must carry
# the same code identity, or macOS forgets the app's permissions and login item.
export SIGN_IDENTITY=C4EE234DA75ED3CD7699A31394C276801F93C4A9
security find-identity -p codesigning | grep -q "$SIGN_IDENTITY" || { echo "the terminus certificate isn't in the keychain: import ~/.terminus/mac-signing.p12"; exit 1; }
SPARKLE_KEY="$HOME/.terminus/sparkle-ed25519.key"
[ -f "$SPARKLE_KEY" ] || { echo "no Sparkle key at $SPARKLE_KEY"; exit 1; }

if [ $DRY -eq 0 ]; then
  git rev-parse -q --verify "refs/tags/v$VERSION" >/dev/null && { echo "v$VERSION is already tagged; bump versionName first"; exit 1; }
  # The tag must name exactly what was built: no uncommitted changes.
  [ -z "$(git status --porcelain)" ] || { echo "uncommitted changes; commit them before releasing"; exit 1; }
  # Only what's on GitHub's main is released, so the tag and the notes match it.
  git fetch -q origin main
  [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || { echo "this commit isn't origin/main; push main first"; exit 1; }
  gh auth status >/dev/null 2>&1 || { echo "gh isn't signed in: gh auth login"; exit 1; }
fi

mkdir -p build
echo "== terminus $VERSION (build $BUILD)"
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
# Android Studio's Java, unless JAVA_HOME says otherwise.
STUDIO_JAVA="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
if [ -z "${JAVA_HOME:-}" ] && [ -d "$STUDIO_JAVA" ]; then export JAVA_HOME="$STUDIO_JAVA"; fi
# Two runs: ABI splits are off for the bundle (app/build.gradle.kts), and
# AGP refuses a bundle in a run that also splits.
(cd apps/android && ./gradlew :app:assembleStableRelease --console=plain -q && ./gradlew :app:bundleStableRelease --console=plain -q)
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

echo "== mac"
PUBLISH=true scripts/package-mac.sh
DMG="$OUT/terminus-$VERSION.dmg"
# Installed Macs only take an update whose DMG this key signed.
SIG=$("$ROOT/apps/macos/.build/artifacts/sparkle/Sparkle/bin/sign_update" --ed-key-file "$SPARKLE_KEY" -p "$DMG")
printf '%s' "$SIG" | grep -q . || { echo "sign_update gave no signature"; exit 1; }
MIN_OS=$(/usr/libexec/PlistBuddy -c 'Print :LSMinimumSystemVersion' "$PLIST")
# The appcast: one item, the new version. Sparkle compares CFBundleVersion.
python3 scripts/appcast.py "$VERSION" "$BUILD" "$MIN_OS" "$SIG" "$DMG" https://terminus.rcn.sh > "$OUT/appcast.xml"

# latest.json names every current file. Its top-level version is what the
# apps compare to offer an update, so it moves with both downloads at once.
python3 - "$VERSION" "$OUT" > "$OUT/latest.json" <<'EOF'
import datetime, hashlib, json, os, sys
version, out = sys.argv[1:]
def entry(name):
    p = os.path.join(out, name)
    return {'file': f'releases/{version}/{name}', 'sha256': hashlib.sha256(open(p, 'rb').read()).hexdigest(), 'size': os.path.getsize(p)}
abis = {'arm64-v8a': f'terminus-{version}.apk', 'armeabi-v7a': f'terminus-{version}-armv7.apk', 'x86_64': f'terminus-{version}-x86_64.apk'}
android = {abi: entry(name) for abi, name in abis.items()}
print(json.dumps({
    'version': version,
    'released': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
    'android': android['arm64-v8a'],
    'androidAbis': android,
    'mac': entry(f'terminus-{version}.dmg'),
}, indent=2))
EOF
cat "$OUT/latest.json"

if [ $DRY -eq 1 ]; then
  echo "== dry run: nothing uploaded or tagged (files in $OUT)"
  exit 0
fi

echo "== upload"
# Wrangler, not `cf r2 objects put`: cf percent-encodes the slashes in the
# key, which R2 needs literal.
r2() { (cd "$ROOT/apps/api" && pnpm exec wrangler r2 object put "terminus-downloads/$1" --file "$2" --content-type "$3" --remote); }
for f in "terminus-$VERSION.apk" "terminus-$VERSION-armv7.apk" "terminus-$VERSION-x86_64.apk"; do
  r2 "releases/$VERSION/$f" "$OUT/$f" application/vnd.android.package-archive
done
r2 "releases/$VERSION/terminus-$VERSION.dmg" "$DMG" application/x-apple-diskimage
r2 appcast.xml "$OUT/appcast.xml" "application/xml; charset=utf-8"
# latest.json last, so /download/* never points at a file that isn't there yet.
r2 latest.json "$OUT/latest.json" application/json

echo "== GitHub"
git tag -a "v$VERSION" -m "terminus $VERSION"
git push -q origin "v$VERSION"
scripts/github-release.sh "$VERSION"
echo "== released $VERSION"
echo "   deploy the Worker too if the API changed since the last deploy: (cd apps/api && pnpm run deploy)"
echo "   (it applies any pending D1 migrations first; they must be additive, see apps/api/docs/internals.md)"
