#!/usr/bin/env python3
"""ONE-OFF (Phase 0 of docs/map-plan.md; delete after): does the uNivUS bus
proxy give a route's road shape? Tries likely endpoint names for one route
and prints, for each, whether it answered and the shape of what came back:
keys, list lengths, the first item. No credentials are printed."""

import json
import sys

sys.path.insert(0, __file__.rsplit("/", 1)[0])
import scrape_stops as s  # noqa: E402

CANDIDATES = [
    "check-point", "checkpoint", "check-points", "checkpoints",
    "route-checkpoint", "route-check-point", "service-checkpoint",
    "route", "routes", "route-shape", "service-route", "polyline",
    "service-description", "active-bus", "bus-location",
]


def describe(node, depth=0):
    pad = "  " * depth
    if isinstance(node, dict):
        print(f"{pad}object keys: {sorted(node)[:20]}")
        for k, v in list(node.items())[:6]:
            if isinstance(v, (dict, list)):
                print(f"{pad}- {k}:")
                describe(v, depth + 1)
    elif isinstance(node, list):
        print(f"{pad}list of {len(node)}")
        if node:
            first = node[0]
            print(f"{pad}first: {json.dumps(first)[:300]}")
            if len(node) > 1:
                print(f"{pad}last:  {json.dumps(node[-1])[:300]}")


def main():
    s.load_dev_vars()
    session = s.get_session()
    for route in ["A1", "D2"]:
        for ep in CANDIDATES:
            try:
                data = s.proxy(session, ep, route_code=route)
            except SystemExit as exc:
                print(f"{route} {ep}: no ({exc})")
                continue
            print(f"{route} {ep}: YES")
            describe(data, 1)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
