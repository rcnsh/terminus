#!/usr/bin/env python3
"""
Walking distances along real paths, for data/walks.json and data/venues.json.

    python3 scripts/walk_routes.py            # uses cached downloads in dev/
    python3 scripts/walk_routes.py --fetch    # downloads them again
    python3 scripts/walk_routes.py --check    # writes nothing; fails if data/ is stale

Run it after stops.json changes (a stop added or renamed): walks, rooms,
landmarks and residences all refer to stop codes.

Sources, fetched once and cached in the gitignored dev/ folder:
  - OpenStreetMap footpaths and roads around Kent Ridge, from the Overpass API.
    Map data (c) OpenStreetMap contributors, ODbL. Only derived distances are
    committed.
  - NUSMods' room map with coordinates (venues.json in their open-source repo).
  - OpenStreetMap outlines of the residences listed in data/src/residences.json.

Hand-maintained inputs, never written by this script (data/src/):
  - venues-base.json: which stop each building maps to (uNivUS's table, plus
    buildings added over time). Edit this, not data/venues.json.
  - landmarks.json, residences.json: food courts and halls, as named by students.

Writes:
  - data/walks.json: routed metres between every pair of stops, and per stop
    how much longer than the straight line a walk to it usually is.
  - data/landmarks.json: named places (food courts) served by more than one
    stop, with the routed walk from each.
  - data/rooms.json: NUSMods' rooms with their names, stop and routed walk,
    for the destination search.
  - data/residences.json: each residence's outline and the stops that serve it.
  - data/venues.json: each building's walk to its stop, routed. The stop a
    building maps to is kept as it was (saved timetables point at it); only
    buildings new to the file get the stop nearest by path.
"""

import heapq
import json
import math
import statistics
import sys
import urllib.error
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

# Places people name that are not buildings or rooms, with every stop that
# serves them (the router takes whichever is quicker). Positions from
# OpenStreetMap; stops confirmed by a student who uses them.
# Hand-maintained lists live in data/src, apart from what this script writes.
LANDMARKS = {k: {**v, "at": tuple(v["at"])} for k, v in json.loads((ROOT / "data/src/landmarks.json").read_text())["landmarks"].items()}

# On-campus residences, as OpenStreetMap outlines (way ids), grouped the way
# students name them. Used to tell that someone is already home; the stops
# that serve each are worked out by path distance below.
RESIDENCES = json.loads((ROOT / "data/src/residences.json").read_text())["residences"]
RES_FILE = CACHE / "osm-residences.json"

WALKABLE = "footway|path|pedestrian|steps|corridor|living_street|residential|service|unclassified|tertiary|secondary|primary|cycleway|track|crossing"
# Stairs take longer than their length suggests.
STEPS_FACTOR = 1.6
# A stop or building further than this from any path is not on the map.
SNAP_MAX_M = 120
# Stops and buildings join the network at every path node this close. Mapped
# footpaths often stop short of the road or the door: with a single nearest
# node, a stop 76 m from the library routed as 294 m.
ENTRY_M = 40


CHECK = "--check" in sys.argv
_differs = []


def emit(name, text):
    """Write a data file, or with --check, only compare it (ignoring the date)."""
    path = ROOT / "data" / name
    if not CHECK:
        path.write_text(text)
        return
    strip = lambda t: "\n".join(l for l in t.replace('","', '",\n"').splitlines() if '"generated"' not in l)
    old = path.read_text() if path.exists() else ""
    if strip(json.dumps(json.loads(old), sort_keys=True, indent=0)) != strip(json.dumps(json.loads(text), sort_keys=True, indent=0)):
        _differs.append(name)


def haversine(a, b):
    lat1, lon1 = a
    lat2, lon2 = b
    r = 6_371_000
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    s = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(min(1, math.sqrt(s)))


# The footpaths around Kent Ridge are a few MB from Overpass, NUSMods' rooms
# about one: a reply this big is not what was asked for.
MAX_BYTES = 100_000_000


