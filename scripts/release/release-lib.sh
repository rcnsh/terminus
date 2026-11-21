die() { echo "$*" >&2; exit 1; }

warn_or_die() {
  if [ "$DRY" -eq 1 ]; then echo "warning: $* (a real release would stop here)"; else die "$*"; fi
}

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

SCRAPE_DATA="apps/api/data/stops.json apps/api/data/calendar.json apps/api/data/shapes.json apps/api/data/public.json"
SCRAPE_BOT="github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>"

scrape_commit() {
  [ "$(git rev-list --no-walk --parents "$1" | wc -w | tr -d ' ')" = 2 ] || return 1
  [ "$(git show -s --format='%an <%ae>' "$1")" = "$SCRAPE_BOT" ] || return 1
  [ "$(git show -s --format='%cn <%ce>' "$1")" = "$SCRAPE_BOT" ] || return 1
  files=$(git diff --name-only "$1^" "$1") || return 1
  [ -n "$files" ] || return 1
  [ -z "$(git diff --name-only --no-renames --diff-filter=ADTUXB "$1^" "$1")" ] || return 1
  for f in $files; do
    case " $SCRAPE_DATA " in *" $f "*) ;; *) return 1 ;; esac
  done
}

ci_state() {
  runs=$(gh run list --workflow ci.yml --commit "$1" --limit 20 --json status,conclusion,event,url) ||
    die "couldn't ask GitHub for CI on $1; check gh and the network"
  state=$(printf '%s' "$runs" | python3 -c '
import json, sys
runs = json.load(sys.stdin)
push = [r for r in runs if r["event"] == "push"]
r = (push or runs or [None])[0]
print("none" if r is None else " ".join([r["status"], r["conclusion"] or "-", r["url"]]))') ||
    die "couldn't read GitHub's answer about CI on $1"
}

ci_passed() {
  sha=$(git rev-parse HEAD)
  ci_state "$sha"
  while [ "$state" = none ] && scrape_commit "$sha"; do
    echo "$sha is the scrape's data-only commit, which CI doesn't run on; checking the commit under it"
    sha=$(git rev-parse "$sha^")
    ci_state "$sha"
  done
  case "$state" in
    none) die "no ci run found for $sha: push main and wait for CI" ;;
    "completed success "*) echo "ci passed on $sha" ;;
    completed*) die "ci didn't pass on $sha (${state#completed }): fix it and push again" ;;
    *) die "ci is still running on $sha (${state##* }): wait for it to pass" ;;
  esac
}

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

finish_steps() {
  [ $TAG_LOCAL -eq 1 ] || [ $TAG_REMOTE -eq 1 ] || echo "  git tag -a v$VERSION -m \"terminus $VERSION\""
  [ $TAG_LOCAL -eq 1 ] || [ $TAG_REMOTE -eq 0 ] || echo "  git fetch origin tag v$VERSION"
  [ $TAG_REMOTE -eq 1 ] || echo "  git push origin v$VERSION"
  [ "${FEEDS_AFTER_TAG:-0}" != 1 ] || upload_steps feeds
  echo "  ${1:+$1 }scripts/release/github-release.sh $VERSION"
}

live_release() {
  LIVE_VERSION="" LIVE_BUILD=""
  if ! json=$(curl -fsS --max-time 20 "$1/download/latest.json") || ! xml=$(curl -fsS --max-time 20 "$1/download/appcast.xml"); then
    warn_or_die "couldn't read $1/download/latest.json or appcast.xml; check the network"
    return 0
  fi
  LIVE_VERSION=$(printf '%s' "$json" | python3 -c 'import json, sys; print(json.load(sys.stdin)["version"])') ||
    die "$1/download/latest.json has no version"
  LIVE_BUILD=$(printf '%s' "$xml" | python3 -c '
import re, sys
m = re.search(r"<sparkle:version>([0-9]+)</sparkle:version>", sys.stdin.read())
print(m[1] if m else "")')
  [ -n "$LIVE_BUILD" ] || die "$1/download/appcast.xml has no sparkle:version"
}

build_goes_up() {
  [ -n "$LIVE_BUILD" ] || return 0
  [ "$BUILD" -gt "$LIVE_BUILD" ] || warn_or_die "build $BUILD isn't above the live build $LIVE_BUILD ($LIVE_VERSION): $1"
}

apks_signed() {
  sdk=${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}
  [ -n "$sdk" ] || sdk=$(sed -n 's/^sdk\.dir=//p' apps/android/local.properties 2>/dev/null || true)
  [ -n "$sdk" ] || sdk="$HOME/Library/Android/sdk"
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
    digests=$(printf '%s\n' "$certs" | sed -nE 's/^(V[0-9.]+ )?Signer( #[0-9]+)?:? certificate SHA-256 digest: ([0-9a-f]+)$/\3/p' | sort -u)
    [ -n "$digests" ] || die "$apk has no signer"
    for d in $digests; do
      printf '%s\n' "$keys" | grep -qx "$d" ||
        die "$(basename "$apk") is signed by $d, not the release key in assetlinks.json: check TERMINUS_* in ~/.gradle/gradle.properties"
    done
  done
  echo "APKs signed with the release key"
}

has_sign_identity() {
  ids=$(security find-identity -p codesigning) || die "couldn't list the keychain's signing identities"
  case "$ids" in
    *"$SIGN_IDENTITY"*) ;;
    *) die "the terminus Developer ID certificate isn't in the keychain: import ~/.terminus/developer-id.p12" ;;
  esac
}

