#!/bin/bash
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
# The build must be above the live one, and CI must have passed on the commit.
#
# Signs with the keys on this Mac, as scripts/release-beta.sh does: the
# Android release key in ~/.gradle/gradle.properties (TERMINUS_*), the
# terminus certificate in the login keychain (~/.terminus/mac-signing.p12)
# and the Sparkle key in ~/.terminus/sparkle-ed25519.key. Without them an
# update would refuse to install over the real app, so each is checked
# against what the apps trust before anything is uploaded.
#
# Each run starts from the lockfiles: node_modules and apps/macos/.build are
# deleted and installed again, so nothing left in them is trusted.
#
# A dry run builds into build/dry-run/<version>; a release into
# build/release/<version>. If a release stops after its first upload, it
# says what's live and the commands that finish it.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$(pwd)
DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1
# These pick the beta in package-mac.sh and github-release.sh; one left in
# the shell from a beta would make this release a beta's.
unset CHANNEL BETA_VERSION BETA_BUILD
. scripts/release-lib.sh

[ "$(uname -s)" = Darwin ] || die "releases run on a Mac: the Mac app is built and signed here"
# Only defaultConfig's literal lines: the beta's `versionCode = it.toInt()` isn't one.
GRADLE=apps/android/app/build.gradle.kts
NAME_RE='^[[:space:]]*versionName = "([^"]+)"[[:space:]]*$'
CODE_RE='^[[:space:]]*versionCode = ([0-9]+)[[:space:]]*$'
[ "$(grep -Ec "$NAME_RE" "$GRADLE")" = 1 ] || die "expected one versionName = \"<version>\" line in $GRADLE"
[ "$(grep -Ec "$CODE_RE" "$GRADLE")" = 1 ] || die "expected one versionCode = <number> line in $GRADLE"
VERSION=$(sed -nE "s/$NAME_RE/\\1/p" "$GRADLE")
ANDROID_BUILD=$(sed -nE "s/$CODE_RE/\\1/p" "$GRADLE")
case "$VERSION" in *-*) die "$VERSION is a beta: release it with scripts/release-beta.sh" ;; esac
# It names a directory that's deleted, R2 keys and the tag: digits only.
VERSION_RE='^[0-9]+\.[0-9]+\.[0-9]+$'
[[ $VERSION =~ $VERSION_RE ]] || die "versionName \"$VERSION\" in $GRADLE isn't a version like 2.1.0"
PLIST=apps/macos/Support/Info.plist
MAC_VERSION=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$PLIST")
[ "$MAC_VERSION" = "$VERSION" ] || die "Android is $VERSION but the Mac app is $MAC_VERSION; bump both"
BUILD=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$PLIST")
[ "$BUILD" = "$ANDROID_BUILD" ] || die "Mac build is $BUILD but Android versionCode is $ANDROID_BUILD; bump both"

grep -q "^TERMINUS_KEYSTORE=" "$HOME/.gradle/gradle.properties" 2>/dev/null || die "Android release key not configured (TERMINUS_KEYSTORE)"
no_api_base
# The terminus self-signed certificate (see has_sign_identity).
export SIGN_IDENTITY=C4EE234DA75ED3CD7699A31394C276801F93C4A9
has_sign_identity
SPARKLE_KEY="$HOME/.terminus/sparkle-ed25519.key"
[ -f "$SPARKLE_KEY" ] || die "no Sparkle key at $SPARKLE_KEY"

