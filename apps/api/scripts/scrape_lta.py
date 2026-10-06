#!/usr/bin/env python3
"""
The public buses that call at the campus's stops, into data/public.json.

Singapore's public buses stop at the same shelters as the shuttles along
Kent Ridge Crescent and Lower Kent Ridge Road, and a 95 or 151 is often the
first bus to a stop the shuttle also serves. This takes LTA DataMall's static
stops, routes and services, keeps the stops within reach of a shuttle stop,
and trims each public service to the stops it calls at there. The Worker
merges the result into the stop graph for accounts that turn public buses
on (src/graph.ts).

Runs weekly in CI like scrape_stops.py; the result is bundled into the Worker.
Reads LTA_ACCOUNT_KEY from the environment, falling back to .dev.vars. Never
prints or commits the key.

    python3 scripts/scrape_lta.py [--out data/public.json] [--dry-run]

Contains information from LTA DataMall, under the Singapore Open Data Licence.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import pathlib
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone

ROOT = pathlib.Path(__file__).resolve().parents[1]
BASE = "https://datamall2.mytransport.sg/ltaodataservice/"

# A public stop this close to a shuttle stop is the same shelter: the shuttle
# stop keeps its code and gains the public one. Measured ones are under 12 m;
# the next is 24 m away and on the other side of the stop's name.
SAME_SHELTER_M = 20
# Public stops this far from the nearest shuttle stop are kept as stops of
# their own: Kent Ridge Terminal's public stop on Clementi Road, the NUH
# stops, the stops opposite the terminal. Not Pasir Panjang Road or the AYE,
# 250 m and more away: this is about the campus, not the island.
RADIUS_M = 200


def load_dev_vars() -> None:
    """Fill unset variables from .dev.vars. Values are never echoed."""
    path = ROOT / ".dev.vars"
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key, value = key.strip(), value.strip().strip('"').strip("'")
        if value and not os.environ.get(key):
            os.environ[key] = value


def get_json(path: str) -> dict:
    req = urllib.request.Request(BASE + path, headers={"AccountKey": os.environ["LTA_ACCOUNT_KEY"], "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            return json.loads(res.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raise SystemExit(f"GET {path} -> HTTP {exc.code}") from exc
    except urllib.error.URLError as exc:
        raise SystemExit(f"GET {path} -> unreachable ({exc.reason})") from exc


def dataset(name: str) -> list:
    """A whole static dataset: 500 rows a page, until a short page."""
    rows: list = []
    skip = 0
    while True:
        page = get_json(f"{name}?$skip={skip}").get("value") or []
        rows.extend(page)
        if len(page) < 500:
            return rows
        skip += 500


def metres(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    lat = math.radians((lat1 + lat2) / 2)
    return math.hypot((lon2 - lon1) * 111_320 * math.cos(lat), (lat2 - lat1) * 110_540)


def hhmm(v: str | None) -> str | None:
    """LTA's "0622" as "06:22"; "2400" is midnight; "-" and blanks are unknown."""
    if not v or not v.strip().isdigit() or len(v.strip()) != 4:
        return None
    h, m = int(v[:2]), int(v[2:])
    if h == 24 and m == 0:
        return "00:00"
    if h > 23 or m > 59:
        return None
    return f"{h:02d}:{m:02d}"


def mean_minutes(freq: str | None) -> int | None:
    """"09-16" (minutes between buses) as its mean; "-" is unknown."""
    if not freq:
        return None
    parts = [p for p in freq.replace("–", "-").split("-") if p.strip().isdigit()]
    if not parts:
        return None
    return round(sum(int(p) for p in parts) / len(parts))


