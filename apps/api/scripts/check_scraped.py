#!/usr/bin/env python3
"""Sanity checks on a freshly scraped stop graph and calendar, before the
scrape workflow commits them to main with no review.

The data comes from third parties (the NUS feed, NUSMods, data.gov.sg). The
test suite catches a graph the code can't use; this catches one that is
well-formed but wrong: half the stops gone, coordinates off campus, a file
ten times its usual size. Each is compared with the version in git.

    python3 apps/api/scripts/check_scraped.py

Exits 1 with the reasons when something looks off, so nothing is pushed.
"""

import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
DATA = "apps/api/data"
# NUS Kent Ridge, Bukit Timah and the stops between: generous on every side.
LAT = (1.25, 1.35)
LON = (103.74, 103.84)
# How much smaller a list may get in one scrape before a human should look.
MAX_DROP = 0.10
MAX_SIZE = 200_000
CODE = re.compile(r"^[A-Z0-9][A-Z0-9-]{0,23}$")
DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def committed(name):
    try:
        out = subprocess.run(["git", "show", f"HEAD:{DATA}/{name}"], cwd=ROOT, capture_output=True, check=True, text=True).stdout
        return json.loads(out)
    except (subprocess.CalledProcessError, json.JSONDecodeError):
        return None


def dropped(new, old, what, problems):
    if old and len(new) < len(old) * (1 - MAX_DROP):
        problems.append(f"{what}: {len(old)} -> {len(new)}, more than {int(MAX_DROP * 100)}% fewer")


def check_stops(problems):
    path = ROOT / DATA / "stops.json"
    if path.stat().st_size > MAX_SIZE:
        problems.append(f"stops.json is {path.stat().st_size} bytes")
    g = json.loads(path.read_text())
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
    for svc, seq in routes.items():
        if not isinstance(seq, list) or len(seq) < 2:
            problems.append(f"route {svc} has fewer than two stops")
            continue
        missing = [c for c in seq if c not in codes]
        if missing:
            problems.append(f"route {svc} goes through unknown stops {missing}")
    old = committed("stops.json")
    if old:
        dropped(stops, old.get("stops", []), "stops", problems)
        dropped(list(routes), list(old.get("routes", {})), "routes", problems)


def check_calendar(problems):
    path = ROOT / DATA / "calendar.json"
    if path.stat().st_size > MAX_SIZE:
        problems.append(f"calendar.json is {path.stat().st_size} bytes")
    c = json.loads(path.read_text())
    sems, hols = c.get("semesters"), c.get("holidays")
    if not isinstance(sems, list) or not isinstance(hols, list):
        problems.append("calendar.json has no semesters or holidays list")
        return
    for s in sems:
        if not DATE.match(str(s.get("start", ""))) or s.get("semester") not in (1, 2, 3, 4):
            problems.append(f"semester {s!r} is malformed")
    for h in hols:
        if not DATE.match(str(h.get("date", ""))) or not isinstance(h.get("name"), str) or len(h["name"]) > 80:
            problems.append(f"holiday {h!r} is malformed")
    # Past years roll off each January, so no comparison with git: at least
    # this year's terms must be there.
    if len(sems) < 4:
        problems.append(f"only {len(sems)} semesters")


def main():
    problems = []
    check_stops(problems)
    check_calendar(problems)
    if problems:
        print("The scraped data looks wrong, so it was not committed:", file=sys.stderr)
        for p in problems:
            print(f"  - {p}", file=sys.stderr)
        sys.exit(1)
    print("scraped data looks sane")


if __name__ == "__main__":
    main()
