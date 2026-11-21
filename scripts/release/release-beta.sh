#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/../.."
ROOT=$(pwd)
USAGE="usage: scripts/release/release-beta.sh <version, e.g. 2.0.1-beta.1> [--dry-run]"
VERSION=
DRY=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    -*) echo "$USAGE (\"$arg\" isn't an option)"; exit 1 ;;
    *) [ -z "$VERSION" ] || { echo "$USAGE (one version only)"; exit 1; }; VERSION=$arg ;;
  esac
done
[ -n "$VERSION" ] || { echo "$USAGE"; exit 1; }
. scripts/release/release-lib.sh
SITE=https://beta.terminus.run
BUCKET=terminus-beta

VERSION_RE='^[0-9]+\.[0-9]+\.[0-9]+(-beta\.[0-9]+)?$'
[[ $VERSION =~ $VERSION_RE ]] || die "a beta version looks like 2.0.1-beta.1 (or a release's, 2.0.1)"
[ "$(uname -s)" = Darwin ] || die "releases run on a Mac: the Mac app is built and signed here"
BUILD=$(git rev-list --count HEAD)
BETA_D1=$(sed -n '/^const BETA = {/,/^};/s/.*d1: "\(.*\)".*/\1/p' apps/api/cloudflare.config.ts)
[ -n "$BETA_D1" ] || [ $DRY -eq 1 ] || die "the beta's D1 id isn't in apps/api/cloudflare.config.ts yet"
grep -q "^TERMINUS_KEYSTORE=" "${GRADLE_USER_HOME:-$HOME/.gradle}/gradle.properties" 2>/dev/null || die "Android release key not configured (TERMINUS_KEYSTORE)"
no_api_base
export SIGN_IDENTITY=B0692598973AE875C270263F0403FE4495EEF562
has_sign_identity
export NOTARY_PROFILE=terminus-notary
has_notary_profile
SPARKLE_KEY="$HOME/.terminus/sparkle-ed25519.key"
[ -f "$SPARKLE_KEY" ] || die "no Sparkle key at $SPARKLE_KEY"
BETA=0
case "$VERSION" in *-beta.*) BETA=1 ;; esac

TAG_LOCAL=0 TAG_REMOTE=0 GH_RELEASE=0
if [ $DRY -eq 0 ]; then
  [ -z "$(git status --porcelain)" ] || die "uncommitted changes; commit them before releasing"
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

live_check() {
  python3 scripts/release/release-check.py "$@" && return 0
  [ $DRY -eq 1 ] && { echo "   (a release would stop here)"; return 0; }
  exit 1
}

mkdir -p build
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
APKS=apps/android/app/build/outputs/apk/beta/release
APK="$OUT/terminus-$VERSION.apk"
cp "$APKS/app-beta-arm64-v8a-release.apk" "$APK"
cp "$APKS/app-beta-armeabi-v7a-release.apk" "$OUT/terminus-$VERSION-armv7.apk"
cp "$APKS/app-beta-x86_64-release.apk" "$OUT/terminus-$VERSION-x86_64.apk"
apks_signed "$APK" "$OUT/terminus-$VERSION-armv7.apk" "$OUT/terminus-$VERSION-x86_64.apk"

echo "== mac"
CHANNEL=beta BETA_VERSION="$VERSION" BETA_BUILD="$BUILD" RELEASES="$RELEASES" PUBLISH=true scripts/release/package-mac.sh
DMG="$OUT/terminus-$VERSION.dmg"
sign_update_tool
SIG=$("$SIGN_UPDATE" --ed-key-file "$SPARKLE_KEY" -p "$DMG")
[ -n "$SIG" ] || die "sign_update gave no signature"
sparkle_signed "apps/macos/build/terminus beta.app" "$SIG" "$DMG"
MIN_OS=$(/usr/libexec/PlistBuddy -c 'Print :LSMinimumSystemVersion' apps/macos/Support/Info.plist)
python3 scripts/release/appcast.py "$VERSION" "$BUILD" "$MIN_OS" "$SIG" "$DMG" "$SITE" beta > "$OUT/appcast.xml"
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
(cd apps/api && pnpm run deploy:beta)
echo "== live beta"
live_release "$SITE"
build_goes_up "commit to main and run again (the build is the commit count)"
for try in 1 2 3 4 5 6; do
  python3 scripts/release/release-check.py api "$SITE" "$API_VERSION" && break
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
  CHANNEL=beta scripts/release/github-release.sh "$VERSION"
fi
STAGE=done