class HttpsRedirects(urllib.request.HTTPRedirectHandler):
    """Follows a redirect only to https: what comes back is committed."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if urllib.parse.urlsplit(newurl).scheme != "https":
            raise urllib.error.HTTPError(req.full_url, code, "redirect to plain http refused", headers, fp)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


OPENER = urllib.request.build_opener(HttpsRedirects)


def fetch(url, data=None):
    req = urllib.request.Request(url, data=data, headers={"user-agent": "terminus walk_routes.py (student project)"})
    with OPENER.open(req, timeout=180) as r:
        raw = r.read(MAX_BYTES + 1)
    if len(raw) > MAX_BYTES:
        raise SystemExit(f"{urllib.parse.urlsplit(url).netloc} sent more than {MAX_BYTES} bytes")
    return raw


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
    ids = ",".join(str(w) for r in RESIDENCES.values() for w in r["ways"])
    RES_FILE.write_bytes(fetch(OVERPASS, urllib.parse.urlencode({"data": f"[out:json][timeout:60];way(id:{ids});out geom;"}).encode()))
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
    if "--fetch" in sys.argv or not OSM_FILE.exists() or not ROOMS_FILE.exists() or not RES_FILE.exists():
        download()
    osm = json.loads(OSM_FILE.read_text())
    rooms = json.loads(ROOMS_FILE.read_text())
    stops = json.loads((ROOT / "data/stops.json").read_text())["stops"]
    # The building -> stop table is an input of its own (data/src), so a run
    # never reads back what an earlier run wrote.
    venues_doc = json.loads((ROOT / "data/src/venues-base.json").read_text())
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
        # Where the building is (its rooms' mean point, 5 dp is about a
        # metre), so the API can tell you're at it, not only at its stop.
        at = {"lat": round(pt[0], 5), "lon": round(pt[1], 5)}
        if code in venues:
            venues[code].update(m=round(m), **at)
            updated += 1
        else:
            venues[code] = {"stop": stop, "m": round(m), **at}
            added += 1

    if suspect:
        print(f"kept {len(suspect)} straight-line figures that routed implausibly long: {', '.join(suspect)}")
    # Buildings the map couldn't route (or that looked wrong) keep their old
    # straight-line figure. Per stop, the usual detour for walks from anywhere.
    all_ratios = [r for rs in ratios.values() for r in rs]
    overall = statistics.median(all_ratios) if all_ratios else 1.0
    clamp = lambda r: round(min(2.0, max(1.0, r)), 3)
    detour = {code: clamp(statistics.median(ratios[code]) if len(ratios.get(code, [])) >= 3 else overall) for code in stop_pt}

    emit("walks.json", json.dumps({
        "generated": date.today().isoformat(),
        "source": "OpenStreetMap footpaths (Map data (c) OpenStreetMap contributors, ODbL) via Overpass; scripts/walk_routes.py",
        "detour": detour,
        "stopPairs": pairs,
    }, indent=1, sort_keys=True) + "\n")
    # Named rooms, for the destination search: each resolves the way an
    # import does (its building's stop), and walks from the room itself.
    def building_of(room):
        r = room.upper()
        if r in venues:
            return r
        b = r.split("-")[0]
        if b in venues:
            return b
        stripped = b.rstrip("0123456789")
        return stripped if stripped and stripped in venues else None

    named = {}
    for room, info in rooms.items():
        b = building_of(room)
        loc = (info or {}).get("location") or {}
        if not b or not isinstance(loc.get("x"), (int, float)):
            continue
        stop = venues[b]["stop"]
        pt = (loc["y"], loc["x"])
        m = routed(stop, pt)
        # Same guard as buildings: a room far past its building's walk is
        # misplaced, so its position is not kept either.
        at = {"lat": round(pt[0], 5), "lon": round(pt[1], 5)}
        if m is None or m > 2 * max(venues[b]["m"], 60):
            m = venues[b]["m"]
            at = {}
        name = " ".join(str(info.get("roomName") or "").split())
        named[room] = {"name": name if name and name.upper() != room.upper() else "", "stop": stop, "m": round(m), **at}
    emit("rooms.json", json.dumps({
        "generated": date.today().isoformat(),
        "source": "NUSMods room map (names, positions); stops as for imports; walks routed on OpenStreetMap paths",
        "rooms": dict(sorted(named.items())),
    }, separators=(",", ":"), ensure_ascii=False))
    print(f"{len(named)} named rooms for search")

    marks = {}
    for code, lm in LANDMARKS.items():
        walks = {}
        for stop in lm["stops"]:
            m = routed(stop, lm["at"])
            walks[stop] = round(m if m is not None else haversine(lm["at"], stop_pt[stop]))
        marks[code] = {"name": lm["name"], "kind": lm["kind"], "aliases": lm["aliases"], "stops": walks}
    emit("landmarks.json", json.dumps({
        "generated": date.today().isoformat(),
        "source": "positions from OpenStreetMap (ODbL); walks routed on its paths; scripts/walk_routes.py",
        "landmarks": marks,
    }, indent=1) + "\n")
    print("landmarks:", {c: m["stops"] for c, m in marks.items()})

    # Residences: outline(s), and the stops that serve each (the nearest by
    # path, plus any other within 150 m of it, at most two).
    if RES_FILE.exists():
        ways = {e["id"]: e for e in json.loads(RES_FILE.read_text())["elements"] if e["type"] == "way"}
        res = {}
        for code, r in RESIDENCES.items():
            areas = [[[round(p["lat"], 5), round(p["lon"], 5)] for p in ways[w]["geometry"]] for w in r["ways"] if w in ways]
            if not areas:
                print(f"  {code}: no outline")
                continue
            pts = [pt for a in areas for pt in a]
            centre = (statistics.fmean(p[0] for p in pts), statistics.fmean(p[1] for p in pts))
            walks = sorted((m, c) for c in stop_pt if (m := routed(c, centre)) is not None)
            best = walks[0][0]
            serving = {c: round(m) for m, c in walks if m <= best + 150}
            serving = dict(list(serving.items())[:2])
            res[code] = {"name": r["name"], **({"common": True} if r.get("common") else {}), "stops": serving, "areas": areas}
        emit("residences.json", json.dumps({
            "generated": date.today().isoformat(),
            "source": "outlines from OpenStreetMap (ODbL); serving stops by path distance; scripts/walk_routes.py",
            "residences": res,
        }, separators=(",", ":")) + "\n")
        print("residences:", {c: r["stops"] for c, r in res.items()})

    venues_doc["venues"] = dict(sorted(venues.items()))
    venues_doc["generated"] = date.today().isoformat()
    venues_doc["source"] = "uNivUS building->stop assignments; walks routed on OpenStreetMap paths (scripts/walk_routes.py); new buildings from the NUSMods room map"
    # One line, as the file has always been: it is data, not something to read.
    emit("venues.json", json.dumps(venues_doc, separators=(",", ":"), ensure_ascii=False))
    print(f"{len(pairs)} stop pairs, {updated} buildings re-routed, {added} added, median detour {overall:.2f}")
    if CHECK:
        if _differs:
            print("out of date:", ", ".join(_differs))
            sys.exit(1)
        print("data files match a fresh build")


if __name__ == "__main__":
    main()
