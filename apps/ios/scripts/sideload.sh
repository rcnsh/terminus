#!/bin/sh
# Puts the iPhone app on your own iPhone with a free Apple ID, until it's on
# the App Store. Two ways (SIDELOAD.md says more):
#
#   scripts/sideload.sh          On a Mac with Xcode, the iPhone plugged in:
#                                builds it, signs it with your Apple ID and
#                                installs it. Run it again within 7 days.
#   scripts/sideload.sh --ipa    Makes build/sideload/terminus-<version>.ipa
#                                for AltStore, SideStore or Sideloadly, which
#                                sign it with the Apple ID of whoever installs it.
#
# Both build the Sideload configuration: the stable servers, without push or
# Time Sensitive notifications, which a free Apple ID can't sign. TEAM=<id>
# picks the team when Xcode has several; DEVICE=<udid> the iPhone when
# several are plugged in.
set -eu
cd "$(dirname "$0")/.."

need() { command -v "$1" >/dev/null 2>&1 || { echo "Needs $1: $2" >&2; exit 1; }; }
need xcodebuild "install Xcode from the App Store, then open it once"
need xcodegen "brew install xcodegen"

scripts/fetch-maplibre.sh
xcodegen generate -q
VERSION=$(sed -n 's/^ *MARKETING_VERSION: "\(.*\)"/\1/p' project.yml)
OUT=build/sideload
mkdir -p "$OUT"

if [ "${1:-}" = --ipa ]; then
  # Unsigned, then signed ad hoc so the entitlements (the app group) ride in
  # the binary: the installer re-signs it under its own team and group.
  xcodebuild -project terminus.xcodeproj -scheme Terminus -configuration Sideload \
    -destination 'generic/platform=iOS' -derivedDataPath "$OUT/dd" -quiet \
    CODE_SIGNING_ALLOWED=NO build
  APP="$OUT/dd/Build/Products/Sideload-iphoneos/Terminus.app"
  GROUP=group.sh.rcn.terminus.sideload
  ENT="$OUT/group.entitlements"
  cat > "$ENT" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>com.apple.security.application-groups</key><array><string>$GROUP</string></array></dict></plist>
EOF
  # Inside out: frameworks, then the extensions, then the app.
  for f in "$APP"/Frameworks/*.framework; do [ -e "$f" ] && codesign -f -s - "$f"; done
  for x in "$APP"/PlugIns/*.appex; do codesign -f -s - --entitlements "$ENT" "$x"; done
  codesign -f -s - --entitlements "$ENT" "$APP"
  rm -rf "$OUT/Payload" && mkdir "$OUT/Payload" && cp -R "$APP" "$OUT/Payload/"
  IPA="$OUT/terminus-$VERSION.ipa"
  rm -f "$IPA" && (cd "$OUT" && zip -qry "terminus-$VERSION.ipa" Payload) && rm -rf "$OUT/Payload"
  echo "Made $IPA. Open it in AltStore, SideStore or Sideloadly on the iPhone's owner's computer."
  exit 0
fi

# Your team: TEAM, else the Personal Team that signing into Xcode made.
if [ -z "${TEAM:-}" ]; then
  TEAM=$(defaults export com.apple.dt.Xcode - 2>/dev/null | python3 -I -c '
import plistlib, sys
d = plistlib.loads(sys.stdin.buffer.read())
teams = [t for ts in d.get("IDEProvisioningTeamByIdentifier", {}).values() for t in ts]
teams.sort(key=lambda t: not t.get("isFreeProvisioningTeam"))
print(teams[0]["teamID"] if teams else "")')
fi
if [ -z "$TEAM" ]; then
  echo "No Apple ID in Xcode. Open Xcode, Settings, Accounts, add your Apple ID, then run this again." >&2
  exit 1
fi

# The iPhone: plugged in (or on the same Wi-Fi once paired) and paired.
devicectl_json=$(mktemp)
trap 'rm -f "$devicectl_json"' EXIT
xcrun devicectl list devices --json-output "$devicectl_json" >/dev/null 2>&1 || true
set -- $(python3 -I - "$devicectl_json" "${DEVICE:-}" <<'EOF'
import json, sys
want = sys.argv[2]
for d in json.load(open(sys.argv[1]))["result"]["devices"]:
    p = d.get("properties", {})
    hw = p.get("hardware", {})
    if hw.get("reality") != "physical" or hw.get("platform") != "iOS": continue
    if want and want not in (hw.get("udid"), d.get("identifier")): continue
    print(d["identifier"], hw["udid"], hw.get("marketingName", "iPhone").replace(" ", "_"))
    break
EOF
)
if [ $# -lt 2 ]; then
  echo "No iPhone found. Plug it in with a cable, unlock it and tap Trust, then run this again." >&2
  exit 1
fi
ID=$1 UDID=$2 NAME=$(echo "$3" | tr _ ' ')

# Your own bundle IDs and group: a free team can't use sh.rcn.terminus, which is ours.
SUFFIX=".sideload.$TEAM"
BUNDLE="sh.rcn.terminus$SUFFIX"
echo "Building terminus $VERSION for $NAME, signed by team $TEAM…"
xcodebuild -project terminus.xcodeproj -scheme Terminus -configuration Sideload \
  -destination "id=$UDID" -derivedDataPath "$OUT/dd" -quiet \
  -allowProvisioningUpdates -allowProvisioningDeviceRegistration \
  DEVELOPMENT_TEAM="$TEAM" TERMINUS_SUFFIX="$SUFFIX" APP_GROUP="group.sh.rcn.terminus$SUFFIX" \
  CODE_SIGN_ENTITLEMENTS=Support/Sideload/Group.entitlements build
APP="$OUT/dd/Build/Products/Sideload-iphoneos/Terminus.app"
xcrun devicectl device install app --device "$ID" "$APP"
if ! xcrun devicectl device process launch --device "$ID" "$BUNDLE" >/dev/null 2>&1; then
  cat <<EOF

Installed. Before it opens the first time, on the iPhone:
  1. Settings, Privacy & Security, Developer Mode: on (the iPhone restarts).
  2. Settings, General, VPN & Device Management: tap your Apple ID, then Trust.
Then open terminus from the Home Screen.
EOF
fi
echo "With a free Apple ID it opens for 7 days. Run this again before then to renew it."
