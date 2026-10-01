#!/bin/sh
# Publish a GitHub release for a tagged version, with the APK and the Mac DMG
# attached, the hand-written highlights in RELEASE_NOTES.md (when it's for
# this version) and the commits since the previous tag. The release workflow
# runs it once both files are in build/release/<version>; run again, it
# re-uploads the files to the existing release.
#
# A pre-release version ("2.0.0-beta") is titled "terminus 2.0 beta" and
# marked a pre-release on GitHub. The site's downloads are unaffected: they
# follow latest.json in R2.
#
#   scripts/github-release.sh 1.3.8          # publish
#   scripts/github-release.sh 1.3.8 --notes  # print the notes only
set -eu
cd "$(dirname "$0")/.."
VERSION="${1:?usage: scripts/github-release.sh <version> [--notes]}"
TAG="v$VERSION"
DIR="build/release/$VERSION"
APK="$DIR/terminus-$VERSION.apk"
MAC="$DIR/terminus-$VERSION.dmg"
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null || { echo "no tag $TAG"; exit 1; }
[ -f "$APK" ] && [ -f "$MAC" ] || { echo "missing $APK or $MAC"; exit 1; }

# A release lists the commits since the previous release, past its betas.
case "$VERSION" in
  *-*) PREV=$(git describe --tags --abbrev=0 "$TAG^" 2>/dev/null || true) ;;
  *) PREV=$(git describe --tags --abbrev=0 --exclude '*-*' "$TAG^" 2>/dev/null || true) ;;
esac
NOTES="build/release/$VERSION/notes.md"
python3 scripts/release-notes.py "$VERSION" "$TAG" "$PREV" "$APK" "$MAC" > "$NOTES"

if [ "${2:-}" = "--notes" ]; then cat "$NOTES"; exit 0; fi
TITLE="terminus $(python3 scripts/release-notes.py --title "$VERSION")"
PRE=""
case "$VERSION" in *-*) PRE="--prerelease" ;; esac
if gh release view "$TAG" >/dev/null 2>&1; then
  gh release upload "$TAG" "$APK" "$MAC" --clobber
  gh release edit "$TAG" --title "$TITLE" --notes-file "$NOTES" $PRE
else
  gh release create "$TAG" "$APK" "$MAC" --verify-tag --title "$TITLE" --notes-file "$NOTES" $PRE
fi
