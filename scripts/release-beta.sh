#!/bin/bash
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
# it only goes up along main; it must be above the live beta's. Nothing is
# uploaded until the beta Worker answers with this commit's API. A release's
# own version (2.0.0) can go out on the beta too, so the beta apps move onto
# it from their betas. Nothing touches the stable site, its data or its
# downloads. It runs on this Mac from origin/main once CI has passed on it,
# and signs with the same keys as stable (the Android release key in
# ~/.gradle, the terminus certificate in the login keychain and the Sparkle
# key in ~/.terminus), each checked against what the apps trust.
#
# Last, a beta version gets its tag (pushed) and a GitHub pre-release with
# both files and the commits since the previous tag. A release's version
# already has its own, from scripts/release.sh.
#
# Each run starts from the lockfiles, as scripts/release.sh does.
#
# A dry run builds into build/dry-run/beta/<version>; a release into
# build/release/beta/<version>. If a release stops after it starts deploying,
# it says what's live and the commands that finish it.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$(pwd)
VERSION="${1:?usage: scripts/release-beta.sh <version, e.g. 2.0.1-beta.1> [--dry-run]}"
DRY=0
[ "${2:-}" = "--dry-run" ] && DRY=1
. scripts/release-lib.sh
SITE=https://beta.terminus.rcn.sh
BUCKET=terminus-beta-downloads

# Not `echo | grep`: grep passes a version with a newline in it if any one
# line matches, and it names a directory that's deleted, R2 keys and the tag.
VERSION_RE='^[0-9]+\.[0-9]+\.[0-9]+(-beta\.[0-9]+)?$'
[[ $VERSION =~ $VERSION_RE ]] || die "a beta version looks like 2.0.1-beta.1 (or a release's, 2.0.1)"
[ "$(uname -s)" = Darwin ] || die "releases run on a Mac: the Mac app is built and signed here"
BUILD=$(git rev-list --count HEAD)
BETA_D1=$(sed -n '/^const BETA = {/,/^};/s/.*d1: "\(.*\)".*/\1/p' apps/api/cloudflare.config.ts)
[ -n "$BETA_D1" ] || [ $DRY -eq 1 ] || die "the beta's D1 id isn't in apps/api/cloudflare.config.ts yet"
grep -q "^TERMINUS_KEYSTORE=" "$HOME/.gradle/gradle.properties" 2>/dev/null || die "Android release key not configured (TERMINUS_KEYSTORE)"
no_api_base
# The terminus certificate, as for stable: the beta app keeps its own
# permissions and login item across updates only with the same code identity.
export SIGN_IDENTITY=C4EE234DA75ED3CD7699A31394C276801F93C4A9
has_sign_identity
SPARKLE_KEY="$HOME/.terminus/sparkle-ed25519.key"
[ -f "$SPARKLE_KEY" ] || die "no Sparkle key at $SPARKLE_KEY"
BETA=0
case "$VERSION" in *-beta.*) BETA=1 ;; esac

TAG_LOCAL=0 TAG_REMOTE=0 GH_RELEASE=0
if [ $DRY -eq 0 ]; then
  # What's released must be what's committed, untracked files included: the
  # Swift package and Gradle build whatever sources are on disk.
  [ -z "$(git status --porcelain)" ] || die "uncommitted changes; commit them before releasing"
  # Only what's on GitHub's main, so the tag and the notes match it.
  git fetch -q origin main
  [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || die "this commit isn't origin/main; push main first"
  gh auth status >/dev/null 2>&1 || die "gh isn't signed in: gh auth login"
  ci_passed
  if [ $BETA -eq 1 ]; then
    tag_state "v$VERSION"
    if [ $GH_RELEASE -eq 1 ]; then
      die "v$VERSION is already released; pick the next number"
    elif [ $TAG_LOCAL -eq 1 ] || [ $TAG_REMOTE -eq 1 ]; then
      echo "v$VERSION is tagged but has no GitHub release: a beta stopped partway."
      echo "If its files are live ($SITE/download/latest.json says $VERSION), finish it with:"
      finish_steps CHANNEL=beta
      die "If they aren't, delete the tag (git tag -d v$VERSION; git push origin :v$VERSION) and run again."
    fi
  fi
fi
live_release "$SITE"
if [ "$LIVE_VERSION" = "$VERSION" ]; then
  if [ $DRY -eq 1 ]; then
    echo "warning: $VERSION is already the beta (a real release would stop here)"
  elif [ $BETA -eq 1 ]; then
    echo "$VERSION is already the beta but isn't tagged: if a beta stopped partway, finish it with:"
    finish_steps CHANNEL=beta
    die "Otherwise pick the next number."
  else
    die "$VERSION is already the beta"
  fi
fi
build_goes_up "commit to main and run again (the build is the commit count)"

# Whether the live beta's API is this commit's (scripts/release-check.py).
# A dry run reports and carries on.
live_check() {
  python3 scripts/release-check.py "$@" && return 0
  [ $DRY -eq 1 ] && { echo "   (a release would stop here)"; return 0; }
  exit 1
}

mkdir -p build
# A dry run builds apart, so it never wipes the files a stopped release
# needs to finish (github-release.sh reads build/release/beta/<version>).
RELEASES="$ROOT/build/release"
[ $DRY -eq 0 ] || RELEASES="$ROOT/build/dry-run"
OUT="$RELEASES/beta/$VERSION"
rm -rf "$OUT"
mkdir -p "$OUT"
echo "== terminus beta $VERSION (build $BUILD, $(git rev-parse --short HEAD))"
fresh_deps

echo "== tests"
if ! pnpm --silent check >"$ROOT/build/test.log" 2>&1; then
  tail -40 "$ROOT/build/test.log"; die "== tests or typecheck FAILED; nothing released"
fi
echo "api tests and typecheck pass"

# From here a failure says what's live and how to finish.
STAGE=build
stopped() {
  [ "$1" -ne 0 ] || return 0
  case $STAGE in
    build) echo "== stopped before deploying: nothing is live" ;;
    deploy) echo "== stopped deploying the beta Worker: nothing is uploaded. Fix it and run again (its migrations are additive, so ones already applied are fine)" ;;
    upload)
      echo "== stopped uploading: the beta Worker is deployed and some of $VERSION's files may be on R2, but latest.json isn't."
      echo "Upload them all again (each overwrites), in this order:"
      upload_steps
      if [ $BETA -eq 1 ]; then echo "then:"; finish_steps CHANNEL=beta; fi ;;
    *)
      echo "== $VERSION's files are live on the beta. Finish the release with:"
      tag_state "v$VERSION"; finish_steps CHANNEL=beta ;;
  esac
}
trap 'stopped $?' EXIT

