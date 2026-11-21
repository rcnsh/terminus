#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/../.."
VERSION="${1:?usage: [CHANNEL=beta] scripts/release/github-release.sh <version> [--notes]}"
VERSION_RE='^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z]+(\.[0-9]+)?)?$'
[[ $VERSION =~ $VERSION_RE ]] || { echo "$VERSION isn't a version like 2.1.0 or 2.1.1-beta.1" >&2; exit 1; }
TAG="v$VERSION"
CHANNEL="${CHANNEL:-}"
DIR="build/release/$VERSION"
if [ "$CHANNEL" = beta ]; then DIR="build/release/beta/$VERSION"; fi
APK="$DIR/terminus-$VERSION.apk"
MAC="$DIR/terminus-$VERSION.dmg"
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null || { echo "no tag $TAG" >&2; exit 1; }
[ -f "$APK" ] && [ -f "$MAC" ] || { echo "missing $APK or $MAC" >&2; exit 1; }

EXCLUDE='*-*'
case "$VERSION" in *-*) EXCLUDE='' ;; esac
EARLIER=$(git tag -l 'v*' --merged "$TAG^")
if [ -n "$EXCLUDE" ]; then EARLIER=$(printf '%s\n' "$EARLIER" | grep -v -- - || true); fi
PREV=""
if [ -n "$EARLIER" ]; then
  PREV=$(git describe --tags --abbrev=0 --match 'v*' ${EXCLUDE:+--exclude "$EXCLUDE"} "$TAG^") ||
    { echo "couldn't find the tag before $TAG" >&2; exit 1; }
fi
NOTES="$DIR/notes.md"
python3 scripts/release/release-notes.py "$VERSION" "$TAG" "$PREV" "$APK" "$MAC" "$CHANNEL" > "$NOTES"

if [ "${2:-}" = "--notes" ]; then cat "$NOTES"; exit 0; fi
TITLE="terminus $(python3 scripts/release/release-notes.py --title "$VERSION")"
PRE=""
case "$VERSION" in *-*) PRE="--prerelease" ;; esac
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
