#!/usr/bin/env python3
"""
Each bus service's path along real roads, for data/shapes.json (the lines on
the map, and where a live bus is along its route).

    python3 apps/api/scripts/route_shapes.py

Downloads the drivable roads around Kent Ridge from OpenStreetMap's Overpass
API and routes each service stop to stop along them, the way it runs in
data/stops.json: one-way streets respected, car park aisles avoided. A stop
may join the road at any road node close to it, and the combination that
makes the whole route shortest wins, so a stop on a dual carriageway lands on
the side the bus drives on. Map data (c) OpenStreetMap contributors, ODbL.

Run weekly by the scrape workflow after the stop graph. When Overpass is down
it exits 1 and writes nothing: the committed shapes stay, and the API draws a
route whose stops have changed since as straight lines until the next run.

Writes data/shapes.json:
  routes.<svc>.stops  the stop sequence the line was routed for
  routes.<svc>.line   [lon, lat] points
  routes.<svc>.at     metres along the line at each of those stops
"""

import heapq
import json
import math
import pathlib
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = ROOT / "data" / "shapes.json"
MIRRORS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]
# South, west, north, east: every stop (Botanic Gardens included) plus a margin.
BBOX = (1.282, 103.760, 1.330, 103.826)
DRIVABLE = "motorway|trunk|primary|secondary|tertiary|unclassified|residential|service|living_street|busway|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link|road"
SNAP_M = 60
SNAP_COST = 3.0  # each metre a stop sits off the road counts this much
SIMPLIFY_M = 2.0
# A leg this much longer than the straight line, and this many metres longer,
# is a wrong turn in the map data, not a route: refuse to write it.
ODD_RATIO, ODD_EXTRA_M = 2.5, 400


def fetch(query: str) -> dict:
    """The public Overpass servers are often busy (504, 429): each mirror, a few times."""
    body = urllib.parse.urlencode({"data": query}).encode()
    last = None
    for attempt in range(3):
        for url in MIRRORS:
            req = urllib.request.Request(url, data=body, headers={"User-Agent": "terminus-route-shapes"})
            try:
                with urllib.request.urlopen(req, timeout=180) as res:
                    return json.loads(res.read())
            except Exception as exc:  # noqa: BLE001
                last = exc
                print(f"  {url}: {exc}", file=sys.stderr)
        time.sleep(20 * (attempt + 1))
    raise SystemExit(f"Overpass unreachable: {last}")


def haversine(a, b):
    r = 6371000
    p1, p2 = math.radians(a[0]), math.radians(b[0])
    dp, dl = p2 - p1, math.radians(b[1] - a[1])
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


def build(osm):
    nodes = {el["id"]: (el["lat"], el["lon"]) for el in osm["elements"] if el["type"] == "node"}
    adj = {}
    for el in osm["elements"]:
        if el["type"] != "way":
            continue
        tags = el.get("tags", {})
        ow = tags.get("oneway")
        forward_only = ow in ("yes", "true", "1") or tags.get("junction") in ("roundabout", "circular")
        backward_only = ow == "-1"
        # A car park aisle is a road, but no bus cuts through one.
        penalty = 3.0 if tags.get("service") in ("parking_aisle", "drive-through") else 1.0
        ids = [i for i in el["nodes"] if i in nodes]
        for a, b in zip(ids, ids[1:]):
            d = haversine(nodes[a], nodes[b]) * penalty
            if not backward_only:
                adj.setdefault(a, []).append((b, d))
            if not forward_only:
                adj.setdefault(b, []).append((a, d))
    return nodes, adj


def dijkstra(adj, src):
    dist, prev, heap = {src: 0.0}, {}, [(0.0, src)]
    while heap:
        d, u = heapq.heappop(heap)
        if d > dist.get(u, math.inf):
            continue
        for v, w in adj.get(u, ()):
            nd = d + w
            if nd < dist.get(v, math.inf):
                dist[v], prev[v] = nd, u
                heapq.heappush(heap, (nd, v))
    return dist, prev


def path(prev, src, dst):
    out = [dst]
    while out[-1] != src:
        out.append(prev[out[-1]])
    return out[::-1]


