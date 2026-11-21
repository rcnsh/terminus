#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/../.."
ROOT=$(pwd)
DRY=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    *) echo "usage: scripts/release/release.sh [--dry-run] (\"$arg\" isn't an option; the version comes from build.gradle.kts)"; exit 1 ;;
  esac
done
unset CHANNEL BETA_VERSION BETA_BUILD
. scripts/release/release-lib.sh

[ "$(uname -s)" = Darwin ] || die "releases run on a Mac: the Mac app is built and signed here"
GRADLE=apps/android/app/build.gradle.kts
NAME_RE='^[[:space:]]*versionName = "([^"]+)"[[:space:]]*$'
CODE_RE='^[[:space:]]*versionCode = ([0-9]+)[[:space:]]*$'
[ "$(grep -Ec "$NAME_RE" "$GRADLE")" = 1 ] || die "expected one versionName = \"<version>\" line in $GRADLE"
[ "$(grep -Ec "$CODE_RE" "$GRADLE")" = 1 ] || die "expected one versionCode = <number> line in $GRADLE"
VERSION=$(sed -nE "s/$NAME_RE/\\1/p" "$GRADLE")
ANDROID_BUILD=$(sed -nE "s/$CODE_RE/\\1/p" "$GRADLE")
case "$VERSION" in *-*) die "$VERSION is a beta: release it with scripts/release/release-beta.sh" ;; esac
VERSION_RE='^[0-9]+\.[0-9]+\.[0-9]+$'
[[ $VERSION =~ $VERSION_RE ]] || die "versionName \"$VERSION\" in $GRADLE isn't a version like 2.1.0"
PLIST=apps/macos/Support/Info.plist
MAC_VERSION=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$PLIST")
[ "$MAC_VERSION" = "$VERSION" ] || die "Android is $VERSION but the Mac app is $MAC_VERSION; bump both"
BUILD=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$PLIST")
[ "$BUILD" = "$ANDROID_BUILD" ] || die "Mac build is $BUILD but Android versionCode is $ANDROID_BUILD; bump both"

grep -q "^TERMINUS_KEYSTORE=" "${GRADLE_USER_HOME:-$HOME/.gradle}/gradle.properties" 2>/dev/null || die "Android release key not configured (TERMINUS_KEYSTORE)"
no_api_base
export SIGN_IDENTITY=B0692598973AE875C270263F0403FE4495EEF562
has_sign_identity
export NOTARY_PROFILE=terminus-notary
has_notary_profile
SPARKLE_KEY="$HOME/.terminus/sparkle-ed25519.key"
[ -f "$SPARKLE_KEY" ] || die "no Sparkle key at $SPARKLE_KEY"

