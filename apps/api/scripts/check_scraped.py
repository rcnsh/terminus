#!/usr/bin/env python3
"""Sanity checks on a freshly scraped stop graph and calendar, before the
scrape workflow commits them to main with no review.

The data comes from third parties (the NUS feed, LTA DataMall, NUSMods, data.gov.sg). The
test suite catches a graph the code can't use; this catches one that is
well-formed but wrong: half the stops gone, coordinates off campus, a file
ten times its usual size, a stop moved down the road, a route run in a new
order, a semester moved. Each is compared with the version in git.

Some of these are real changes now and then (NUS reorders a route a few
times a year). The check still fails on them: a human looks, and commits the
data by hand.

    python3 apps/api/scripts/check_scraped.py

Exits 1 with the reasons when something looks off, so nothing is pushed.
"""

import datetime as dt
import json
import math
import re
import subprocess
import sys
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
DATA = "apps/api/data"
# NUS Kent Ridge, Bukit Timah and the stops between: generous on every side.
LAT = (1.25, 1.35)
LON = (103.74, 103.84)
# How much smaller a list may get in one scrape before a human should look.
MAX_DROP = 0.10
# A list shorter than this (the routes, the public stops and routes) may not
# lose a single item: 10% of eight routes would let one vanish unseen.
SMALL_LIST = 20
MAX_SIZE = 200_000
# A stop moved further than this is a different place. Re-surveyed stops
# have moved up to 87 m (UHALL, September 2026).
MAX_MOVE_M = 100
# Semesters start on a Monday, so any change is a whole week or more: none
# gets past this.
MAX_SHIFT_DAYS = 3
# Future holidays one scrape may take away (a corrected mistake); a year has
# about a dozen.
MAX_TAKEN_BACK = 3
MIN_HOLIDAYS = 5
CODE = re.compile(r"^[A-Z0-9][A-Z0-9-]{0,23}$")
DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
ACAD_YEAR = re.compile(r"^(\d{4})/(\d{4})$")
LTA_CODE = re.compile(r"^\d{5}$")
# Names are shown as they are: letters (Chinese too), digits, spaces and
# everyday punctuation. No '<', no control characters, no ':' (so no URL).
NAME_PUNCT = set(" '’&().,/+-")
DOMAIN = re.compile(r"(?i)www\.|[a-z0-9]\.[a-z]{2,}")
# The same rules as calendarsync.ts (valid()), so a calendar one takes the
# other does too.
HOLIDAY_NAME_MAX = 79
STOP_NAME_MAX = 40
LONG_NAME_MAX = 80


def committed(name):
    try:
        out = subprocess.run(["git", "show", f"HEAD:{DATA}/{name}"], cwd=ROOT, capture_output=True, check=True, text=True).stdout
        return json.loads(out)
    except (subprocess.CalledProcessError, json.JSONDecodeError):
        return None


def plain_name(s, max_len):
    """A name fit to show: not empty, not too long, nothing but letters,
    digits, spaces and ordinary punctuation, and no web address."""
    if not isinstance(s, str) or not s.strip() or len(s) > max_len:
        return False
    if any(not (unicodedata.category(ch)[0] in "LMN" or ch in NAME_PUNCT) for ch in s):
        return False
    return not DOMAIN.search(s)


def strict_date(s):
    """A real YYYY-MM-DD date (not 2026-02-30), or None."""
    if not isinstance(s, str) or not DATE.match(s):
        return None
    try:
        return dt.date.fromisoformat(s)
    except ValueError:
        return None


def dropped(new, old, what, problems):
    """[new] and [old] are the items' keys (codes, route names)."""
    if not old:
        return
    if len(old) < SMALL_LIST:
        gone = sorted(set(old) - set(new))
        if gone:
            problems.append(f"{what}: {', '.join(map(str, gone))} gone")
    elif len(new) < len(old) * (1 - MAX_DROP):
        problems.append(f"{what}: {len(old)} -> {len(new)}, more than {int(MAX_DROP * 100)}% fewer")


def _metres(a, b):
    """Between two [lon, lat] points."""
    lat = math.radians((a[1] + b[1]) / 2)
    return math.hypot((b[0] - a[0]) * 111320 * math.cos(lat), (b[1] - a[1]) * 110540)


def moved(new, old, what, problems):
    """Stops (lists of {code, lat, lon}) further than MAX_MOVE_M from where git has them."""
    before = {s.get("code"): s for s in old if isinstance(s, dict)}
    far = []
    for s in new:
        o = before.get(s.get("code"))
        if not o:
            continue
        try:
            d = _metres([o["lon"], o["lat"]], [s["lon"], s["lat"]])
        except (KeyError, TypeError):
            continue
        if d > MAX_MOVE_M:
            far.append(f"{s['code']} ({round(d)} m)")
    if far:
        problems.append(f"{what} moved more than {MAX_MOVE_M} m: {', '.join(far)}")