def simplify(pts, tol):
    """Douglas-Peucker on (lat, lon) points, in metres; keeps both ends."""
    if len(pts) < 3:
        return pts
    lat0 = math.radians(pts[0][0])
    xy = [((p[1]) * 111320 * math.cos(lat0), p[0] * 110540) for p in pts]
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        i, j = stack.pop()
        (ax, ay), (bx, by) = xy[i], xy[j]
        dx, dy = bx - ax, by - ay
        seg = math.hypot(dx, dy) or 1e-9
        best, at = 0.0, None
        for k in range(i + 1, j):
            px, py = xy[k]
            d = abs(dy * (px - ax) - dx * (py - ay)) / seg
            if d > best:
                best, at = d, k
        if at is not None and best > tol:
            keep[at] = True
            stack += [(i, at), (at, j)]
    return [p for p, k in zip(pts, keep) if k]


def main():
    s, w, n, e = BBOX
    osm = fetch(f'[out:json][timeout:180];way["highway"~"^({DRIVABLE})$"]({s},{w},{n},{e});(._;>;);out body;')
    nodes, adj = build(osm)
    print(f"roads: {sum(1 for el in osm['elements'] if el['type'] == 'way')} ways, {len(adj)} routable nodes")
    if len(adj) < 5000:
        raise SystemExit("Overpass returned too few roads; not writing")

    graph = json.loads((ROOT / "data" / "stops.json").read_text())
    stops = {st["code"]: (st["lat"], st["lon"]) for st in graph["stops"]}
    routable = list(adj)

    def candidates(pt):
        near = sorted((haversine(pt, nodes[i]), i) for i in routable if abs(nodes[i][0] - pt[0]) < 0.001 and abs(nodes[i][1] - pt[1]) < 0.001)
        within = [(i, d) for d, i in near if d <= SNAP_M][:8]
        return within or [(i, d) for d, i in near[:1]]

    cache, routes, problems = {}, {}, []
    for svc, seq in graph["routes"].items():
        cands = [candidates(stops[c]) for c in seq]
        if not all(cands):
            problems.append(f"{svc}: a stop has no road near it")
            continue
        # Viterbi over the stops: the road node per stop that makes the route shortest.
        best = [{i: (d * SNAP_COST, None) for i, d in cands[0]}]
        for k in range(1, len(seq)):
            layer = {}
            for j, dj in cands[k]:
                options = []
                for i, (ci, _) in best[k - 1].items():
                    if i not in cache:
                        cache[i] = dijkstra(adj, i)
                    dd = cache[i][0].get(j)
                    if dd is not None:
                        options.append((ci + dd + dj * SNAP_COST, i))
                if options:
                    layer[j] = min(options)
            if not layer:
                problems.append(f"{svc}: no road path from {seq[k - 1]} to {seq[k]}")
                break
            best.append(layer)
        else:
            end = min(best[-1], key=lambda j: best[-1][j][0])
            chosen = [end]
            for k in range(len(seq) - 1, 0, -1):
                chosen.append(best[k][chosen[-1]][1])
            chosen.reverse()
            line, at = [], [0.0]
            for k in range(len(seq) - 1):
                a, b = chosen[k], chosen[k + 1]
                leg = [nodes[i] for i in (path(cache[a][1], a, b) if a != b else [a])]
                road = sum(haversine(x, y) for x, y in zip(leg, leg[1:]))
                straight = haversine(stops[seq[k]], stops[seq[k + 1]])
                if road > ODD_RATIO * straight and road - straight > ODD_EXTRA_M:
                    problems.append(f"{svc}: {seq[k]} to {seq[k + 1]} is {round(road)} m by road, {round(straight)} m straight")
                # Each leg simplified on its own, so every stop stays a vertex.
                leg = simplify(leg, SIMPLIFY_M)
                line.extend(leg if not line else leg[1:])
                at.append(at[-1] + sum(haversine(x, y) for x, y in zip(leg, leg[1:])))
            routes[svc] = {
                "stops": seq,
                "line": [[round(lon, 5), round(lat, 5)] for lat, lon in line],
                "at": [round(m) for m in at],
            }
            print(f"{svc}: {round(at[-1])} m, {len(line)} points")

    if problems:
        print("Not writing shapes.json:", file=sys.stderr)
        for p in problems:
            print(f"  - {p}", file=sys.stderr)
        raise SystemExit(1)
    OUT.write_text(json.dumps({
        "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": "OpenStreetMap roads (c) OpenStreetMap contributors, ODbL, via scripts/route_shapes.py",
        "routes": routes,
    }, separators=(",", ":")) + "\n")
    print(f"wrote {OUT.relative_to(ROOT.parent.parent)}: {OUT.stat().st_size // 1024} KB")


if __name__ == "__main__":
    main()
