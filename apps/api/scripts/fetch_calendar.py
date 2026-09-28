#!/usr/bin/env python3
"""
Build data/calendar.json: NUS semester start dates and Singapore public holidays.

Sources, both public and credential-free:
  - NUSMods' academic calendar (the Monday of week 1 for each semester)
    https://github.com/nusmodifications/nusmods/tree/master/packages/nusmods-academic-calendar
  - MOM's consolidated public holidays dataset on data.gov.sg
    https://data.gov.sg/datasets/d_8ef23381f9417e4d4254ee8b4dcdb176/view

Usage:
    python3 scripts/fetch_calendar.py [--out data/calendar.json]

Only rewrites the file when the dates actually change.
"""

import argparse
import datetime as dt
import json
import pathlib
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
NUSMODS = (
    "https://raw.githubusercontent.com/nusmodifications/nusmods/master/"
    "packages/nusmods-academic-calendar/academic-calendar.json"
)
HOLIDAYS = (
    "https://data.gov.sg/api/action/datastore_search"
    "?resource_id=d_8ef23381f9417e4d4254ee8b4dcdb176&limit=1000"
)


def get_json(url: str):
    req = urllib.request.Request(url, headers={"user-agent": "nusbus-calendar/1.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(ROOT / "data" / "calendar.json"))
    args = ap.parse_args()

    this_year = dt.date.today().year
    semesters = []
    for ay, sems in sorted(get_json(NUSMODS).items()):
        if int(ay.split("/")[1]) < this_year - 1:
            continue  # long past
        for sem, cfg in sorted(sems.items()):
            y, m, d = cfg["start"]
            semesters.append({"acadYear": ay, "semester": int(sem), "start": f"{y:04d}-{m:02d}-{d:02d}"})

    holidays = [
        {"date": r["date"], "name": r["holiday"].replace("’", "'")}
        for r in get_json(HOLIDAYS)["result"]["records"]
        if int(r["date"][:4]) >= this_year - 1
    ]
    holidays.sort(key=lambda h: h["date"])

    out = pathlib.Path(args.out)
    body = {"semesters": semesters, "holidays": holidays}
    if out.exists():
        old = json.loads(out.read_text())
        if {k: old.get(k) for k in body} == body:
            print("calendar unchanged")
            return
    body = {
        "generated": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": "NUSMods academic calendar; MOM public holidays via data.gov.sg",
        **body,
    }
    out.write_text(json.dumps(body, indent=2) + "\n")
    print(f"wrote {out}: {len(semesters)} semesters, {len(holidays)} holidays")


if __name__ == "__main__":
    main()
