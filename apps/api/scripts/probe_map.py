#!/usr/bin/env python3
"""ONE-OFF (Phase 0 of docs/map-plan.md; delete after): can each bus route be
drawn along real roads from OpenStreetMap?

Downloads the drivable roads around Kent Ridge from the Overpass API, routes
each service stop to stop along them (one-way streets respected; each stop
may snap to any road node close to it, and the combination that makes the
whole route shortest wins, so a stop on a dual carriageway lands on the
right side), and writes probe-out/routes.geojson with a summary: per route,
its length along roads against the straight lines between its stops, and
any leg that detours suspiciously far. Also lists any bus route relations
OSM already has in the area. Map data (c) OpenStreetMap contributors, ODbL.
"""

import heapq
import json
import math
import pathlib
import time
import urllib.parse
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = pathlib.Path("probe-out")
OVERPASS = "https://overpass-api.de/api/interpreter"
# South, west, north, east: the stops' bounds (Botanic Gardens included) plus a margin.
BBOX = (1.282, 103.760, 1.330, 103.826)
DRIVABLE = "motorway|trunk|primary|secondary|tertiary|unclassified|residential|service|living_street|busway|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link|road"
SNAP_M = 60
SNAP_COST = 3.0  # each metre a stop sits off the road counts this much


MIRRORS = [OVERPASS, "https://overpass.kumi.systems/api/interpreter", "https://overpass.private.coffee/api/interpreter"]


def fetch(query: str) -> dict:
    """The public Overpass servers are often busy (504, 429): each mirror, a few times."""
    body = urllib.parse.urlencode({"data": query}).encode()
    last = None
    for attempt in range(3):
        for url in MIRRORS:
            req = urllib.request.Request(url, data=body, headers={"User-Agent": "terminus-map-probe"})
            try:
                with urllib.request.urlopen(req, timeout=180) as res:
                    return json.loads(res.read())
            except Exception as exc:  # noqa: BLE001
                last = exc
                print(f"  {url}: {exc}")
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


def main():
    OUT.mkdir(exist_ok=True)
    s, w, n, e = BBOX
    rel = fetch(f'[out:json][timeout:120];relation["route"="bus"]({s},{w},{n},{e});out tags;')
    print(f"OSM bus route relations in the area: {len(rel['elements'])}")
    for r in rel["elements"]:
        t = r.get("tags", {})
        if any("nus" in str(v).lower() or "isb" in str(v).lower() or "shuttle" in str(v).lower() for v in t.values()):
            print("  NUS-looking:", {k: t[k] for k in ("name", "ref", "operator", "network") if k in t})

    osm = fetch(f'[out:json][timeout:180];way["highway"~"^({DRIVABLE})$"]({s},{w},{n},{e});(._;>;);out body;')
    nodes, adj = build(osm)
    print(f"roads: {sum(1 for el in osm['elements'] if el['type'] == 'way')} ways, {len(adj)} routable nodes")

    graph = json.loads((ROOT / "data" / "stops.json").read_text())
    stops = {st["code"]: (st["lat"], st["lon"]) for st in graph["stops"]}
    routable = [i for i in adj]

    def candidates(pt):
        near = sorted((haversine(pt, nodes[i]), i) for i in routable if abs(nodes[i][0] - pt[0]) < 0.001 and abs(nodes[i][1] - pt[1]) < 0.001)
        within = [(i, d) for d, i in near if d <= SNAP_M][:8]
        return within or [(i, d) for d, i in near[:1]]

    features, report = [], {}
    cache = {}
    for svc, seq in graph["routes"].items():
        cands = [candidates(stops[c]) for c in seq]
        # Viterbi over the stops: the snap per stop that makes the route shortest.
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
                raise SystemExit(f"{svc}: no road path from {seq[k - 1]} to {seq[k]}")
            best.append(layer)
        end = min(best[-1], key=lambda j: best[-1][j][0])
        chosen = [end]
        for k in range(len(seq) - 1, 0, -1):
            chosen.append(best[k][chosen[-1]][1])
        chosen.reverse()
        coords, legs = [], []
        for k in range(len(seq) - 1):
            a, b = chosen[k], chosen[k + 1]
            p = path(cache[a][1], a, b) if a != b else [a]
            pts = [nodes[i] for i in p]
            road = sum(haversine(x, y) for x, y in zip(pts, pts[1:]))
            straight = haversine(stops[seq[k]], stops[seq[k + 1]])
            legs.append((seq[k], seq[k + 1], round(road), round(straight)))
            coords.extend(pts if not coords else pts[1:])
        road = sum(l[2] for l in legs)
        straight = sum(l[3] for l in legs)
        odd = [l for l in legs if l[2] > 2.5 * l[3] and l[2] - l[3] > 400]
        snaps = [round(haversine(stops[c], nodes[i])) for c, i in zip(seq, chosen)]
        report[svc] = {"road_m": road, "straight_m": straight, "ratio": round(road / max(straight, 1), 2), "max_snap_m": max(snaps), "odd_legs": odd, "points": len(coords)}
        features.append({"type": "Feature", "properties": {"svc": svc}, "geometry": {"type": "LineString", "coordinates": [[round(lon, 6), round(lat, 6)] for lat, lon in coords]}})
        print(f"{svc}: {road} m by road vs {straight} m straight (x{report[svc]['ratio']}), {len(coords)} points, max snap {max(snaps)} m, odd legs: {odd or 'none'}")

    for code, (lat, lon) in stops.items():
        features.append({"type": "Feature", "properties": {"stop": code}, "geometry": {"type": "Point", "coordinates": [lon, lat]}})
    (OUT / "routes.geojson").write_text(json.dumps({"type": "FeatureCollection", "features": features}))
    (OUT / "report.json").write_text(json.dumps(report, indent=1))
    print(f"routes.geojson: {(OUT / 'routes.geojson').stat().st_size // 1024} KB")


if __name__ == "__main__":
    main()
