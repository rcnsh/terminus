#!/usr/bin/env python3
"""
How fresh are the feed's arrival times? Polls shuttle-service for at most
MAX_STOPS stops, every few seconds (never under MIN_EVERY_S), for at most
MAX_MINUTES, and reports how often each service's time changes, by how much,
how often two replies in a row are the same, and the reply's TimeStamp. That
says whether the Worker's 15 s arrivals cache (TTL.arrivalsMs) hides any
updates, and whether NUS updates on a fixed cycle.

A temporary, bounded test the owner allowed past rule 2 (CLAUDE.md): it calls
NUS directly, outside the Worker's cache. So that a refusal here can't touch
production, it mints its own guest token with a fresh random device id (never
NEXTBUS_DEVICE_ID, and never the Worker's KV), and the first failure of any
kind ends the run: it never retries, backs off or tries again faster.

Same config as scrape_stops.py (environment, falling back to .dev.vars).
Never prints a credential, a device id or a plate.

    python3 scripts/probes/probe_arrivals.py [--minutes 10] [--every 5] [--trace FILE] [COM3 UTOWN KR-MRT PGP]

--trace also writes every reading, one JSON object a line (seconds since the
start, stop, service, berth, the times as the feed gave them, the reply's
TimeStamp). No plates.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import statistics
import sys
import time
from datetime import datetime, timedelta, timezone

# The feed client is the weekly scrape's (scripts/data/scrape_stops.py).
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data"))
from scrape_stops import REQUIRED, ROOT, get_session, load_dev_vars, pick_list, proxy


# Limits, enforced here rather than left as defaults: the test must stay small.
MIN_EVERY_S = 5.0
MAX_MINUTES = 15.0
MAX_STOPS = 4
# A stop code as the graph spells it (COM3, KR-MRT, UHALL-OPP); it must also be in stops.json.
STOP_CODE = re.compile(r"[A-Z0-9]{1,12}(-[A-Z0-9]{1,6}){0,2}")
SGT = timezone(timedelta(hours=8))


def percentile(xs: list, p: float) -> float:
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(p * len(xs)))]


def known_stops() -> set:
    data = json.loads((ROOT / "data" / "stops.json").read_text())
    stops = data.get("stops", data) if isinstance(data, dict) else data
    rows = stops.values() if isinstance(stops, dict) else stops
    return {s.get("code") for s in rows if isinstance(s, dict)}


def seconds(v) -> float | None:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if f == f else None


def failure(exc: BaseException) -> str:
    """The kind of failure only: the scraper's message can carry a URL path."""
    text = str(exc)
    for pat in (r"code=(\S+)", r"HTTP (\d{3})", r"(unreachable)", r"(token mint rejected)"):
        hit = re.search(pat, text)
        if hit:
            return hit.group(0)
    return type(exc).__name__


def stamp_lag(stamp: str, at: float) -> float | None:
    """How many seconds before `at` (a wall-clock time) the reply's TimeStamp
    says it was made; None when it doesn't parse. No zone means Singapore."""
    try:
        t = datetime.fromisoformat(stamp.replace("Z", "+00:00"))
    except ValueError:
        return None
    if t.tzinfo is None:
        t = t.replace(tzinfo=SGT)
    return at - t.timestamp()


