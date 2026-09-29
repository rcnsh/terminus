#!/bin/sh
# Upload the Mac DMG for <version> to R2, write the Sparkle appcast for it and
# point latest.json at it. Run by the release workflow after
# scripts/package-mac.sh, once scripts/release.sh has uploaded the APK for the
# same version. SPARKLE_ED_PRIVATE_KEY is the update-signing key
# (~/.terminus/sparkle-ed25519.key); installed apps only take an update whose
# DMG it signed.
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
[ -n "${SPARKLE_ED_PRIVATE_KEY:-}" ] || { echo "SPARKLE_ED_PRIVATE_KEY is not set"; exit 1; }
SPARKLE_BIN="$ROOT/apps/macos/.build/artifacts/sparkle/Sparkle/bin"
BUILD=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$ROOT/apps/macos/Support/Info.plist")
MIN_OS=$(/usr/libexec/PlistBuddy -c 'Print :LSMinimumSystemVersion' "$ROOT/apps/macos/Support/Info.plist")
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

# The appcast: one item, the new version. Sparkle compares CFBundleVersion.
SIG=$(printf '%s' "$SPARKLE_ED_PRIVATE_KEY" | "$SPARKLE_BIN/sign_update" --ed-key-file - -p "$DMG")
printf '%s' "$SIG" | grep -q . || { echo "sign_update gave no signature"; exit 1; }
python3 - "$VERSION" "$BUILD" "$MIN_OS" "$SIG" "$DMG" > "$OUT/appcast.xml" <<'EOF'
import email.utils, os, sys
from xml.sax.saxutils import quoteattr
version, build, min_os, sig, dmg = sys.argv[1:]
url = f'https://terminus.rcn.sh/download/releases/{version}/terminus-{version}.dmg'
print(f'''<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">
  <channel>
    <title>terminus</title>
    <link>https://terminus.rcn.sh</link>
    <item>
      <title>terminus {version}</title>
      <pubDate>{email.utils.formatdate(usegmt=True)}</pubDate>
      <link>https://github.com/rcnsh/terminus/releases/tag/v{version}</link>
      <sparkle:version>{build}</sparkle:version>
      <sparkle:shortVersionString>{version}</sparkle:shortVersionString>
      <sparkle:minimumSystemVersion>{min_os}</sparkle:minimumSystemVersion>
      <enclosure url={quoteattr(url)} type="application/octet-stream" sparkle:edSignature={quoteattr(sig)} length="{os.path.getsize(dmg)}"/>
    </item>
  </channel>
</rss>''')
EOF
r2 put terminus-downloads/appcast.xml --file "$OUT/appcast.xml" --content-type "application/xml; charset=utf-8"
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
# latest.json last, so /download/mac never points at a file that isn't there yet
# (the appcast names the DMG by its own path, already uploaded).
r2 put terminus-downloads/latest.json --file "$OUT/latest.json" --content-type application/json
echo "== published mac $VERSION"