def build(shuttle: dict, stops: list, routes: list, services: list) -> dict:
    sstops = shuttle["stops"]

    # Each public stop near campus: the same shelter as a shuttle stop, or a
    # stop of its own. One public stop per shuttle stop, the nearest.
    near = []
    for s in stops:
        try:
            lat, lon = float(s["Latitude"]), float(s["Longitude"])
        except (KeyError, TypeError, ValueError):
            continue
        if not lat or not lon:
            continue
        best = min(((metres(lat, lon, t["lat"], t["lon"]), t) for t in sstops), key=lambda x: x[0])
        if best[0] <= RADIUS_M:
            near.append({"code": str(s["BusStopCode"]), "name": str(s.get("Description") or "").strip(), "road": str(s.get("RoadName") or "").strip(), "lat": lat, "lon": lon, "d": best[0], "shuttle": best[1]["code"]})
    near.sort(key=lambda x: x["d"])
    merged: dict[str, str] = {}  # public code -> shuttle code
    taken: set[str] = set()
    for s in near:
        if s["d"] <= SAME_SHELTER_M and s["shuttle"] not in taken:
            merged[s["code"]] = s["shuttle"]
            taken.add(s["shuttle"])
    code_of = lambda c: merged.get(c, c)
    campus = {s["code"] for s in near}

    # Each service and direction, trimmed to its campus stops, in order. A
    # loop keeps the closing stop so the graph sees it as a loop; a service
    # with one campus stop can't take anyone anywhere and is dropped.
    by_dir: dict[tuple[str, str], list] = {}
    for r in routes:
        key = (str(r["ServiceNo"]), str(r["Direction"]))
        by_dir.setdefault(key, []).append(r)
    svc_rows = {(str(s["ServiceNo"]), str(s["Direction"])): s for s in services}
    out_routes: dict[str, list] = {}
    along: dict[str, list] = {}
    loops: dict[str, bool] = {}
    public: dict[str, dict] = {}
    hours: dict[str, dict] = {}
    headway: dict[str, int] = {}
    directions = {svc for svc, _ in by_dir}
    two_way = {svc for svc in directions if len({d for s, d in by_dir if s == svc}) > 1}
    for (svc, direction), rows in sorted(by_dir.items()):
        rows.sort(key=lambda r: int(r["StopSequence"]))
        on = [r for r in rows if str(r["BusStopCode"]) in campus]
        if len({str(r["BusStopCode"]) for r in on}) < 2:
            continue
        info = svc_rows.get((svc, direction)) or {}
        loop = bool((info.get("LoopDesc") or "").strip()) or (rows[0]["BusStopCode"] == rows[-1]["BusStopCode"] and len(rows) > 2)
        key = svc if svc not in two_way else f"{svc}/{direction}"
        seq = [code_of(str(r["BusStopCode"])) for r in on]
        km = [float(r.get("Distance") or 0) for r in on]
        if loop:
            # The loop closes at its terminal. When the trimmed sequence does
            # not end there, the way back round is the rest of the route.
            total = float(rows[-1].get("Distance") or km[-1])
            if seq[0] != seq[-1]:
                seq.append(seq[0])
                km.append(total + km[0])
        out_routes[key] = seq
        along[key] = [round((k - km[0]) * 1000) for k in km]
        loops[key] = loop
        first = on[0]
        public[key] = {
            "svc": svc,
            "operator": str(info.get("Operator") or rows[0].get("Operator") or ""),
            "origin": str(rows[0]["BusStopCode"]),
            "dest": str(rows[-1]["BusStopCode"]),
        }
        h = {
            "weekday": [hhmm(first.get("WD_FirstBus")), hhmm(first.get("WD_LastBus"))],
            "saturday": [hhmm(first.get("SAT_FirstBus")), hhmm(first.get("SAT_LastBus"))],
            "sunday": [hhmm(first.get("SUN_FirstBus")), hhmm(first.get("SUN_LastBus"))],
        }
        hours[key] = {d: w for d, w in h.items() if all(w)}
        freq = [mean_minutes(info.get(f)) for f in ("AM_Peak_Freq", "AM_Offpeak_Freq", "PM_Peak_Freq", "PM_Offpeak_Freq")]
        freq = [f for f in freq if f]
        if freq:
            headway[key] = max(freq) * 60

    # Only stops some kept service calls at: a stop within range that no
    # route reaches is a dot with nothing to say.
    used = {c for seq in out_routes.values() for c in seq}
    out_stops = []
    for s in near:
        if s["code"] in merged or s["code"] not in used:
            continue
        out_stops.append({"code": s["code"], "name": s["name"], "longName": f"{s['name']} ({s['road']})" if s["road"] else s["name"], "lat": s["lat"], "lon": s["lon"], "opposite": None, "near": s["shuttle"]})
    out_stops.sort(key=lambda s: s["code"])

    return {
        "generated": datetime.now(timezone.utc).isoformat(),
        "source": "LTA DataMall (BusStops, BusRoutes, BusServices) via scripts/scrape_lta.py; Singapore Open Data Licence",
        "radiusM": RADIUS_M,
        "stops": out_stops,
        "merged": {c: merged[c] for c in sorted(merged)},
        "routes": out_routes,
        "along": along,
        "loops": loops,
        "public": public,
        "serviceHours": hours,
        "headwayS": headway,
    }


def summary(data: dict, shuttle: dict) -> str:
    names = {s["code"]: s["name"] for s in shuttle["stops"]}
    lines = [f"{len(data['stops'])} public stops of their own, {len(data['merged'])} on a shuttle stop's shelter, {len(data['routes'])} services"]
    for pub, sh in data["merged"].items():
        lines.append(f"  {pub} = {sh} ({names.get(sh, '?')})")
    lines.append("routes:")
    for key, seq in data["routes"].items():
        h = data["serviceHours"].get(key, {}).get("weekday")
        lines.append(f"  {key:7} {' > '.join(seq)}  {h[0] + '-' + h[1] if h else 'hours unknown'}")
    return "\n".join(lines)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(ROOT / "data" / "public.json"))
    ap.add_argument("--dry-run", action="store_true", help="print a summary, write nothing")
    args = ap.parse_args()

    load_dev_vars()
    if not os.environ.get("LTA_ACCOUNT_KEY"):
        print("missing config: LTA_ACCOUNT_KEY (see .dev.vars.example)", file=sys.stderr)
        return 2

    shuttle = json.loads((ROOT / "data" / "stops.json").read_text())
    data = build(shuttle, dataset("BusStops"), dataset("BusRoutes"), dataset("BusServices"))
    print(summary(data, shuttle))
    if args.dry_run:
        return 0

    out = pathlib.Path(args.out)
    # Only write when something other than the timestamp changed, so the
    # weekly workflow doesn't commit a timestamp-only "refresh".
    if out.exists():
        try:
            previous = json.loads(out.read_text())
        except ValueError:
            previous = None
        strip = lambda g: {k: v for k, v in g.items() if k != "generated"}
        if previous is not None and strip(previous) == strip(data):
            print(f"public buses unchanged; left {out} as is")
            return 0
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(data, indent=1, ensure_ascii=False) + "\n")
    print(f"wrote {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
