# Checks and steps shared by scripts/release.sh and scripts/release-beta.sh,
# which source this file from the repo root. Each check stops the release
# and says what to do; they read VERSION, BUILD, OUT, BUCKET and DRY from the
# script that sources them.

die() { echo "$*"; exit 1; }

# The same on both: under --dry-run a check that can't pass yet only warns.
warn_or_die() {
  if [ "$DRY" -eq 1 ]; then echo "warning: $* (a real release would stop here)"; else die "$*"; fi
}

# -PapiBase points a build at another host (apps/android/app/build.gradle.kts).
# Gradle also takes it from these, and a signed APK must talk to the real one.
no_api_base() {
  for f in "${GRADLE_USER_HOME:-$HOME/.gradle}/gradle.properties" apps/android/gradle.properties; do
    if grep -Eq '^[[:space:]]*apiBase[[:space:]]*[=:]' "$f" 2>/dev/null; then
      die "apiBase is set in $f: remove it, or the APKs would talk to another host"
    fi
  done
  [ -z "${ORG_GRADLE_PROJECT_apiBase:-}" ] || die "ORG_GRADLE_PROJECT_apiBase is set: unset it, or the APKs would talk to another host"
  case "${GRADLE_OPTS:-} ${JAVA_OPTS:-}" in
    *apiBase*) die "GRADLE_OPTS or JAVA_OPTS sets apiBase: unset it, or the APKs would talk to another host" ;;
  esac
}

# The ci workflow must have passed on this very commit: the release runs only
# the API tests, not Android's lint and tests or the Mac's.
ci_passed() {
  sha=$(git rev-parse HEAD)
  runs=$(gh run list --workflow ci.yml --commit "$sha" --limit 20 --json status,conclusion,event,url) ||
    die "couldn't ask GitHub for CI on $sha; check gh and the network"
  # The newest run of the push to main, else the newest of any.
  state=$(printf '%s' "$runs" | python3 -c '
import json, sys
runs = json.load(sys.stdin)
push = [r for r in runs if r["event"] == "push"]
r = (push or runs or [None])[0]
print("none" if r is None else " ".join([r["status"], r["conclusion"] or "-", r["url"]]))')
  case "$state" in
    none) die "no ci run found for $sha: push main and wait for CI" ;;
    "completed success "*) echo "ci passed on $sha" ;;
    completed*) die "ci didn't pass on $sha (${state#completed }): fix it and push again" ;;
    *) die "ci is still running on $sha (${state##* }): wait for it to pass" ;;
  esac
}

# Where TAG stands: TAG_LOCAL, TAG_REMOTE and GH_RELEASE are 1 or 0.
tag_state() {
  TAG_LOCAL=0 TAG_REMOTE=0 GH_RELEASE=0
  git rev-parse -q --verify "refs/tags/$1" >/dev/null && TAG_LOCAL=1
  rc=0
  git ls-remote -q --exit-code --tags origin "refs/tags/$1" >/dev/null || rc=$?
  case $rc in
    0) TAG_REMOTE=1 ;;
    2) ;;
    *) die "couldn't list origin's tags; check the network" ;;
  esac
  if err=$(gh api "repos/{owner}/{repo}/releases/tags/$1" --silent 2>&1); then
    GH_RELEASE=1
  else
    case "$err" in *"HTTP 404"*) ;; *) die "couldn't ask GitHub for the $1 release: $err" ;; esac
  fi
}

# The commands that finish a release whose files are live, from tag_state.
# $1 is what goes before github-release.sh (CHANNEL=beta for a beta).
finish_steps() {
  [ $TAG_LOCAL -eq 1 ] || [ $TAG_REMOTE -eq 1 ] || echo "  git tag -a v$VERSION -m \"terminus $VERSION\""
  [ $TAG_LOCAL -eq 1 ] || [ $TAG_REMOTE -eq 0 ] || echo "  git fetch origin tag v$VERSION"
  [ $TAG_REMOTE -eq 1 ] || echo "  git push origin v$VERSION"
  echo "  ${1:+$1 }scripts/github-release.sh $VERSION"
}

# What the site serves now: LIVE_VERSION from latest.json, LIVE_BUILD from
# the appcast (latest.json has no build; Sparkle compares the appcast's).
# A real release can't go on without them, or the checks below would pass
# for want of an answer.
live_release() {
  LIVE_VERSION="" LIVE_BUILD=""
  if ! json=$(curl -fsS --max-time 20 "$1/download/latest.json") || ! xml=$(curl -fsS --max-time 20 "$1/download/appcast.xml"); then
    warn_or_die "couldn't read $1/download/latest.json or appcast.xml; check the network"
    return 0
  fi
  LIVE_VERSION=$(printf '%s' "$json" | python3 -c 'import json, sys; print(json.load(sys.stdin)["version"])') ||
    die "$1/download/latest.json has no version"
  LIVE_BUILD=$(printf '%s' "$xml" | sed -n 's|.*<sparkle:version>\([0-9][0-9]*\)</sparkle:version>.*|\1|p' | head -1)
  [ -n "$LIVE_BUILD" ] || die "$1/download/appcast.xml has no sparkle:version"
}

