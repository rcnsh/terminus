#!/bin/sh
# Publish a GitHub release for a tagged version, with the APKs (one per CPU
# type from 2.1) and the Mac DMG attached, the hand-written highlights in
# RELEASE_NOTES.md (when it's for this version) and the commits since the
# previous tag. scripts/release.sh runs it once every file is in
# build/release/<version>; run again, it re-uploads the files to the
# existing release.
#
# A pre-release version ("2.0.0-beta") is titled "terminus 2.0 beta" and
# marked a pre-release on GitHub. The site's downloads are unaffected: they
# follow latest.json in R2.
#
# With CHANNEL=beta it publishes a beta from scripts/release-beta.sh: the
# files in build/release/beta/<version>, as a pre-release for terminus beta.
#
#   scripts/github-release.sh 1.3.8          # publish
#   scripts/github-release.sh 1.3.8 --notes  # print the notes only
#   CHANNEL=beta scripts/github-release.sh 2.0.1-beta.1
set -eu
cd "$(dirname "$0")/.."
VERSION="${1:?usage: [CHANNEL=beta] scripts/github-release.sh <version> [--notes]}"
TAG="v$VERSION"
CHANNEL="${CHANNEL:-}"
DIR="build/release/$VERSION"
if [ "$CHANNEL" = beta ]; then DIR="build/release/beta/$VERSION"; fi
APK="$DIR/terminus-$VERSION.apk"
MAC="$DIR/terminus-$VERSION.dmg"
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null || { echo "no tag $TAG"; exit 1; }
[ -f "$APK" ] && [ -f "$MAC" ] || { echo "missing $APK or $MAC"; exit 1; }

# A release lists the commits since the previous release, past its betas.
case "$VERSION" in
  *-*) PREV=$(git describe --tags --abbrev=0 "$TAG^" 2>/dev/null || true) ;;
  *) PREV=$(git describe --tags --abbrev=0 --exclude '*-*' "$TAG^" 2>/dev/null || true) ;;
esac
NOTES="$DIR/notes.md"
python3 scripts/release-notes.py "$VERSION" "$TAG" "$PREV" "$APK" "$MAC" "$CHANNEL" > "$NOTES"

if [ "${2:-}" = "--notes" ]; then cat "$NOTES"; exit 0; fi
TITLE="terminus $(python3 scripts/release-notes.py --title "$VERSION")"
PRE=""
case "$VERSION" in *-*) PRE="--prerelease" ;; esac
# The other CPU types' APKs, when this version has them.
set -- "$APK"
for f in "$DIR/terminus-$VERSION-armv7.apk" "$DIR/terminus-$VERSION-x86_64.apk"; do
  if [ -f "$f" ]; then set -- "$@" "$f"; fi
done
if gh release view "$TAG" >/dev/null 2>&1; then
  gh release upload "$TAG" "$@" "$MAC" --clobber
  gh release edit "$TAG" --title "$TITLE" --notes-file "$NOTES" $PRE
else
  gh release create "$TAG" "$@" "$MAC" --verify-tag --title "$TITLE" --notes-file "$NOTES" $PRE
fi
