"""
Release notes for scripts/github-release.sh, as GitHub-flavoured Markdown:
a beta callout for a pre-release, the hand-written highlights in
RELEASE_NOTES.md (when its first line is `<!-- <version> -->`), every commit
since the previous tag (folded away when there are highlights), the downloads
and the checksums. RELEASE_NOTES.md holds only the latest release's
highlights: write over it for the next one.

    python3 scripts/release-notes.py <version> <tag> <previous tag> <apk> <dmg> [beta]

With `beta`, the notes are for terminus beta (beta.terminus.rcn.sh), which
installs beside terminus.
    python3 scripts/release-notes.py --title 2.0.0-beta   # -> 2.0 beta
"""

import hashlib
import os
import re
import subprocess
import sys

REPO = 'https://github.com/rcnsh/terminus'


def title(version: str) -> str:
    """'2.0.0-beta' -> '2.0 beta', '2.0.0-beta.2' -> '2.0 beta 2', '1.3.10' stays."""
    num, _, pre = version.partition('-')
    num = re.sub(r'^(\d+\.\d+)\.0$', r'\1', num)
    return f"{num} {pre.replace('.', ' ')}" if pre else num


def git(*args: str) -> str:
    return subprocess.run(['git', *args], capture_output=True, text=True, check=True).stdout


def sha(path: str) -> str:
    return hashlib.sha256(open(path, 'rb').read()).hexdigest()


def notes(version: str, tag: str, prev: str, apk: str, mac: str, channel: str = '') -> str:
    date = git('log', '-1', '--format=%cd', '--date=format:%-d %B %Y', tag).strip()
    beta = channel == 'beta'
    out = []
    if beta:
        out.append(
            '> [!NOTE]\n'
            '> **This is terminus beta**, from [beta.terminus.rcn.sh](https://beta.terminus.rcn.sh): the next version early, '
            'with its own account. It installs beside terminus as **terminus beta**. Expect rough edges, and tap '
            '**Is this wrong?** under any answer to tell us.\n'
        )
    elif '-' in version:
        out.append(
            '> [!NOTE]\n'
            "> **This is a beta.** It's what everyone gets from terminus.rcn.sh, but expect rough edges. "
            'Tap **Is this wrong?** under any answer to tell us.\n'
        )
    out.append(f'<sub>Released {date}</sub>\n')

    highlights = open('RELEASE_NOTES.md').read() if os.path.exists('RELEASE_NOTES.md') else ''
    first, _, rest = highlights.partition('\n')
    has_highlights = first.strip() == f'<!-- {version} -->'
    if has_highlights:
        out.append(rest.strip() + '\n')

    if not prev:
        # Everything before the first tag was the pre-beta build-up.
        out.append(
            'The first public beta.\n\n'
            '- An Android home-screen widget and app, and a Mac menu bar app\n'
            '- Imports your NUSMods timetable, and knows teaching weeks, recess, exams and public holidays\n'
            '- When to leave, which bus and from which side of the road, with arrival estimates and crowding\n'
            '- Sign in by email, pair devices with a QR code, and export or delete your data at any time\n'
        )
    else:
        changes = []
        for s in git('log', '--no-merges', '--reverse', '--format=%s', f'{prev}..{tag}').splitlines():
            # Conventional Commits: "feat(map): stops easier to tap" reads as "Stops easier to tap".
            s = re.sub(r'^[a-z]+(\([^)]*\))?!?: ', '', s)
            if re.fullmatch(r'(terminus|nusbus) \d+\.\d+\.\d+(-[a-z]+(\.\d+)?)?', s, re.I):
                continue  # the version bump itself
            if s.startswith('[ImgBot]') or s == 'optimize images':
                continue  # image compression, nothing to see
            s = s[:1].upper() + s[1:]
            # The first sentence of each commit subject.
            changes.append('- ' + re.split(r'(?<=[a-z0-9)`"])\. (?=[A-Z`])', s, maxsplit=1)[0].rstrip('.'))
        if changes:
            body = '\n'.join(changes)
            if has_highlights:
                out.append(f'<details>\n<summary><b>Every change since {prev}</b></summary>\n\n{body}\n\n</details>\n')
            else:
                out.append(f'## What changed\n\n{body}\n')

    a, m = os.path.basename(apk), os.path.basename(mac)
    # From 2.1, one APK per CPU type beside the main (arm64) one.
    here = os.path.dirname(apk)
    others = [(kind, os.path.basename(p)) for kind, p in (
        ('older 32-bit phones', apk.replace('.apk', '-armv7.apk')),
        ('x86_64 (emulators)', apk.replace('.apk', '-x86_64.apk')),
    ) if os.path.exists(p)]
    dl = f'{REPO}/releases/download/{tag}'
    name = 'terminus beta' if beta else 'terminus'
    keeps = ('It installs beside terminus, and installing over an older beta keeps everything.' if beta
             else 'Installing over an older version keeps everything.')
    other_rows = ''.join(f'| Android, {kind} | [`{x}`]({dl}/{x}) | Android 12 or later |\n' for kind, x in others)
    other_sums = ''.join(f'| `{x}` | `{sha(os.path.join(here, x))}` |\n' for _, x in others)
    out.append(
        '## Install\n\n'
        '| | Download | Runs on |\n'
        '| :-- | :-- | :-- |\n'
        f'| **Android** | [`{a}`]({dl}/{a}) | Android 12 or later |\n'
        f'{other_rows}'
        f'| **Mac** | [`{m}`]({dl}/{m}) | macOS 14 or later, Apple silicon |\n\n'
        f'- **Android:** open the APK and allow your browser to install apps when asked. Then open {name} and tap '
        f'**Get started**, or sign in if you already have an account. {keeps}\n'
        f'- **Mac:** open the disk image and drag {name} to Applications, then sign in with your email. '
        'The first time, macOS stops it, as it isn\'t from an identified developer: choose Done, then '
        '**Open Anyway** in System Settings, under Privacy & Security. '
        'Installed Mac apps update themselves.\n\n'
        '<details>\n<summary>SHA-256 checksums</summary>\n\n'
        '| File | SHA-256 |\n'
        '| :-- | :-- |\n'
        f'| `{a}` | `{sha(apk)}` |\n'
        f'{other_sums}'
        f'| `{m}` | `{sha(mac)}` |\n\n'
        '</details>'
    )
    return '\n'.join(out)


if __name__ == '__main__':
    if sys.argv[1] == '--title':
        print(title(sys.argv[2]))
    else:
        print(notes(*sys.argv[1:7]))
