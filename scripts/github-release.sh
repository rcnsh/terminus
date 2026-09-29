#!/bin/sh
# Publish a GitHub release for a version scripts/release.sh has built and
# tagged, with the APK and Mac zip attached and notes from the commits since
# the previous tag. Run it after pushing the tag.
#
#   scripts/github-release.sh 1.3.8          # publish
#   scripts/github-release.sh 1.3.8 --notes  # print the notes only
set -eu
cd "$(dirname "$0")/.."
VERSION="${1:?usage: scripts/github-release.sh <version> [--notes]}"
TAG="v$VERSION"
DIR="build/release/$VERSION"
APK="$DIR/terminus-$VERSION.apk"
ZIP="$DIR/terminus-$VERSION-mac.zip"
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null || { echo "no tag $TAG"; exit 1; }
[ -f "$APK" ] && [ -f "$ZIP" ] || { echo "missing $APK or $ZIP; build it with scripts/release.sh"; exit 1; }

PREV=$(git describe --tags --abbrev=0 "$TAG^" 2>/dev/null || true)
NOTES="build/release/$VERSION/notes.md"
python3 - "$VERSION" "$TAG" "$PREV" "$APK" "$ZIP" > "$NOTES" <<'EOF'
import hashlib, re, subprocess, sys
version, tag, prev, apk, zp = sys.argv[1:]
git = lambda *a: subprocess.run(['git', *a], capture_output=True, text=True, check=True).stdout
date = git('log', '-1', '--format=%cd', '--date=format:%-d %b %Y', tag).strip()
print(f'Released {date}.\n')
if not prev:
    # Everything before the first tag was the pre-beta build-up.
    print('''The first public beta.

- An Android home-screen widget and app, and a Mac menu bar app
- Imports your NUSMods timetable, and knows teaching weeks, recess, exams and public holidays
- When to leave, which bus and from which side of the road, with arrival estimates and crowding
- Sign in by email, pair devices with a QR code, and export or delete your data at any time
''')
else:
    changes = []
    for s in git('log', '--no-merges', '--reverse', '--format=%s', f'{prev}..{tag}').splitlines():
        if re.fullmatch(r'(terminus|nusbus) \d+\.\d+\.\d+', s, re.I):
            continue  # the version bump itself
        # The first sentence of each commit subject.
        changes.append('- ' + re.split(r'(?<=[a-z0-9)`"])\. (?=[A-Z`])', s, maxsplit=1)[0].rstrip('.'))
    if changes:
        print('## Changes\n' + '\n'.join(changes) + '\n')
sha = lambda p: hashlib.sha256(open(p, 'rb').read()).hexdigest()
print(f'''## Install
- **Android** (12 or later): `terminus-{version}.apk`. Open it and allow your browser to install apps when asked.
- **Mac** (macOS 14 or later, Apple silicon): `terminus-{version}-mac.zip`. Unzip, drag terminus to Applications, then right-click it and choose Open the first time.

Then sign in at https://terminus.rcn.sh/account and pair the app with the code shown there.

| File | SHA-256 |
| --- | --- |
| `terminus-{version}.apk` | `{sha(apk)}` |
| `terminus-{version}-mac.zip` | `{sha(zp)}` |''')
EOF

if [ "${2:-}" = "--notes" ]; then cat "$NOTES"; exit 0; fi
gh release create "$TAG" "$APK" "$ZIP" --verify-tag --title "terminus $VERSION" --notes-file "$NOTES"