echo "== android"
(cd apps/android && JAVA_HOME="${JAVA_HOME:-/Applications/Android Studio.app/Contents/jbr/Contents/Home}" \
  ./gradlew :app:assembleBetaRelease -PbetaVersion="$VERSION" -PbetaCode="$BUILD" --console=plain -q)
# One APK per CPU type, as scripts/release.sh.
APKS=apps/android/app/build/outputs/apk/beta/release
APK="$OUT/terminus-$VERSION.apk"
cp "$APKS/app-beta-arm64-v8a-release.apk" "$APK"
cp "$APKS/app-beta-armeabi-v7a-release.apk" "$OUT/terminus-$VERSION-armv7.apk"
cp "$APKS/app-beta-x86_64-release.apk" "$OUT/terminus-$VERSION-x86_64.apk"
apks_signed "$APK" "$OUT/terminus-$VERSION-armv7.apk" "$OUT/terminus-$VERSION-x86_64.apk"

echo "== mac"
# Set here, whatever the shell has: they make package-mac.sh build the beta.
CHANNEL=beta BETA_VERSION="$VERSION" BETA_BUILD="$BUILD" RELEASES="$RELEASES" PUBLISH=true scripts/package-mac.sh
DMG="$OUT/terminus-$VERSION.dmg"
sign_update_tool
SIG=$("$SIGN_UPDATE" --ed-key-file "$SPARKLE_KEY" -p "$DMG")
[ -n "$SIG" ] || die "sign_update gave no signature"
sparkle_signed "apps/macos/build/terminus beta.app" "$SIG" "$DMG"
MIN_OS=$(/usr/libexec/PlistBuddy -c 'Print :LSMinimumSystemVersion' apps/macos/Support/Info.plist)
python3 scripts/appcast.py "$VERSION" "$BUILD" "$MIN_OS" "$SIG" "$DMG" "$SITE" beta > "$OUT/appcast.xml"
sign_appcast "$OUT/appcast.xml"

python3 - "$VERSION" "$APK" "$DMG" > "$OUT/latest.json" <<'EOF'
import datetime, hashlib, json, os, sys
version, apk, dmg = sys.argv[1:]
def entry(path):
    return {'file': f'releases/{version}/{os.path.basename(path)}', 'sha256': hashlib.sha256(open(path, 'rb').read()).hexdigest(), 'size': os.path.getsize(path)}
abis = {'arm64-v8a': apk, 'armeabi-v7a': apk.replace('.apk', '-armv7.apk'), 'x86_64': apk.replace('.apk', '-x86_64.apk')}
print(json.dumps({
    'version': version,
    'released': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
    'android': entry(apk),
    'androidAbis': {abi: entry(p) for abi, p in abis.items()},
    'mac': entry(dmg),
}, indent=2))
EOF
cat "$OUT/latest.json"

# The beta's apps expect this commit's API (API_VERSION, apps/api/src/openapi.ts).
API_VERSION=$(sed -n "s/^export const API_VERSION = '\(.*\)';/\1/p" apps/api/src/openapi.ts)
[ -n "$API_VERSION" ] || { echo "no API_VERSION in apps/api/src/openapi.ts"; exit 1; }

if [ $DRY -eq 1 ]; then
  echo "== live beta (before this run's deploy)"
  live_check api "$SITE" "$API_VERSION"
  echo "== dry run: nothing deployed or uploaded (files in $OUT)"
  exit 0
fi

echo "== beta Worker"
STAGE=deploy
# deploy:beta applies the beta D1's pending migrations first.
(cd apps/api && pnpm run deploy:beta)
# Before the appcast: the deploy landed, and nothing went up since the
# first check. A new deploy can take a few seconds to answer everywhere.
echo "== live beta"
live_release "$SITE"
build_goes_up "commit to main and run again (the build is the commit count)"
for try in 1 2 3 4 5 6; do
  python3 scripts/release-check.py api "$SITE" "$API_VERSION" && break
  [ "$try" = 6 ] && exit 1
  sleep 10
done

echo "== upload"
STAGE=upload
upload_all
echo "== released beta $VERSION at $SITE"

if [ $BETA -eq 1 ]; then
  echo "== GitHub"
  STAGE=tag
  git tag -a "v$VERSION" -m "terminus $VERSION"
  STAGE=push
  git push -q origin "v$VERSION"
  STAGE=github
  CHANNEL=beta scripts/github-release.sh "$VERSION"
fi
STAGE=done
