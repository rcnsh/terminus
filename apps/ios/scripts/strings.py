#!/usr/bin/env python3 -I
"""Keeps the iPhone app's Chinese in step with its English.

Every phrase the app writes itself goes through L("English %@", ...), and
its Chinese lives in Support/zh-Hans.lproj/<Table>.strings, keyed by the
English: one table per part of the app (Sources/App/Buses -> Buses.strings,
Sources/Widgets -> Widgets.strings, anything else -> Localizable.strings).

    scripts/strings.py          fills in what's missing from the Android
                                app's and the Mac app's translations (the same
                                English, the same Chinese), sorted, and lists
                                what's still missing, to translate by hand
                                (the glossary is at the top of apps/api/src/i18n.ts)
    scripts/strings.py --check  fails if any phrase has no Chinese, or two
                                tables give one phrase different Chinese (CI)
"""
import html
import os
import re
import sys

IOS = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APPS = os.path.dirname(IOS)
ZH = os.path.join(IOS, 'Support', 'zh-Hans.lproj')

# L("...") and its first argument, a plain string literal (escapes allowed);
# LocalizedStringResource("...") too, the widgets' intent titles.
CALL = re.compile(r'\b(?:L|LocalizedStringResource)\(\s*"((?:[^"\\]|\\.)*)"')
# L(...) whose phrase isn't a literal (a variable, a ternary): the check
# can't see it, so its Chinese could be missing unseen. Not allowed. Read
# over whole files: swift-format puts a long phrase on the line after `L(`.
DYNAMIC = re.compile(r'\bL\((?!\s*")(?!\s*_ en: String)')


def table_for(path):
    rel = os.path.relpath(path, os.path.join(IOS, 'Sources'))
    parts = rel.split(os.sep)
    if parts[0] == 'App' and len(parts) > 2 and parts[1] in ('Buses', 'Map', 'Settings', 'Onboarding', 'Now'):
        return parts[1]
    if parts[0] == 'Widgets':
        return 'Widgets'
    if parts[0] == 'NotificationService':
        return 'Notifications'
    return 'Localizable'


def unescape(s):
    return s.encode('utf-8').decode('unicode_escape').encode('latin-1').decode('utf-8')


def dynamic():
    out = []
    for root, _, files in os.walk(os.path.join(IOS, 'Sources')):
        for f in files:
            if f.endswith('.swift'):
                p = os.path.join(root, f)
                text = open(p, encoding='utf-8').read()
                lines = text.split('\n')
                for m in DYNAMIC.finditer(text):
                    n = text.count('\n', 0, m.start()) + 1
                    if not lines[n - 1].lstrip().startswith('//'):
                        out.append(f'{os.path.relpath(p, IOS)}:{n}')
    return out


def used():
    out = {}
    for root, _, files in os.walk(os.path.join(IOS, 'Sources')):
        for f in files:
            if f.endswith('.swift'):
                p = os.path.join(root, f)
                for m in CALL.finditer(open(p, encoding='utf-8').read()):
                    out.setdefault(unescape(m.group(1)), set()).add(table_for(p))
    return out


STRINGS = re.compile(r'^\s*"((?:[^"\\]|\\.)*)"\s*=\s*"((?:[^"\\]|\\.)*)"\s*;', re.M)


def read_strings(path):
    if not os.path.exists(path):
        return {}
    return {unescape(k): unescape(v) for k, v in STRINGS.findall(open(path, encoding='utf-8').read())}


def esc(s):
    return s.replace('\\', '\\\\').replace('"', '\\"').replace('\n', '\\n')


def write_strings(path, d):
    with open(path, 'w', encoding='utf-8') as f:
        for k in sorted(d, key=str.lower):
            f.write(f'"{esc(k)}" = "{esc(d[k])}";\n')


def android():
    res = os.path.join(APPS, 'android', 'app', 'src', 'main', 'res')

    def load(p, keep_order):
        s = open(os.path.join(res, p), encoding='utf-8').read()
        out = {}
        for m in re.finditer(r'<string name="([^"]+)"[^>]*>(.*?)</string>', s, re.S):
            v = html.unescape(m.group(2)).replace("\\'", "'").replace('\\"', '"').replace('\\n', '\n')
            nums = re.findall(r'%(\d)\$[sd]', v)
            # Chinese that takes the blanks in another order keeps their numbers (%2$@ ... %1$@).
            if keep_order and nums != sorted(nums):
                v = re.sub(r'%(\d)\$[sd]', r'%\1$@', v)
            else:
                v = re.sub(r'%\d\$[sd]', '%@', v)
            out[m.group(1)] = v.replace('%s', '%@').replace('%d', '%@')
        return out
    en, zh = load('values/strings.xml', False), load('values-zh/strings.xml', True)
    return {v: zh[k] for k, v in en.items() if k in zh}


def mac():
    return read_strings(os.path.join(APPS, 'macos', 'Support', 'zh-Hans.lproj', 'Localizable.strings'))


def main():
    check = '--check' in sys.argv
    hidden = dynamic()
    if hidden:
        print('L() with a phrase that is not a string literal, which this check cannot read (write each phrase out):')
        for at in hidden:
            print(f'  {at}')
        if check:
            sys.exit(1)
    phrases = used()
    tables = {}
    for f in os.listdir(ZH) if os.path.isdir(ZH) else []:
        if f.endswith('.strings') and f != 'InfoPlist.strings':
            tables[f[:-8]] = read_strings(os.path.join(ZH, f))
    have = {}
    for t in tables.values():
        have.update(t)
    missing = sorted(p for p in phrases if p not in have)
    # One English phrase, one Chinese, whichever table it's in.
    clashes = sorted(p for p in have if len({t[p] for t in tables.values() if p in t}) > 1)
    if clashes:
        print('Different Chinese for the same phrase in different tables:')
        for p in clashes:
            print(f'  {p!r}: ' + ', '.join(f'{n}: {t[p]!r}' for n, t in sorted(tables.items()) if p in t))
        if check:
            sys.exit(1)
    if check:
        if missing:
            print('No Chinese for these phrases (scripts/strings.py fills what it can):')
            for p in missing:
                print(f'  {p!r} in {sorted(phrases[p])}')
            sys.exit(1)
        return
    known = {**android(), **mac()}
    still = []
    for p in missing:
        zh = known.get(p)
        if zh is None or len(re.findall(r'%(?:\d\$)?@', zh)) != p.count('%@'):
            still.append(p)
            continue
        t = sorted(phrases[p])[0]
        tables.setdefault(t, {})[p] = zh
    os.makedirs(ZH, exist_ok=True)
    for t, d in tables.items():
        write_strings(os.path.join(ZH, t + '.strings'), d)
    filled = len(missing) - len(still)
    print(f'{len(phrases)} phrases; filled {filled} from Android and the Mac; {len(still)} to translate:')
    for p in still:
        print(f'  [{sorted(phrases[p])[0]}] {p!r}')


main()
