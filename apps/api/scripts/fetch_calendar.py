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

The Worker also fetches the same sources weekly into KV (src/calendarsync.ts),
so the calendar stays current between deploys; keep the two in step.
"""

import argparse
import datetime as dt
import json
import pathlib
import urllib.error
import urllib.parse
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

# Both replies are tens of KB; one this big is not the calendar.
MAX_BYTES = 5_000_000


class HttpsRedirects(urllib.request.HTTPRedirectHandler):
    """Follows a redirect only to https: what comes back is committed."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if urllib.parse.urlsplit(newurl).scheme != "https":
            raise urllib.error.HTTPError(req.full_url, code, "redirect to plain http refused", headers, fp)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


OPENER = urllib.request.build_opener(HttpsRedirects)


def get_json(url: str):
    req = urllib.request.Request(url, headers={"user-agent": "terminus-calendar/1.0"})
    with OPENER.open(req, timeout=30) as r:
        raw = r.read(MAX_BYTES + 1)
    if len(raw) > MAX_BYTES:
        raise SystemExit(f"{urllib.parse.urlsplit(url).netloc} sent more than {MAX_BYTES} bytes")
    return json.loads(raw)


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
