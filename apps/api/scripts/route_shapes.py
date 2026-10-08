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
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = ROOT / "data" / "shapes.json"
# The Overpass project's own instance only: what it answers is committed to
# main unreviewed, so no third-party mirror gets a say in it.
OVERPASS = "https://overpass-api.de/api/interpreter"
# The roads in BBOX are a few MB of JSON; a reply this big is not them.
MAX_BYTES = 100_000_000
# South, west, north, east: every stop (Botanic Gardens included) plus a margin.
BBOX = (1.282, 103.760, 1.330, 103.826)
DRIVABLE = "motorway|trunk|primary|secondary|tertiary|unclassified|residential|service|living_street|busway|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link|road"
SNAP_M = 60
SNAP_COST = 3.0  # each metre a stop sits off the road counts this much
SIMPLIFY_M = 2.0
# A leg this much longer than the straight line, and this many metres longer,
# is a wrong turn in the map data, not a route: refuse to write it.
ODD_RATIO, ODD_EXTRA_M = 2.5, 400


class HttpsRedirects(urllib.request.HTTPRedirectHandler):
    """Follows a redirect only to https: what comes back is committed."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if urllib.parse.urlsplit(newurl).scheme != "https":
            raise urllib.error.HTTPError(req.full_url, code, "redirect to plain http refused", headers, fp)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


OPENER = urllib.request.build_opener(HttpsRedirects)


def fetch(query: str) -> dict:
    """The public Overpass server is often busy (504, 429): a few tries, further apart each time."""
    body = urllib.parse.urlencode({"data": query}).encode()
    last = None
    for attempt in range(4):
        req = urllib.request.Request(OVERPASS, data=body, headers={"User-Agent": "terminus-route-shapes"})
        try:
            with OPENER.open(req, timeout=180) as res:
                raw = res.read(MAX_BYTES + 1)
            if len(raw) > MAX_BYTES:
                raise SystemExit(f"Overpass sent more than {MAX_BYTES} bytes; not writing")
            return json.loads(raw)
        except SystemExit:
            raise
        except Exception as exc:  # noqa: BLE001
            last = exc
            print(f"  {OVERPASS}: {exc}", file=sys.stderr)
        if attempt < 3:
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
    shapes = {
        "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": "OpenStreetMap roads (c) OpenStreetMap contributors, ODbL, via scripts/route_shapes.py",
        "routes": routes,
    }
    # Only write when something other than the timestamp changed, so the
    # weekly workflow doesn't commit a timestamp-only "refresh".
    if OUT.exists():
        try:
            previous = json.loads(OUT.read_text())
        except ValueError:
            previous = None
        strip = lambda g: {k: v for k, v in g.items() if k != "generated"}
        if isinstance(previous, dict) and strip(previous) == strip(shapes):
            print(f"route shapes unchanged; left {OUT.relative_to(ROOT.parent.parent)} as is")
            return
    OUT.write_text(json.dumps(shapes, separators=(",", ":")) + "\n")
    print(f"wrote {OUT.relative_to(ROOT.parent.parent)}: {OUT.stat().st_size // 1024} KB")


if __name__ == "__main__":
    main()