def readings(data) -> list:
    """(service, berth, first time, next time, [eta_s...]) for each row, as given."""
    out = []
    for item in pick_list(data, "timings", "shuttles", "Shuttles", "ShuttleService", "services", "arrivals"):
        if not isinstance(item, dict):
            continue
        svc = str(item.get("name") or item.get("route") or item.get("serviceName") or "").strip()
        if not svc:
            continue
        berth = str(item.get("busStopCode") or item.get("busstopcode") or "")
        etas = item.get("_etas") or item.get("nextArrivals") or []
        eta_s = [seconds(e.get("eta_s")) for e in etas if isinstance(e, dict)] if isinstance(etas, list) else []
        out.append((svc, berth, str(item.get("arrivalTime", "")), str(item.get("nextArrivalTime", "")), eta_s))
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("stops", nargs="*", default=["COM3", "UTOWN", "KR-MRT", "PGP"])
    ap.add_argument("--minutes", type=float, default=10)
    ap.add_argument("--every", type=float, default=MIN_EVERY_S, help=f"seconds between polls of each stop, at least {MIN_EVERY_S:g}")
    ap.add_argument("--trace", help="also write every reading to this file, as JSON lines")
    args = ap.parse_args()
    args.stops = list(dict.fromkeys(args.stops))
    bad = [s for s in args.stops if not STOP_CODE.fullmatch(s)]
    if bad:
        ap.error(f"not a stop code: {' '.join(bad)}")
    unknown = [s for s in args.stops if s not in known_stops()]
    if unknown:
        ap.error(f"not in stops.json: {' '.join(unknown)}")
    if not args.stops or len(args.stops) > MAX_STOPS:
        ap.error(f"{len(args.stops)} stops; 1 to {MAX_STOPS} in one run")
    # NaN fails both comparisons, so it is caught here too.
    if not args.every >= MIN_EVERY_S:
        print(f"--every {args.every:g} is below the floor; using {MIN_EVERY_S:g} s", file=sys.stderr)
        args.every = MIN_EVERY_S
    if not 0 < args.minutes <= MAX_MINUTES:
        print(f"--minutes {args.minutes:g} is out of range; using {MAX_MINUTES:g}", file=sys.stderr)
        args.minutes = MAX_MINUTES

    load_dev_vars()
    # Never the Worker's device id: a fresh random one (scrape_stops.device_id),
    # as each uNivUS install has its own.
    os.environ.pop("NEXTBUS_DEVICE_ID", None)
    missing = [k for k in REQUIRED if not os.environ.get(k)]
    if missing:
        print(f"missing config: {', '.join(missing)}", file=sys.stderr)
        return 2

    ended = None
    try:
        session = get_session()
    except (SystemExit, Exception) as exc:
        print(f"## Arrivals probe\n\nStopped before the first poll: {failure(exc)}.")
        return 1

    # (stop, svc, berth) -> [(t, first, next, eta_s)]
    seen: dict = {}
    replies: dict = {s: [] for s in args.stops}  # stop -> [(t, digest of the rows)]
    stamps: dict = {s: [] for s in args.stops}  # stop -> [(t, TimeStamp, lag s)]
    calls = 0
    trace = open(args.trace, "w") if args.trace else None
    start = time.monotonic()
    end = start + args.minutes * 60
    while ended is None and time.monotonic() < end:
        tick = time.monotonic()
        for stop in args.stops:
            calls += 1
            try:
                data = proxy(session, "shuttle-service", busstopname=stop)
            except (SystemExit, Exception) as exc:
                # Any refusal, 429, 5xx or timeout ends the run: never ask again.
                ended = f"{stop}: {failure(exc)}"
                break
            t = time.monotonic() - start
            rows = readings(data)
            replies[stop].append((t, hashlib.sha256(json.dumps(rows).encode()).hexdigest()))
            if isinstance(data, dict) and data.get("TimeStamp") is not None:
                stamp = str(data["TimeStamp"])
                stamps[stop].append((t, stamp, stamp_lag(stamp, time.time())))
            for svc, berth, first_t, next_t, eta_s in rows:
                seen.setdefault((stop, svc, berth), []).append((t, first_t, next_t, eta_s))
                if trace:
                    row = {"t": round(t, 1), "stop": stop, "svc": svc, "berth": berth, "first": first_t, "next": next_t, "eta_s": eta_s}
                    if stamps[stop]:
                        row["stamp"] = stamps[stop][-1][1]
                    trace.write(json.dumps(row) + "\n")
        if ended is None:
            time.sleep(max(0, args.every - (time.monotonic() - tick)))
    took = time.monotonic() - start
    if trace:
        trace.close()

    print(f"## Arrivals probe: {took / 60:.1f} min, every {args.every:g} s, {calls} calls\n")
    print(f"Started {datetime.now(SGT) - timedelta(seconds=took):%a %d %b %H:%M} Singapore time.\n")
    if ended:
        print(f"**Ended early** at the first failure ({ended}).\n")
    print("*Changes*: polls where the next bus's time differs from the poll before.")
    print("*Held*: how long a time stayed the same between two changes.")
    print("*Moved*: with `eta_s`, how far the bus's arrival moment (poll time + eta_s) moved at a change;")
    print("a countdown that only ticks down moves it by about 0.\n")
    print("| stop | service | berth | polls | changes | held: median | p90 | max | moved: median | p90 | first time looks like |")
    print("|---|---|---|---|---|---|---|---|---|---|---|")
    all_held, all_moved = [], []
    for (stop, svc, berth), rows in sorted(seen.items()):
        held, moved, changes, last_change = [], [], 0, None
        for prev, cur in zip(rows, rows[1:]):
            a = (prev[1], prev[3][:1])
            b = (cur[1], cur[3][:1])
            if a == b:
                continue
            changes += 1
            if last_change is not None:
                held.append(cur[0] - last_change)
            last_change = cur[0]
            if prev[3][:1] and cur[3][:1] and prev[3][0] is not None and cur[3][0] is not None:
                moved.append(abs((cur[0] + cur[3][0]) - (prev[0] + prev[3][0])))
        all_held += held
        all_moved += moved
        firsts = {r[1] for r in rows}
        kind = "seconds (eta_s)" if any(r[3][:1] and r[3][0] is not None for r in rows) else ", ".join(sorted(firsts)[:3]) + ("…" if len(firsts) > 3 else "")
        fmt = lambda xs, f: f"{f(xs):.0f} s" if xs else "-"
        print(
            f"| {stop} | {svc} | {berth or '-'} | {len(rows)} | {changes} | {fmt(held, statistics.median)} | "
            f"{fmt(held, lambda h: percentile(h, 0.9))} | {fmt(held, max)} | {fmt(moved, statistics.median)} | "
            f"{fmt(moved, lambda h: percentile(h, 0.9))} | {kind} |"
        )
    if all_held:
        print(
            f"\nAll services: a time held {statistics.median(all_held):.0f} s (median), "
            f"{percentile(all_held, 0.9):.0f} s at p90, over {len(all_held)} changes."
        )
        buckets: dict = {}
        for h in all_held:
            b = int(h // 5 * 5)
            buckets[b] = buckets.get(b, 0) + 1
        print("\n| held (s, in 5 s bins) | times |\n|---|---|")
        for k in sorted(buckets):
            print(f"| {k}–{k + 5} | {buckets[k]} |")
    if all_moved:
        real = [m for m in all_moved if m >= 5]
        print(f"\nOf {len(all_moved)} changes with eta_s, {len(real)} moved the arrival moment by 5 s or more (a new prediction, not a countdown).")

    print("\n| stop | replies | same as the one before | TimeStamp changes | TimeStamp held: median | lag behind our clock: median | max |")
    print("|---|---|---|---|---|---|---|")
    for stop in args.stops:
        r = replies[stop]
        same = sum(1 for a, b in zip(r, r[1:]) if a[1] == b[1])
        st = stamps[stop]
        held, last = [], None
        for a, b in zip(st, st[1:]):
            if a[1] != b[1]:
                if last is not None:
                    held.append(b[0] - last)
                last = b[0]
        lags = [x[2] for x in st if x[2] is not None]
        changes = sum(1 for a, b in zip(st, st[1:]) if a[1] != b[1])
        print(
            f"| {stop} | {len(r)} | {same} | {changes if st else 'none in reply'} | "
            f"{f'{statistics.median(held):.0f} s' if held else '-'} | "
            f"{f'{statistics.median(lags):.1f} s' if lags else '-'} | {f'{max(lags):.1f} s' if lags else '-'} |"
        )
    return 1 if ended else 0


if __name__ == "__main__":
    raise SystemExit(main())