def reordered(new, old, what, problems):
    """Routes ({name: [codes]}) that run through other stops, or in another
    order, than in git. New routes are fine; gone ones are dropped()'s."""
    for key, seq in new.items():
        before = old.get(key)
        if isinstance(before, list) and before != seq:
            problems.append(f"{what} {key} changed: {' > '.join(map(str, before))} is now {' > '.join(map(str, seq))}")


def check_stops(problems):
    path = ROOT / DATA / "stops.json"
    if path.stat().st_size > MAX_SIZE:
        problems.append(f"stops.json is {path.stat().st_size} bytes")
    g = json.loads(path.read_text())
    check_graph(g, committed("stops.json"), problems)


def check_graph(g, old, problems):
    stops, routes = g.get("stops"), g.get("routes")
    if not isinstance(stops, list) or not isinstance(routes, dict):
        problems.append("stops.json has no stops list or routes map")
        return
    codes = set()
    for s in stops:
        code = s.get("code")
        if not isinstance(code, str) or not CODE.match(code):
            problems.append(f"stop code {code!r} is not a code")
            continue
        codes.add(code)
        lat, lon = s.get("lat"), s.get("lon")
        if not (isinstance(lat, (int, float)) and isinstance(lon, (int, float)) and LAT[0] <= lat <= LAT[1] and LON[0] <= lon <= LON[1]):
            problems.append(f"stop {code} is at {lat}, {lon}: not on campus")
        if not plain_name(s.get("name"), STOP_NAME_MAX) or not plain_name(s.get("longName"), LONG_NAME_MAX):
            problems.append(f"stop {code} has an odd name: {s.get('name')!r} / {s.get('longName')!r}")
    for svc, seq in routes.items():
        if not isinstance(seq, list) or len(seq) < 2:
            problems.append(f"route {svc} has fewer than two stops")
            continue
        missing = [c for c in seq if c not in codes]
        if missing:
            problems.append(f"route {svc} goes through unknown stops {missing}")
    if old:
        old_stops = old.get("stops", [])
        dropped([s.get("code") for s in stops], [s.get("code") for s in old_stops], "stops", problems)
        dropped(list(routes), list(old.get("routes", {})), "routes", problems)
        moved(stops, old_stops, "stops", problems)
        reordered(routes, old.get("routes", {}), "route", problems)


def check_shapes(problems):
    """Route lines: on campus, and each about as long as its stops imply.
    A route missing here is fine (drawn straight); a wrong one is not."""
    path = ROOT / DATA / "shapes.json"
    if not path.exists():
        return
    if path.stat().st_size > MAX_SIZE:
        problems.append(f"shapes.json is {path.stat().st_size} bytes")
    routes = json.loads(path.read_text()).get("routes")
    if not isinstance(routes, dict):
        problems.append("shapes.json has no routes map")
        return
    for svc, r in routes.items():
        line, at, seq = r.get("line"), r.get("at"), r.get("stops")
        if not (isinstance(line, list) and len(line) >= 2 and isinstance(at, list) and isinstance(seq, list) and len(at) == len(seq)):
            problems.append(f"shape {svc} is malformed")
            continue
        if any(not (LON[0] <= p[0] <= LON[1] and LAT[0] <= p[1] <= LAT[1]) for p in line):
            problems.append(f"shape {svc} leaves campus")
        if any(b < a for a, b in zip(at, at[1:])):
            problems.append(f"shape {svc} goes backwards between stops")
        # The distances along the line must match the line itself.
        straight = sum(_metres(a, b) for a, b in zip(line, line[1:]))
        if at[-1] and not (0.95 <= straight / at[-1] <= 1.05):
            problems.append(f"shape {svc}: stops say {at[-1]} m, line is {round(straight)} m")
    old = committed("shapes.json")
    if old:
        dropped(list(routes), list(old.get("routes", {})), "shapes", problems)


def check_public(problems):
    """The public buses (scrape_lta.py): LTA codes on campus, shared shelters
    that name real shuttle stops, routes through known stops with a distance
    at each. Compared with git like the stop graph: this too is committed
    unseen."""
    path = ROOT / DATA / "public.json"
    if not path.exists():
        return
    if path.stat().st_size > MAX_SIZE:
        problems.append(f"public.json is {path.stat().st_size} bytes")
    p = json.loads(path.read_text())
    shuttle = {s.get("code") for s in json.loads((ROOT / DATA / "stops.json").read_text()).get("stops", [])}
    check_public_data(p, shuttle, committed("public.json"), problems)


