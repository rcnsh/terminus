#!/usr/bin/env python3
"""
Scrape the static NUS ISB stop graph into data/stops.json.

Stop locations, route order and operating hours change a few times a year, not
a few times a minute, so this runs weekly in CI and the result is bundled into
the Worker. Fetching it per request would add latency and an upstream
dependency to every tile tap.

The `routes` ordering is what makes direction resolution work. It is the part
to get right; everything else in this file is bookkeeping.

Reads config from the environment, falling back to .dev.vars. Never prints or
commits any credential value.

    python3 scripts/scrape_stops.py [--out data/stops.json] [--dry-run]
"""

from __future__ import annotations

import argparse
import json
import os
import pathlib
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

ROOT = pathlib.Path(__file__).resolve().parents[1]

REQUIRED = [
    "NEXTBUS_AUTH_BASE",
    "NEXTBUS_FMS_BASE",
    "NEXTBUS_HTD_API",
    "NEXTBUS_APP_API",
    "NEXTBUS_FMS_TENANT_CODE",
]

# Mirrors DEFAULT_AUTH_PATH in src/auth.ts. Confirm from your proxy capture.
DEFAULT_AUTH_PATH = "/api/v1/auth/access_token"

WRAPPER_KEYS = (
    "ShuttleServiceResult",
    "BusStopsResult",
    "PickupPointResult",
    "ServiceDescriptionResult",
    "result",
    "Result",
    "data",
    "Data",
    "response",
)


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
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if value and not os.environ.get(key):
            os.environ[key] = value


def unwrap(node):
    for _ in range(8):
        if not isinstance(node, dict):
            return node
        key = next((k for k in WRAPPER_KEYS if k in node), None)
        if key is None:
            return node
        node = node[key]
    return node


def pick_list(node, *keys):
    root = unwrap(node)
    if isinstance(root, list):
        return root
    if not isinstance(root, dict):
        return []
    for k in keys:
        v = unwrap(root.get(k))
        if isinstance(v, list):
            return v
    for v in root.values():
        u = unwrap(v)
        if isinstance(u, list):
            return u
    return []


def first(d: dict, *keys, default=None):
    for k in keys:
        if k in d and d[k] not in (None, ""):
            return d[k]
    return default


def app_headers() -> dict:
    h = {
        "X-HTD-API": os.environ["NEXTBUS_HTD_API"],
        "X-APP-API": os.environ["NEXTBUS_APP_API"],
        "Accept": "application/json",
    }
    version = os.environ.get("NEXTBUS_APP_VERSION")
    if version:
        h["X-APP-VERSION"] = version
        h["appversion"] = version
    for env_key, header in (
        ("NEXTBUS_REQUESTED_BY", "X-Requested-By"),
        ("NEXTBUS_SECURED_REQUEST", "X-Secured-Request"),
    ):
        if os.environ.get(env_key):
            h[header] = os.environ[env_key]
    return h


