#!/usr/bin/env python3
"""Checks against the live site before a release goes up.

    scripts/release-check.py build <site> <build>      # the Mac build is new
    scripts/release-check.py api <site> <version>      # the Worker is new enough

build: Sparkle installs an update only when its build number
(CFBundleVersion, the appcast's sparkle:version) is above the installed one,
so an appcast with a build that isn't strictly greater than the live one
would leave every Mac where it is. A site with no appcast yet passes.

api: the apps of a version expect its API. The Worker's version is the one
in its OpenAPI spec (/openapi.json, API_VERSION); it must be at least
<version>.

Prints what it found; exits 1 when the release must not go up, 2 when the
site couldn't be read.
"""
import json, re, sys, urllib.error, urllib.request


def fetch(url):
    # Past any cache: this is about what's deployed now.
    req = urllib.request.Request(url, headers={'Cache-Control': 'no-cache', 'User-Agent': 'terminus-release'})
    with urllib.request.urlopen(req, timeout=20) as r:
        return r.read().decode('utf-8')


def numbers(s):
    """'54' -> (54,), '1.2.10' -> (1, 2, 10): Sparkle compares builds this way."""
    return tuple(int(n) for n in re.findall(r'\d+', s))


def semver(v):
    """'2.5.0-beta.1' -> a key that sorts a pre-release below its release."""
    core, _, pre = v.partition('-')
    pre_key = tuple((0, int(p), '') if p.isdigit() else (1, 0, p) for p in pre.split('.')) if pre else None
    # A release (no pre-release part) sorts above any of its pre-releases.
    return (numbers(core), pre_key is None, pre_key or ())


def check_build(site, build):
    try:
        xml = fetch(f'{site}/download/appcast.xml')
    except urllib.error.HTTPError as e:
        if e.code == 404:
            print(f'no appcast at {site} yet; build {build} is the first')
            return 0
        print(f"couldn't read {site}'s appcast: {e}")
        return 2
    except Exception as e:  # noqa: BLE001 - any failure to read is "can't tell"
        print(f"couldn't read {site}'s appcast: {e}")
        return 2
    live = [b.strip() for b in re.findall(r'<sparkle:version>([^<]+)</sparkle:version>', xml)]
    if not live:
        print(f'the appcast at {site} names no build; build {build} is the first')
        return 0
    top = max(live, key=numbers)
    if numbers(build) > numbers(top):
        print(f'Mac build {build} is above the live appcast\'s {top}')
        return 0
    print(f'Mac build {build} is not above the live appcast\'s {top}: no Mac would update. Raise the build (CFBundleVersion; a beta\'s is the commit count) past {top}')
    return 1


def check_api(site, version):
    try:
        live = json.loads(fetch(f'{site}/openapi.json'))['info']['version']
    except Exception as e:  # noqa: BLE001
        print(f"couldn't read the API version at {site}: {e}")
        return 2
    if semver(live) >= semver(version):
        print(f'the Worker at {site} is API {live}, at least {version}')
        return 0
    deploy = 'pnpm run deploy:beta' if 'beta.' in site else 'pnpm run deploy'
    print(f'the Worker at {site} is API {live}, older than {version}: deploy it first (cd apps/api && {deploy})')
    return 1


if __name__ == '__main__':
    if len(sys.argv) != 4 or sys.argv[1] not in ('build', 'api'):
        print(__doc__.split('\n\n')[1], file=sys.stderr)
        sys.exit(2)
    what, site, value = sys.argv[1:]
    sys.exit(check_build(site, value) if what == 'build' else check_api(site, value))