def check_public_data(p, shuttle, old, problems):
    stops, merged, routes, along = p.get("stops"), p.get("merged"), p.get("routes"), p.get("along")
    if not (isinstance(stops, list) and isinstance(merged, dict) and isinstance(routes, dict) and isinstance(along, dict)):
        problems.append("public.json has no stops, merged, routes or along")
        return
    codes = set(shuttle)
    for s in stops:
        code, lat, lon = s.get("code"), s.get("lat"), s.get("lon")
        if not (isinstance(code, str) and LTA_CODE.match(code)):
            problems.append(f"public stop code {code!r} is not an LTA code")
            continue
        codes.add(code)
        if not (isinstance(lat, (int, float)) and isinstance(lon, (int, float)) and LAT[0] <= lat <= LAT[1] and LON[0] <= lon <= LON[1]):
            problems.append(f"public stop {code} is at {lat}, {lon}: not on campus")
        if not plain_name(s.get("name"), STOP_NAME_MAX) or not plain_name(s.get("longName"), LONG_NAME_MAX):
            problems.append(f"public stop {code} has an odd name: {s.get('name')!r} / {s.get('longName')!r}")
    for code, sh in merged.items():
        if not LTA_CODE.match(str(code)) or sh not in shuttle:
            problems.append(f"shared shelter {code} -> {sh} names an unknown stop")
    for key, seq in routes.items():
        if not isinstance(seq, list) or len(seq) < 2:
            problems.append(f"public route {key} has fewer than two stops")
            continue
        missing = [c for c in seq if c not in codes]
        if missing:
            problems.append(f"public route {key} goes through unknown stops {missing}")
        m = along.get(key)
        if not isinstance(m, list) or len(m) != len(seq) or any(b < a for a, b in zip(m, m[1:])):
            problems.append(f"public route {key} has no usable distances")
    if old:
        old_stops = old.get("stops", [])
        dropped([s.get("code") for s in stops], [s.get("code") for s in old_stops], "public stops", problems)
        dropped(list(routes), list(old.get("routes", {})), "public routes", problems)
        moved(stops, old_stops, "public stops", problems)
        reordered(routes, old.get("routes", {}), "public route", problems)


def check_calendar(problems):
    path = ROOT / DATA / "calendar.json"
    if path.stat().st_size > MAX_SIZE:
        problems.append(f"calendar.json is {path.stat().st_size} bytes")
    check_calendar_data(json.loads(path.read_text()), committed("calendar.json"), dt.date.today(), problems)


def semester_ok(s):
    """As calendarsync.ts valid(): a real date, on a Monday, inside its own
    academic year (1 July of its first year to 31 July of its second)."""
    if not isinstance(s, dict) or s.get("semester") not in (1, 2, 3, 4):
        return False
    ay = ACAD_YEAR.match(str(s.get("acadYear", "")))
    start = strict_date(s.get("start"))
    if not ay or not start or int(ay[2]) != int(ay[1]) + 1 or start.weekday() != 0:
        return False
    return dt.date(int(ay[1]), 7, 1) <= start <= dt.date(int(ay[2]), 7, 31)


def holiday_ok(h):
    return isinstance(h, dict) and strict_date(h.get("date")) is not None and plain_name(h.get("name"), HOLIDAY_NAME_MAX)


def check_calendar_data(c, old, today, problems):
    sems, hols = c.get("semesters"), c.get("holidays")
    if not isinstance(sems, list) or not isinstance(hols, list):
        problems.append("calendar.json has no semesters or holidays list")
        return
    for s in sems:
        if not semester_ok(s):
            problems.append(f"semester {s!r} is malformed")
    for h in hols:
        if not holiday_ok(h):
            problems.append(f"holiday {h!r} is malformed")
    # Past years roll off each January, so no count compared with git: at
    # least this year's terms must be there.
    if len(sems) < 4:
        problems.append(f"only {len(sems)} semesters")
    if len(hols) < MIN_HOLIDAYS:
        problems.append(f"only {len(hols)} holidays")
    if not old:
        return
    # A semester git has must start when git says, give or take.
    was = {(s.get("acadYear"), s.get("semester")): strict_date(s.get("start")) for s in old.get("semesters", []) if isinstance(s, dict)}
    for s in sems:
        before, now = was.get((s.get("acadYear"), s.get("semester"))), strict_date(s.get("start"))
        if before and now and abs((now - before).days) > MAX_SHIFT_DAYS:
            problems.append(f"semester {s['acadYear']} {s['semester']} moved from {before} to {now}")
    # Holidays to come that vanished: a correction now and then, never many.
    dates = {h.get("date") for h in hols if isinstance(h, dict)}
    gone = sorted(
        h["date"]
        for h in old.get("holidays", [])
        if isinstance(h, dict) and (d := strict_date(h.get("date"))) and d > today and h["date"] not in dates
    )
    if len(gone) > MAX_TAKEN_BACK:
        problems.append(f"{len(gone)} holidays to come are gone: {', '.join(gone)}")


def main():
    problems = []
    check_stops(problems)
    check_shapes(problems)
    check_public(problems)
    check_calendar(problems)
    if problems:
        print("The scraped data looks wrong, so it was not committed:", file=sys.stderr)
        for p in problems:
            print(f"  - {p}", file=sys.stderr)
        sys.exit(1)
    print("scraped data looks sane")


if __name__ == "__main__":
    main()