def request(url: str, headers: dict, method: str = "GET"):
    req = urllib.request.Request(url, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            return json.loads(res.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        # Do not print the URL: it carries the service id.
        raise SystemExit(f"{method} {urllib.parse.urlsplit(url).path} -> HTTP {exc.code}") from exc
    except urllib.error.URLError as exc:
        raise SystemExit(
            f"{method} {urllib.parse.urlsplit(url).path} -> unreachable ({exc.reason}).\n"
            "If this is a timeout, run the off-campus curl test in the README first: "
            "the FMS endpoints may be restricted to the NUS network."
        ) from exc


def find_token(node, depth=0):
    if not isinstance(node, dict) or depth > 4:
        return None
    for k in ("access_token", "accessToken", "token", "jwt", "id_token"):
        v = node.get(k)
        if isinstance(v, str) and len(v) > 8:
            return v
    for v in node.values():
        found = find_token(v, depth + 1)
        if found:
            return found
    return None


def get_token() -> str:
    base = os.environ["NEXTBUS_AUTH_BASE"].rstrip("/")
    parsed = urllib.parse.urlsplit(base)
    url = base if parsed.path not in ("", "/") else base + DEFAULT_AUTH_PATH
    token = find_token(request(url, app_headers(), method="POST"))
    if not token:
        raise SystemExit("auth response contained no token")
    return token


def fms(path: str, token: str, **params) -> dict:
    base = os.environ["NEXTBUS_FMS_BASE"].rstrip("/")
    query = {k: v for k, v in params.items() if v}
    url = f"{base}/{path}"
    if query:
        url += "?" + urllib.parse.urlencode(query)
    headers = app_headers()
    headers["Authorization"] = f"Bearer {token}"
    headers["X-Tenant-Code"] = os.environ["NEXTBUS_FMS_TENANT_CODE"]
    return request(url, headers)


def norm_code(v) -> str:
    """Real codes look like COM3, UHALL-OPP, KR-MRT. Hyphens are significant."""
    return re.sub(r"\s+", "", str(v)).upper()


def stop_of_berth(berth: str, route: str) -> str:
    """
    PickupPoint delivers BERTH codes, not stop codes. At a terminus the same
    physical stop appears twice with a route suffix: COM3-D2-S is the run
    starting there and COM3-D2-E the run ending there (route P starts at a
    bare KV and ends at KV-P-E, so only the end suffix is guaranteed).

    The suffix is what makes direction resolvable, so it is preserved in
    `berths` and stripped here only to build the stop-code sequence.
    """
    for suffix in (f"-{route}-S", f"-{route}-E"):
        if berth.endswith(suffix):
            return berth[: -len(suffix)]
    return berth


def opposite_of(stop: dict, by_name: dict, codes: set) -> str | None:
    """
    NUS stops come in directional pairs. Confirmed from real data, they pair
    two ways at once: codes as 'UHALL' / 'UHALL-OPP', captions as
    'University Hall' / 'Opp University Hall'. The code suffix is the stronger
    signal, so try it first and fall back to the caption.
    """
    code = stop["code"]
    twin_code = code[:-4] if code.endswith("-OPP") else f"{code}-OPP"
    if twin_code in codes:
        return twin_code

    clean = stop["name"].strip()
    low = clean.lower()
    if low.startswith("opp "):
        twin = clean[4:].strip()
    elif low.startswith("opposite "):
        twin = clean[9:].strip()
    else:
        twin = f"Opp {clean}"
    return by_name.get(twin.lower())


TIME_RE = re.compile(r"\b([0-2]?\d)[:.]([0-5]\d)\b")


def parse_window(value):
    """Pull an [open, close] pair out of whatever free text the feed carries."""
    if not value:
        return None
    found = TIME_RE.findall(str(value))
    if len(found) < 2:
        return None
    return [f"{int(h):02d}:{m}" for h, m in found[:2]]


def scrape(tenant: str, token: str) -> dict:
    raw_stops = pick_list(fms("BusStops", token, tenant_code=tenant), "BusStops", "busstops", "stops")
    if not raw_stops:
        raise SystemExit("BusStops returned nothing -- check the tenant code and the endpoint path")

    stops = []
    for s in raw_stops:
        if not isinstance(s, dict):
            continue
        # Confirmed shape: {"name": "COM3", "caption": "COM 3",
        #  "ShortName": "COM 3", "latitude": ..., "longitude": ...}
        # `name` is the CODE and `caption` is the human label -- not the other
        # way round. ShortName is already abbreviated the way a tile wants
        # ("Opp KR MRT"), so it is the display name.
        code = norm_code(first(s, "name", "busstopcode", "code", "BusStopCode", default=""))
        short = str(first(s, "ShortName", "shortname", "caption", default="")).strip()
        long_name = str(first(s, "caption", "LongName", "longname", "description", default="")).strip()
        lat = first(s, "latitude", "lat", "Latitude")
        lon = first(s, "longitude", "lng", "lon", "Longitude")
        if not code or lat is None or lon is None:
            continue
        stops.append({
            "code": code,
            "name": short or long_name or code,
            "longName": long_name or short or code,
            "lat": float(lat),
            "lon": float(lon),
            "opposite": None,
        })

    by_name = {s["name"].lower(): s["code"] for s in stops}
    all_codes = {s["code"] for s in stops}
    for s in stops:
        s["opposite"] = opposite_of(s, by_name, all_codes)

    raw_services = pick_list(
        fms("ServiceDescription", token, tenant_code=tenant),
        "ServiceDescription",
        "services",
    )
    services = []
    hours = {}
    for entry in raw_services:
        if not isinstance(entry, dict):
            continue
        svc = str(first(entry, "Route", "route", "name", "ServiceName", default="")).strip()
        if not svc:
            continue
        services.append(svc)
        window = parse_window(
            first(entry, "OperatingHours", "operatinghours", "RouteMessage", "Description", "remark")
        )
        if window:
            hours[svc] = {"weekday": window, "saturday": window, "sunday": None}

    routes = {}
    berths = {}
    loops = {}
    for svc in services:
        points = pick_list(
            fms("PickupPoint", token, route_code=svc, tenant_code=tenant),
            "pickuppoint",
            "PickupPoint",
            "pickuppoints",
            "points",
        )
        seq = []
        for p in points:
            if not isinstance(p, dict):
                continue
            berth = norm_code(first(p, "busstopcode", "pickuppointname", "name", "code", default=""))
            if berth:
                seq.append((first(p, "seq", "sequence", "order", "id", default=len(seq)), berth))
        # seq is NOT a dense index. The last stop of a route is delivered with
        # seq 32767 -- an int16 sentinel -- so sort numerically and never
        # assume 1..N.
        try:
            seq.sort(key=lambda kv: float(kv[0]))
        except (TypeError, ValueError):
            pass
        ordered_berths = [b for _, b in seq]
        if not ordered_berths:
            print(f"warning: {svc} returned no pickup points; skipping", file=sys.stderr)
            continue
        ordered = [stop_of_berth(b, svc) for b in ordered_berths]
        loops[svc] = len(ordered) > 2 and ordered[0] == ordered[-1]
        routes[svc] = ordered
        berths[svc] = ordered_berths

    known = {s["code"] for s in stops}
    orphans = sorted({c for seq in routes.values() for c in seq} - known)
    if orphans:
        print(f"warning: {len(orphans)} route codes are not in BusStops: {orphans[:10]}", file=sys.stderr)

    missing_hours = [s for s in routes if s not in hours]
    if missing_hours:
        print(
            f"warning: no operating hours parsed for {missing_hours}. "
            "Fill them in data/service-hours.json -- this file does not own them.",
            file=sys.stderr,
        )

    return {
        "generated": datetime.now(timezone.utc).isoformat(),
        "source": "ConnectX FMS via scripts/scrape_stops.py",
        "stops": sorted(stops, key=lambda s: s["code"]),
        "routes": routes,
        "berths": berths,
        "loops": loops,
        # Anything parsed out of ServiceDescription, which in practice is
        # nothing. Hand-maintained hours live in data/service-hours.json and
        # are merged over this at load time, so re-scraping never loses them.
        "serviceHours": hours,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(ROOT / "data" / "stops.json"))
    ap.add_argument("--dry-run", action="store_true", help="print a summary, write nothing")
    args = ap.parse_args()

    load_dev_vars()
    missing = [k for k in REQUIRED if not os.environ.get(k)]
    if missing:
        print(f"missing config: {', '.join(missing)} (see .dev.vars.example)", file=sys.stderr)
        return 2

    graph = scrape(os.environ["NEXTBUS_FMS_TENANT_CODE"], get_token())
    print(
        f"{len(graph['stops'])} stops, {len(graph['routes'])} services: "
        + ", ".join(f"{k}({len(v)})" for k, v in sorted(graph["routes"].items()))
    )
    if args.dry_run:
        return 0

    out = pathlib.Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(graph, indent=2, ensure_ascii=False) + "\n")
    print(f"wrote {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
