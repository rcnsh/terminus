#!/usr/bin/env python3
"""
Walking distances along real paths, for data/walks.json and data/venues.json.

    python3 scripts/walk_routes.py            # uses cached downloads in dev/
    python3 scripts/walk_routes.py --fetch    # downloads them again

Sources, fetched once and cached in the gitignored dev/ folder:
  - OpenStreetMap footpaths and roads around Kent Ridge, from the Overpass API.
    Map data (c) OpenStreetMap contributors, ODbL. Only derived distances are
    committed.
  - NUSMods' room map with coordinates (venues.json in their open-source repo).

Writes:
  - data/walks.json: routed metres between every pair of stops, and per stop
    how much longer than the straight line a walk to it usually is.
  - data/venues.json: each building's walk to its stop, routed. The stop a
    building maps to is kept as it was (saved timetables point at it); only
    buildings new to the file get the stop nearest by path.
"""

import heapq
import json
import math
import statistics
import sys
import urllib.parse
import urllib.request
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REPO = ROOT.parent.parent
CACHE = REPO / "dev"
OSM_FILE = CACHE / "osm-nus-paths.json"
ROOMS_FILE = CACHE / "nusmods-venues.json"

# Kent Ridge, PGP, UTown and Kent Ridge MRT, with a margin.
BBOX = (1.2830, 103.7630, 1.3120, 103.7900)  # south, west, north, east
OVERPASS = "https://overpass-api.de/api/interpreter"
# The room map NUSMods itself uses: coordinates per room, from their open-source repo.
NUSMODS = "https://raw.githubusercontent.com/nusmodifications/nusmods/master/website/src/data/venues.json"

WALKABLE = "footway|path|pedestrian|steps|corridor|living_street|residential|service|unclassified|tertiary|secondary|primary|cycleway|track|crossing"
# Stairs take longer than their length suggests.
STEPS_FACTOR = 1.6
# A stop or building further than this from any path is not on the map.
SNAP_MAX_M = 120
# Stops and buildings join the network at every path node this close. Mapped
# footpaths often stop short of the road or the door: with a single nearest
# node, a stop 76 m from the library routed as 294 m.
ENTRY_M = 40


def haversine(a, b):
    lat1, lon1 = a
    lat2, lon2 = b
    r = 6_371_000
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    s = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(min(1, math.sqrt(s)))


def fetch(url, data=None):
    req = urllib.request.Request(url, data=data, headers={"user-agent": "terminus walk_routes.py (student project)"})
    with urllib.request.urlopen(req, timeout=180) as r:
        return r.read()


def download():
    CACHE.mkdir(exist_ok=True)
    s, w, n, e = BBOX
    query = f"""
[out:json][timeout:120];
way["highway"~"^({WALKABLE})$"]["foot"!="no"]["access"!="no"]({s},{w},{n},{e});
(._;>;);
out body;
"""
    OSM_FILE.write_bytes(fetch(OVERPASS, urllib.parse.urlencode({"data": query}).encode()))
    ROOMS_FILE.write_bytes(fetch(NUSMODS))
    print(f"downloaded {OSM_FILE.stat().st_size // 1024} KB of paths, {ROOMS_FILE.stat().st_size // 1024} KB of rooms")


def build_graph(osm):
    nodes = {el["id"]: (el["lat"], el["lon"]) for el in osm["elements"] if el["type"] == "node"}
    adj = {}
    for el in osm["elements"]:
        if el["type"] != "way":
            continue
        factor = STEPS_FACTOR if el.get("tags", {}).get("highway") == "steps" else 1.0
        ids = [i for i in el["nodes"] if i in nodes]
        for a, b in zip(ids, ids[1:]):
            d = haversine(nodes[a], nodes[b]) * factor
            adj.setdefault(a, []).append((b, d))
            adj.setdefault(b, []).append((a, d))
    return nodes, adj


class Snapper:
    """Nearest path node, via a coarse grid."""

    def __init__(self, nodes, adj):
        self.nodes = nodes
        self.grid = {}
        for i in adj:
            lat, lon = nodes[i]
            self.grid.setdefault((round(lat * 500), round(lon * 500)), []).append(i)

    def near(self, pt):
        """Every path node within ENTRY_M, with its straight-line distance; the
        nearest one alone when none is that close (up to SNAP_MAX_M)."""
        gy, gx = round(pt[0] * 500), round(pt[1] * 500)
        found = []
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                for i in self.grid.get((gy + dy, gx + dx), ()):
                    d = haversine(pt, self.nodes[i])
                    if d <= SNAP_MAX_M:
                        found.append((d, i))
        found.sort()
        close = [(i, d) for d, i in found if d <= ENTRY_M]
        return close or [(i, d) for d, i in found[:1]]


def dijkstra(adj, sources):
    """Shortest distances from several entry nodes, each with its own start cost."""
    dist = {}
    heap = []
    for node, cost in sources:
        if cost < dist.get(node, float("inf")):
            dist[node] = cost
            heap.append((cost, node))
    heapq.heapify(heap)
    while heap:
        d, u = heapq.heappop(heap)
        if d > dist.get(u, float("inf")):
            continue
        for v, w in adj.get(u, ()):
            nd = d + w
            if nd < dist.get(v, float("inf")):
                dist[v] = nd
                heapq.heappush(heap, (nd, v))
    return dist