SITE=https://terminus.run
BUCKET=terminus
RELEASES="$ROOT/build/release"
[ $DRY -eq 0 ] || RELEASES="$ROOT/build/dry-run"
OUT="$RELEASES/$VERSION"
FEEDS_AFTER_TAG=1
if [ $DRY -eq 0 ]; then
  [ -z "$(git status --porcelain)" ] || die "uncommitted changes; commit them before releasing"
  git fetch -q origin main
  [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || die "this commit isn't origin/main; push main first"
  gh auth status >/dev/null 2>&1 || die "gh isn't signed in: gh auth login"
  ci_passed
  tag_state "v$VERSION"
  if [ $GH_RELEASE -eq 1 ]; then
    die "v$VERSION is already released; bump versionName first"
  elif [ $TAG_LOCAL -eq 1 ] || [ $TAG_REMOTE -eq 1 ]; then
    echo "v$VERSION is tagged but has no GitHub release: a release stopped partway."
    echo "If $OUT still holds its files, finish it with:"
    finish_steps
    die "If it doesn't, delete the tag (git tag -d v$VERSION; git push origin :v$VERSION) and run again."
  fi
fi
live_release "$SITE"
if [ $DRY -eq 0 ] && [ "$LIVE_VERSION" = "$VERSION" ]; then
  echo "$VERSION's files are already live but it isn't tagged: a release stopped partway. Finish it with:"
  finish_steps
  exit 1
fi
build_goes_up "bump versionCode and CFBundleVersion"

live_check() {
  python3 scripts/release/release-check.py "$@" && return 0
  [ $DRY -eq 1 ] && { echo "   (a release would stop here)"; return 0; }
  exit 1
}

mkdir -p build
echo "== terminus $VERSION (build $BUILD)"
echo "== live site"
live_check api "$SITE" "$VERSION"
fresh_deps
echo "== tests"
if ! pnpm --silent check >"$ROOT/build/test.log" 2>&1; then
  tail -40 "$ROOT/build/test.log"; die "== tests or typecheck FAILED; nothing released"
fi
echo "api tests and typecheck pass"

rm -rf "$OUT"
mkdir -p "$OUT"

STAGE=build
stopped() {
  [ "$1" -ne 0 ] || return 0
  case $STAGE in
    build) echo "== stopped before uploading: nothing is live" ;;
    files) echo "== stopped uploading the APKs and the DMG: nothing links to them yet, so running again is safe" ;;
    *)
      echo "== stopped after uploading $VERSION's APKs and DMG. Finish the release with:"
      tag_state "v$VERSION"; finish_steps ;;
  esac
}
trap 'stopped $?' EXIT

echo "== android"
STUDIO_JAVA="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
if [ -z "${JAVA_HOME:-}" ] && [ -d "$STUDIO_JAVA" ]; then export JAVA_HOME="$STUDIO_JAVA"; fi
(cd apps/android && ./gradlew :app:assembleStableRelease --console=plain -q && ./gradlew :app:bundleStableRelease --console=plain -q)
APKS=apps/android/app/build/outputs/apk/stable/release
APK="$OUT/terminus-$VERSION.apk"
cp "$APKS/app-stable-arm64-v8a-release.apk" "$APK"
cp "$APKS/app-stable-armeabi-v7a-release.apk" "$OUT/terminus-$VERSION-armv7.apk"
cp "$APKS/app-stable-x86_64-release.apk" "$OUT/terminus-$VERSION-x86_64.apk"
apks_signed "$APK" "$OUT/terminus-$VERSION-armv7.apk" "$OUT/terminus-$VERSION-x86_64.apk"
cp apps/android/app/build/outputs/bundle/stableRelease/app-stable-release.aab "$OUT/terminus-$VERSION.aab"
echo "Play bundle: $OUT/terminus-$VERSION.aab"

echo "== mac"
RELEASES="$RELEASES" PUBLISH=true scripts/release/package-mac.sh
DMG="$OUT/terminus-$VERSION.dmg"
sign_update_tool
SIG=$("$SIGN_UPDATE" --ed-key-file "$SPARKLE_KEY" -p "$DMG")
[ -n "$SIG" ] || die "sign_update gave no signature"
sparkle_signed apps/macos/build/terminus.app "$SIG" "$DMG"
MIN_OS=$(/usr/libexec/PlistBuddy -c 'Print :LSMinimumSystemVersion' "$PLIST")
python3 scripts/release/appcast.py "$VERSION" "$BUILD" "$MIN_OS" "$SIG" "$DMG" "$SITE" stable > "$OUT/appcast.xml"
sign_appcast "$OUT/appcast.xml"

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

echo "== live site"
live_release "$SITE"
build_goes_up "bump versionCode and CFBundleVersion"
live_check api "$SITE" "$VERSION"

echo "== upload"
STAGE=files
upload_all files
echo "== tag v$VERSION"
STAGE=tag
git tag -a "v$VERSION" -m "terminus $VERSION"
STAGE=push
git push -q origin "v$VERSION"
STAGE=feeds
upload_all feeds

echo "== GitHub"
STAGE=github
scripts/release/github-release.sh "$VERSION"
STAGE=done
echo "== released $VERSION"
