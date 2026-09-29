#!/bin/sh
# Upload the Mac DMG for <version> to R2 and point latest.json at it. Run by
# the release workflow after scripts/package-mac.sh, once scripts/release.sh
# has uploaded the APK for the same version.
#
# latest.json's top-level "version" is what the apps compare against to offer
# an update, so it only moves to <version> here, when both downloads are up.
# The APK is fetched back from R2 too, for the GitHub release.
#
#   scripts/publish-mac.sh 1.3.8
set -eu
cd "$(dirname "$0")/.."
ROOT=$(pwd)
VERSION="${1:?usage: scripts/publish-mac.sh <version>}"
OUT="$ROOT/build/release/$VERSION"
DMG="$OUT/terminus-$VERSION.dmg"
APK="$OUT/terminus-$VERSION.apk"
[ -f "$DMG" ] || { echo "no $DMG; run scripts/package-mac.sh"; exit 1; }
r2() { (cd "$ROOT/apps/api" && pnpm exec wrangler r2 object "$@" --remote); }

r2 get terminus-downloads/latest.json --file "$OUT/latest.before.json"
python3 - "$VERSION" "$OUT/latest.before.json" <<'EOF'
import json, sys
version, path = sys.argv[1:]
want = f'releases/{version}/terminus-{version}.apk'
got = json.load(open(path)).get('android', {}).get('file')
if got != want:
    sys.exit(f'latest.json has android {got}, not {want}: run scripts/release.sh for {version} first')
EOF
r2 get "terminus-downloads/releases/$VERSION/terminus-$VERSION.apk" --file "$APK"

r2 put "terminus-downloads/releases/$VERSION/terminus-$VERSION.dmg" --file "$DMG" --content-type application/x-apple-diskimage
python3 - "$VERSION" "$OUT/latest.before.json" "$DMG" "$APK" > "$OUT/latest.json" <<'EOF'
import datetime, hashlib, json, os, sys
version, path, dmg, apk = sys.argv[1:]
sha = lambda p: hashlib.sha256(open(p, 'rb').read()).hexdigest()
latest = json.load(open(path))
if sha(apk) != latest['android']['sha256']:
    sys.exit('the APK in R2 does not match the hash in latest.json')
latest['mac'] = {'file': f'releases/{version}/terminus-{version}.dmg', 'sha256': sha(dmg), 'size': os.path.getsize(dmg)}
latest['version'] = version
latest['released'] = datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
print(json.dumps(latest, indent=2))
EOF
cat "$OUT/latest.json"
# latest.json last, so /download/mac never points at a file that isn't there yet.
r2 put terminus-downloads/latest.json --file "$OUT/latest.json" --content-type application/json
echo "== published mac $VERSION"