def buildings(rooms):
    """Room coordinates averaged per building code (the part before '-')."""
    acc = {}
    for room, info in rooms.items():
        loc = (info or {}).get("location") or {}
        x, y = loc.get("x"), loc.get("y")
        if not isinstance(x, (int, float)) or not isinstance(y, (int, float)):
            continue
        acc.setdefault(room.split("-")[0].upper(), []).append((y, x))
    return {b: (statistics.fmean(p[0] for p in pts), statistics.fmean(p[1] for p in pts)) for b, pts in acc.items()}


def main():
    if "--fetch" in sys.argv or not OSM_FILE.exists() or not ROOMS_FILE.exists():
        download()
    osm = json.loads(OSM_FILE.read_text())
    rooms = json.loads(ROOMS_FILE.read_text())
    stops = json.loads((ROOT / "data/stops.json").read_text())["stops"]
    venues_doc = json.loads((ROOT / "data/venues.json").read_text())
    venues = venues_doc["venues"]

    nodes, adj = build_graph(osm)
    snapper = Snapper(nodes, adj)
    print(f"{len(adj)} path nodes")

    stop_pt = {s["code"]: (s["lat"], s["lon"]) for s in stops}
    trees = {}
    for code, pt in stop_pt.items():
        entries = snapper.near(pt)
        if not entries:
            print(f"  {code}: not near a mapped path, straight line only")
            continue
        trees[code] = dijkstra(adj, entries)

    def routed(code, pt):
        """Metres on foot from a point to a stop, or None off the map. Never
        shorter than the straight line."""
        if code not in trees:
            return None
        tree = trees[code]
        best = min((tree[i] + off for i, off in snapper.near(pt) if i in tree), default=None)
        return None if best is None else max(best, haversine(pt, stop_pt[code]))

    # Stop to stop.
    pairs = {}
    for a in stop_pt:
        for b in stop_pt:
            if a == b:
                continue
            m = routed(b, stop_pt[a])
            if m is not None:
                pairs[f"{a}>{b}"] = round(m)

    # Buildings: routed walk to their stop; a detour ratio sample per stop.
    coords = buildings(rooms)
    ratios = {}
    suspect = []
    updated = added = 0
    for code, pt in coords.items():
        if code in venues:
            stop = venues[code]["stop"]
        elif not code[:1].isalpha() or len(code) < 3:
            # Bare room numbers ("1001") are not building codes, and a one- or
            # two-letter code ("E") would catch other rooms: venueToStop drops
            # trailing digits, so "E9" would fall back to it.
            continue
        else:
            # New building: the stop nearest by path.
            options = [(routed(s, pt), s) for s in stop_pt]
            options = [(m, s) for m, s in options if m is not None]
            if not options:
                continue
            _, stop = min(options)
        m = routed(stop, pt)
        if m is None:
            continue
        straight = haversine(pt, stop_pt[stop])
        old = venues.get(code, {}).get("m")
        # The old figure was a straight line from NUS's own building position.
        # A routed walk more than twice that means NUSMods puts this code
        # somewhere else (same code, different building), not a real detour.
        if old is not None and old > 40 and m > 2 * old:
            suspect.append(f"{code} {old}->{round(m)}")
            continue
        if straight > 40:
            ratios.setdefault(stop, []).append(m / straight)
        if code in venues:
            venues[code]["m"] = round(m)
            updated += 1
        else:
            venues[code] = {"stop": stop, "m": round(m)}
            added += 1

    if suspect:
        print(f"kept {len(suspect)} straight-line figures that routed implausibly long: {', '.join(suspect)}")
    # Buildings the map couldn't route (or that looked wrong) keep their old
    # straight-line figure. Per stop, the usual detour for walks from anywhere.
    all_ratios = [r for rs in ratios.values() for r in rs]
    overall = statistics.median(all_ratios) if all_ratios else 1.0
    clamp = lambda r: round(min(2.0, max(1.0, r)), 3)
    detour = {code: clamp(statistics.median(ratios[code]) if len(ratios.get(code, [])) >= 3 else overall) for code in stop_pt}

    (ROOT / "data/walks.json").write_text(json.dumps({
        "generated": date.today().isoformat(),
        "source": "OpenStreetMap footpaths (Map data (c) OpenStreetMap contributors, ODbL) via Overpass; scripts/walk_routes.py",
        "detour": detour,
        "stopPairs": pairs,
    }, indent=1, sort_keys=True) + "\n")
    venues_doc["venues"] = dict(sorted(venues.items()))
    venues_doc["generated"] = date.today().isoformat()
    venues_doc["source"] = "uNivUS building->stop assignments; walks routed on OpenStreetMap paths (scripts/walk_routes.py); new buildings from the NUSMods room map"
    # One line, as the file has always been: it is data, not something to read.
    (ROOT / "data/venues.json").write_text(json.dumps(venues_doc, separators=(",", ":"), ensure_ascii=False))
    print(f"{len(pairs)} stop pairs, {updated} buildings re-routed, {added} added, median detour {overall:.2f}")


if __name__ == "__main__":
    main()