has_notary_profile() {
  xcrun notarytool history --keychain-profile "$NOTARY_PROFILE" >/dev/null 2>&1 && return
  case "$(ioreg -l -d1 -k IOConsoleUsers 2>/dev/null)" in
    *'"CGSSessionScreenIsLocked"=Yes'*) die "the Mac's screen is locked, so the keychain won't give out the notary credentials: unlock it and run this again" ;;
  esac
  die "the notary credentials $NOTARY_PROFILE don't work: xcrun notarytool store-credentials $NOTARY_PROFILE --apple-id <email> --team-id BUKSCHP3SV"
}

fresh_deps() {
  echo "== dependencies"
  rm -rf node_modules apps/*/node_modules apps/macos/.build
  pnpm install --frozen-lockfile || die "pnpm install failed: is pnpm-lock.yaml up to date with the package.json files?"
  (cd apps/macos && swift package resolve --force-resolved-versions) ||
    die "the Swift packages don't resolve to apps/macos/Package.resolved: run swift package resolve in apps/macos and commit it"
  sign_update_tool
}

SPARKLE_VERSION=2.10.1
SIGN_UPDATE_SHA256=43c249771bafc3aa581228abae00731a012d324691b8292860896635050be76b
sign_update_tool() {
  pinned=$(python3 -c '
import json, sys
pins = [p for p in json.load(open(sys.argv[1]))["pins"] if p["identity"] == "sparkle"]
print(pins[0]["state"].get("version", "") if pins else "")' apps/macos/Package.resolved) ||
    die "couldn't read apps/macos/Package.resolved"
  [ "$pinned" = "$SPARKLE_VERSION" ] ||
    die "Package.resolved pins Sparkle ${pinned:-(none)}, but scripts/release/release-lib.sh trusts sign_update from $SPARKLE_VERSION: check the new one and update SPARKLE_VERSION and SIGN_UPDATE_SHA256"
  SIGN_UPDATE="$ROOT/apps/macos/.build/artifacts/sparkle/Sparkle/bin/sign_update"
  [ -f "$SIGN_UPDATE" ] && [ ! -L "$SIGN_UPDATE" ] || die "no sign_update at $SIGN_UPDATE: did swift package resolve fetch Sparkle?"
  sum=$(shasum -a 256 "$SIGN_UPDATE") || die "couldn't hash $SIGN_UPDATE"
  [ "${sum%% *}" = "$SIGN_UPDATE_SHA256" ] ||
    die "$SIGN_UPDATE isn't Sparkle $SPARKLE_VERSION's sign_update (SHA-256 ${sum%% *}); not handing it the key"
  codesign --verify --strict "$SIGN_UPDATE" 2>/dev/null || die "$SIGN_UPDATE's code signature doesn't verify; not handing it the key"
}

sign_appcast() {
  sign_update_tool
  "$SIGN_UPDATE" --ed-key-file "$SPARKLE_KEY" "$1" || die "sign_update couldn't sign $1"
  grep -q 'sparkle-signatures:' "$1" || die "sign_update left no signature in $1"
  "$SIGN_UPDATE" --verify --ed-key-file "$SPARKLE_KEY" "$1" >/dev/null || die "$1's signature doesn't verify"
  APPCAST_SHA256=$(shasum -a 256 "$1") || die "couldn't hash $1"
  APPCAST_SHA256=${APPCAST_SHA256%% *}
  echo "appcast signed"
}

sparkle_signed() {
  pub=$(/usr/libexec/PlistBuddy -c 'Print :SUPublicEDKey' "$1/Contents/Info.plist") || die "no SUPublicEDKey in $1"
  swift scripts/release/verify-sparkle.swift "$pub" "$2" "$3" ||
    die "the Sparkle signature doesn't match SUPublicEDKey: is $SPARKLE_KEY the right key?"
}

uploads() {
  if [ "${1:-all}" != feeds ]; then
    for f in "terminus-$VERSION.apk" "terminus-$VERSION-armv7.apk" "terminus-$VERSION-x86_64.apk"; do
      echo "releases/$VERSION/$f|$OUT/$f|application/vnd.android.package-archive"
    done
    echo "releases/$VERSION/terminus-$VERSION.dmg|$OUT/terminus-$VERSION.dmg|application/x-apple-diskimage"
  fi
  if [ "${1:-all}" != files ]; then
    echo "appcast.xml|$OUT/appcast.xml|application/xml; charset=utf-8"
    echo "latest.json|$OUT/latest.json|application/json"
  fi
}

upload_all() {
  sum=$(shasum -a 256 "$OUT/appcast.xml") || die "couldn't hash $OUT/appcast.xml"
  [ "${sum%% *}" = "${APPCAST_SHA256:-}" ] || die "$OUT/appcast.xml changed after it was signed; nothing uploaded"
  uploads "${1:-all}" | while IFS='|' read -r key file type; do
    (cd apps/api && pnpm exec wrangler r2 object put "$BUCKET/$key" --file "$file" --content-type "$type" --remote) </dev/null || exit 1
  done
}

upload_steps() {
  uploads "${1:-all}" | while IFS='|' read -r key file type; do
    echo "  (cd apps/api && pnpm exec wrangler r2 object put \"$BUCKET/$key\" --file \"$file\" --content-type \"$type\" --remote)"
  done
}
