# Checks and steps shared by scripts/release.sh and scripts/release-beta.sh,
# which source this file from the repo root. Each check stops the release
# and says what to do; they read VERSION, BUILD, OUT, BUCKET and DRY from the
# script that sources them. Both run under bash with pipefail, so a failure
# anywhere in a pipeline stops the release too.

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
print("none" if r is None else " ".join([r["status"], r["conclusion"] or "-", r["url"]]))') ||
    die "couldn't read GitHub's answer about CI on $sha"
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
  # Not `sed | head -1`: under pipefail, head closing the pipe early would
  # fail the read.
  LIVE_BUILD=$(printf '%s' "$xml" | python3 -c '
import re, sys
m = re.search(r"<sparkle:version>([0-9]+)</sparkle:version>", sys.stdin.read())
print(m[1] if m else "")')
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
  # No build-tools is a failed ls: the check below says so, not pipefail.
  signer=$(ls -d "$sdk"/build-tools/*/apksigner 2>/dev/null | sort -V | tail -1 || true)
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

# The certificate releases sign the Mac app with, by its SHA-1: every
# version must carry the same code identity, or macOS forgets the app's
# permissions and login item. Not `security | grep -q`: under pipefail,
# grep leaving early can fail the pipe while the certificate is there.
has_sign_identity() {
  ids=$(security find-identity -p codesigning) || die "couldn't list the keychain's signing identities"
  case "$ids" in
    *"$SIGN_IDENTITY"*) ;;
    *) die "the terminus certificate isn't in the keychain: import ~/.terminus/mac-signing.p12" ;;
  esac
}

# The dependencies, from the lockfiles only. node_modules and
# apps/macos/.build are ignored by git, so anything left in them would be
# tested, built and run beside the release's keys (sign_update below is
# handed the Sparkle private key). Both are thrown away and rebuilt: pnpm
# relinks node_modules from its store, checking each package against the
# lockfile's integrity hash, and SwiftPM checks Sparkle out at the revision
# Package.resolved pins and its binaries against the checksum in Sparkle's
# manifest. That costs a few seconds for pnpm and a full build of the Mac
# app's own code (its dependencies come prebuilt); the Android build is
# Gradle's, with its own caches.
fresh_deps() {
  echo "== dependencies"
  rm -rf node_modules apps/*/node_modules apps/macos/.build
  pnpm install --frozen-lockfile || die "pnpm install failed: is pnpm-lock.yaml up to date with the package.json files?"
  (cd apps/macos && swift package resolve --force-resolved-versions) ||
    die "the Swift packages don't resolve to apps/macos/Package.resolved: run swift package resolve in apps/macos and commit it"
  sign_update_tool
}

# Sparkle's sign_update, the tool handed the Sparkle private key, as
# published with the Sparkle that Package.resolved pins. It's signed ad hoc,
# so codesign can't say who built it; its SHA-256 is pinned instead. On a
# Sparkle update: check the new Sparkle-for-Swift-Package-Manager.zip's
# SHA-256 against the checksum in Sparkle's Package.swift at that tag, then
# set these to the version and to `shasum -a 256 bin/sign_update` from it.
SPARKLE_VERSION=2.10.0
SIGN_UPDATE_SHA256=43c249771bafc3aa581228abae00731a012d324691b8292860896635050be76b
sign_update_tool() {
  pinned=$(python3 -c '
import json, sys
pins = [p for p in json.load(open(sys.argv[1]))["pins"] if p["identity"] == "sparkle"]
print(pins[0]["state"].get("version", "") if pins else "")' apps/macos/Package.resolved) ||
    die "couldn't read apps/macos/Package.resolved"
  [ "$pinned" = "$SPARKLE_VERSION" ] ||
    die "Package.resolved pins Sparkle ${pinned:-(none)}, but scripts/release-lib.sh trusts sign_update from $SPARKLE_VERSION: check the new one and update SPARKLE_VERSION and SIGN_UPDATE_SHA256"
  SIGN_UPDATE="$ROOT/apps/macos/.build/artifacts/sparkle/Sparkle/bin/sign_update"
  [ -f "$SIGN_UPDATE" ] && [ ! -L "$SIGN_UPDATE" ] || die "no sign_update at $SIGN_UPDATE: did swift package resolve fetch Sparkle?"
  sum=$(shasum -a 256 "$SIGN_UPDATE") || die "couldn't hash $SIGN_UPDATE"
  [ "${sum%% *}" = "$SIGN_UPDATE_SHA256" ] ||
    die "$SIGN_UPDATE isn't Sparkle $SPARKLE_VERSION's sign_update (SHA-256 ${sum%% *}); not handing it the key"
  codesign --verify --strict "$SIGN_UPDATE" 2>/dev/null || die "$SIGN_UPDATE's code signature doesn't verify; not handing it the key"
}

# The appcast signed with the Sparkle key, as Sparkle checks a feed once
# the app sets SURequireSignedFeed (a later release turns it on, once
# signed feeds are live). sign_update adds the signature to the file as a
# closing comment, so nothing may change it after this; upload_all checks
# it's byte for byte what was signed.
sign_appcast() {  # <appcast.xml>
  sign_update_tool
  "$SIGN_UPDATE" --ed-key-file "$SPARKLE_KEY" "$1" || die "sign_update couldn't sign $1"
  grep -q 'sparkle-signatures:' "$1" || die "sign_update left no signature in $1"
  "$SIGN_UPDATE" --verify --ed-key-file "$SPARKLE_KEY" "$1" >/dev/null || die "$1's signature doesn't verify"
  APPCAST_SHA256=$(shasum -a 256 "$1") || die "couldn't hash $1"
  APPCAST_SHA256=${APPCAST_SHA256%% *}
  echo "appcast signed"
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
  sum=$(shasum -a 256 "$OUT/appcast.xml") || die "couldn't hash $OUT/appcast.xml"
  [ "${sum%% *}" = "${APPCAST_SHA256:-}" ] || die "$OUT/appcast.xml changed after it was signed; nothing uploaded"
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