SITE=https://terminus.rcn.sh
BUCKET=terminus-downloads
if [ $DRY -eq 0 ]; then
  # The tag must name exactly what was built: no uncommitted changes.
  [ -z "$(git status --porcelain)" ] || die "uncommitted changes; commit them before releasing"
  # Only what's on GitHub's main is released, so the tag and the notes match it.
  git fetch -q origin main
  [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || die "this commit isn't origin/main; push main first"
  gh auth status >/dev/null 2>&1 || die "gh isn't signed in: gh auth login"
  ci_passed
  tag_state "v$VERSION"
  if [ $GH_RELEASE -eq 1 ]; then
    die "v$VERSION is already released; bump versionName first"
  elif [ $TAG_LOCAL -eq 1 ] || [ $TAG_REMOTE -eq 1 ]; then
    echo "v$VERSION is tagged but has no GitHub release: a release stopped partway."
    echo "If its files are live ($SITE/download/latest.json says $VERSION), finish it with:"
    finish_steps
    die "If they aren't, delete the tag (git tag -d v$VERSION; git push origin :v$VERSION) and run again."
  fi
fi
live_release "$SITE"
if [ $DRY -eq 0 ] && [ "$LIVE_VERSION" = "$VERSION" ]; then
  echo "$VERSION's files are already live but it isn't tagged: a release stopped partway. Finish it with:"
  finish_steps
  exit 1
fi
build_goes_up "bump versionCode and CFBundleVersion"

mkdir -p build
echo "== terminus $VERSION (build $BUILD)"
fresh_deps
echo "== tests"
# Not `pnpm test && echo`: under set -e a failure on the left of && does not
# stop the script, so a failing suite would still build, upload and tag.
if ! pnpm --silent check >"$ROOT/build/test.log" 2>&1; then
  tail -40 "$ROOT/build/test.log"; die "== tests or typecheck FAILED; nothing released"
fi
echo "api tests and typecheck pass"

# A dry run builds apart, so it never wipes the files a stopped release
# needs to finish (github-release.sh reads build/release/<version>).
RELEASES="$ROOT/build/release"
[ $DRY -eq 0 ] || RELEASES="$ROOT/build/dry-run"
OUT="$RELEASES/$VERSION"
rm -rf "$OUT"
mkdir -p "$OUT"

# From here a failure says what's live and how to finish.
STAGE=build
stopped() {
  [ "$1" -ne 0 ] || return 0
  case $STAGE in
    build) echo "== stopped before uploading: nothing is live" ;;
    upload)
      echo "== stopped uploading: some of $VERSION's files may be on R2, but latest.json isn't."
      echo "Upload them all again (each overwrites), in this order:"
      upload_steps
      echo "then:"; finish_steps ;;
    *)
      echo "== $VERSION's files are live. Finish the release with:"
      tag_state "v$VERSION"; finish_steps ;;
  esac
}
trap 'stopped $?' EXIT

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
apks_signed "$APK" "$OUT/terminus-$VERSION-armv7.apk" "$OUT/terminus-$VERSION-x86_64.apk"
# The same build as an app bundle, the format Google Play takes. Not
# published anywhere: upload it in Play Console.
cp apps/android/app/build/outputs/bundle/stableRelease/app-stable-release.aab "$OUT/terminus-$VERSION.aab"
echo "Play bundle: $OUT/terminus-$VERSION.aab"

echo "== mac"
RELEASES="$RELEASES" PUBLISH=true scripts/package-mac.sh
DMG="$OUT/terminus-$VERSION.dmg"
# Installed Macs only take an update whose DMG this key signed. The tool is
# checked again just before it gets the key: the builds since ran code too.
sign_update_tool
SIG=$("$SIGN_UPDATE" --ed-key-file "$SPARKLE_KEY" -p "$DMG")
[ -n "$SIG" ] || die "sign_update gave no signature"
sparkle_signed apps/macos/build/terminus.app "$SIG" "$DMG"
MIN_OS=$(/usr/libexec/PlistBuddy -c 'Print :LSMinimumSystemVersion' "$PLIST")
# The appcast: one item, the new version. Sparkle compares CFBundleVersion.
python3 scripts/appcast.py "$VERSION" "$BUILD" "$MIN_OS" "$SIG" "$DMG" "$SITE" stable > "$OUT/appcast.xml"
sign_appcast "$OUT/appcast.xml"

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
STAGE=upload
upload_all

echo "== GitHub"
STAGE=tag
git tag -a "v$VERSION" -m "terminus $VERSION"
STAGE=push
git push -q origin "v$VERSION"
STAGE=github
scripts/github-release.sh "$VERSION"
STAGE=done
echo "== released $VERSION"
echo "   deploy the Worker too if the API changed since the last deploy: (cd apps/api && pnpm run deploy)"
echo "   (it applies any pending D1 migrations first; they must be additive, see apps/api/docs/internals.md)"