# Sparkle installs only a higher CFBundleVersion and Android only a higher
# versionCode, so a build that isn't above the live one reaches nobody.
build_goes_up() {
  [ -n "$LIVE_BUILD" ] || return 0
  [ "$BUILD" -gt "$LIVE_BUILD" ] || warn_or_die "build $BUILD isn't above the live build $LIVE_BUILD ($LIVE_VERSION): $1"
}

# Every APK signed with the release key, the one assetlinks.json names: a
# debug-signed APK wouldn't install over the real app or open its links.
apks_signed() {
  sdk=${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}
  [ -n "$sdk" ] || sdk=$(sed -n 's/^sdk\.dir=//p' apps/android/local.properties 2>/dev/null || true)
  [ -n "$sdk" ] || sdk="$HOME/Library/Android/sdk"
  signer=$(ls -d "$sdk"/build-tools/*/apksigner 2>/dev/null | sort -V | tail -1)
  [ -n "$signer" ] && [ -x "$signer" ] || die "no apksigner in $sdk/build-tools: install the Android SDK build-tools"
  keys=$(python3 -c '
import json, sys
for e in json.load(open(sys.argv[1])):
    for f in e["target"]["sha256_cert_fingerprints"]:
        print(f.replace(":", "").lower())' apps/web/public/.well-known/assetlinks.json)
  [ -n "$keys" ] || die "no fingerprints in apps/web/public/.well-known/assetlinks.json"
  for apk in "$@"; do
    certs=$("$signer" verify --print-certs "$apk" 2>&1) || die "$apk doesn't verify: $certs"
    digests=$(printf '%s\n' "$certs" | sed -n 's/^Signer #[0-9]* certificate SHA-256 digest: \([0-9a-f]*\)$/\1/p')
    [ -n "$digests" ] || die "$apk has no signer"
    for d in $digests; do
      printf '%s\n' "$keys" | grep -qx "$d" ||
        die "$(basename "$apk") is signed by $d, not the release key in assetlinks.json: check TERMINUS_* in ~/.gradle/gradle.properties"
    done
  done
  echo "APKs signed with the release key"
}

# The Sparkle signature checked with the public key the built app carries,
# so a wrong key in ~/.terminus fails here, not on every Mac that updates.
sparkle_signed() {  # <app> <signature> <dmg>
  pub=$(/usr/libexec/PlistBuddy -c 'Print :SUPublicEDKey' "$1/Contents/Info.plist") || die "no SUPublicEDKey in $1"
  swift scripts/verify-sparkle.swift "$pub" "$2" "$3" ||
    die "the Sparkle signature doesn't match SUPublicEDKey: is $SPARKLE_KEY the right key?"
}

# R2's uploads, one per line (key|file|type), latest.json last so
# /download/* never points at a file that isn't there yet.
uploads() {
  for f in "terminus-$VERSION.apk" "terminus-$VERSION-armv7.apk" "terminus-$VERSION-x86_64.apk"; do
    echo "releases/$VERSION/$f|$OUT/$f|application/vnd.android.package-archive"
  done
  echo "releases/$VERSION/terminus-$VERSION.dmg|$OUT/terminus-$VERSION.dmg|application/x-apple-diskimage"
  echo "appcast.xml|$OUT/appcast.xml|application/xml; charset=utf-8"
  echo "latest.json|$OUT/latest.json|application/json"
}

# Wrangler, not `cf r2 objects put`: cf percent-encodes the slashes in the
# key, which R2 needs literal.
upload_all() {
  uploads | while IFS='|' read -r key file type; do
    # Stopping at the first failure keeps latest.json from going up without its files.
    (cd apps/api && pnpm exec wrangler r2 object put "$BUCKET/$key" --file "$file" --content-type "$type" --remote) </dev/null || exit 1
  done
}

# The same uploads as commands to paste, after one stopped partway: each
# overwrites, so all of them again is safe.
upload_steps() {
  uploads | while IFS='|' read -r key file type; do
    echo "  (cd apps/api && pnpm exec wrangler r2 object put \"$BUCKET/$key\" --file \"$file\" --content-type \"$type\" --remote)"
  done
}
