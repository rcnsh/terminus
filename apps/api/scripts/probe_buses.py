#!/usr/bin/env python3
"""
How often does the live-bus feed move a bus? Polls active-bus once a second
per service for a few minutes, and reports, per service, how long a moving
bus's position stays the same between changes. That says how often the map
can usefully poll (/buses caches TTL.busesMs).

Same guest token and bus proxy as scrape_stops.py, and the same config
(environment, falling back to .dev.vars). Never prints a credential, and
buses are shown as #1, #2..., not plates.

    python3 scripts/probe_buses.py [--minutes 3] [--every 1] [A1 A2 D2 ...]
"""

from __future__ import annotations

import argparse
import os
import statistics
import sys
import time

from scrape_stops import REQUIRED, get_session, load_dev_vars, pick_list, proxy


def percentile(xs: list, p: float) -> float:
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(p * len(xs)))]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("services", nargs="*", default=["A1", "A2", "D1", "D2"])
    ap.add_argument("--minutes", type=float, default=3)
    ap.add_argument("--every", type=float, default=1, help="seconds between polls of each service")
    args = ap.parse_args()

    load_dev_vars()
    missing = [k for k in REQUIRED if not os.environ.get(k)]
    if missing:
        print(f"missing config: {', '.join(missing)}", file=sys.stderr)
        return 2

    session = get_session()
    names: dict = {}  # plate -> "#n"
    # (svc, bus) -> [(t, lat, lng, speed)] for each poll that saw it
    seen: dict = {}
    stamps: dict = {svc: [] for svc in args.services}  # the reply's TimeStamp
    errors = 0
    start = time.monotonic()
    end = start + args.minutes * 60
    while time.monotonic() < end:
        tick = time.monotonic()
        for svc in args.services:
            try:
                data = proxy(session, "active-bus", route_code=svc)
            except SystemExit as exc:
                errors += 1
                print(f"{svc}: {exc}", file=sys.stderr)
                if errors > 20:
                    return 1
                session = get_session()
                continue
            t = time.monotonic() - start
            if isinstance(data, dict) and data.get("TimeStamp") is not None:
                stamps[svc].append((t, str(data["TimeStamp"])))
            for b in pick_list(data, "activebus", "activeBus", "ActiveBus", "buses"):
                if not isinstance(b, dict) or not b.get("vehplate"):
                    continue
                bus = names.setdefault(b["vehplate"], f"#{len(names) + 1}")
                try:
                    speed = float(b.get("speed") or 0)
                except (TypeError, ValueError):
                    speed = 0.0
                seen.setdefault((svc, bus), []).append((t, b.get("lat"), b.get("lng"), speed))
        time.sleep(max(0, args.every - (time.monotonic() - tick)))

    print(f"## Live-bus feed probe: {args.minutes:g} min, every {args.every:g} s\n")
    print("A *change* is a poll where the bus's position differs from the poll before.")
    print("*Held* is how long a moving bus's position stayed the same before a change.\n")
    print("| service | buses | polls | changes | held: median | p90 | max | reply TimeStamp changes |")
    print("|---|---|---|---|---|---|---|---|")
    all_held = []
    for svc in args.services:
        buses = [k for k in seen if k[0] == svc]
        polls = max((len(seen[k]) for k in buses), default=0)
        held, changes = [], 0
        for k in buses:
            rows = seen[k]
            last_change = None
            for prev, cur in zip(rows, rows[1:]):
                if (cur[1], cur[2]) != (prev[1], prev[2]):
                    changes += 1
                    # Only gaps between two changes of a moving bus: a
                    # standing bus holds its position because it stands.
                    if last_change is not None and cur[3] > 0:
                        held.append(cur[0] - last_change)
                    last_change = cur[0]
        all_held += held
        st = [s for _, s in stamps[svc]]
        stamp_changes = sum(1 for a, b in zip(st, st[1:]) if a != b)
        fmt = lambda f: f"{f(held):.1f} s" if held else "-"
        print(
            f"| {svc} | {len(buses)} | {polls} | {changes} | {fmt(statistics.median)} | "
            f"{fmt(lambda h: percentile(h, 0.9))} | {fmt(max)} | {stamp_changes if st else 'none in reply'} |"
        )
    if all_held:
        print(
            f"\nAll services: a moving bus's position changed every {statistics.median(all_held):.1f} s "
            f"(median), {percentile(all_held, 0.9):.1f} s at p90, over {len(all_held)} changes."
        )
        buckets = {}
        for h in all_held:
            buckets[round(h)] = buckets.get(round(h), 0) + 1
        print("\n| held (s, rounded) | times |\n|---|---|")
        for k in sorted(buckets):
            print(f"| {k} | {buckets[k]} |")
    else:
        print("\nNo moving bus changed position twice: no buses running, or the feed is frozen.")
    if errors:
        print(f"\n{errors} polls failed (see the log).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
