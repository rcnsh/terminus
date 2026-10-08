#!/usr/bin/env python3
"""
Scrape the static NUS ISB stop graph into data/stops.json.

Stop locations, route order and operating hours change a few times a year, not
a few times a minute, so this runs weekly in CI and the result is bundled into
the Worker. Fetching it per request would add latency and an upstream
dependency to every answer.

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
import secrets
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

ROOT = pathlib.Path(__file__).resolve().parents[1]

REQUIRED = [
    "NEXTBUS_AUTH_BASE",
    "NEXTBUS_HTD_API",
    "NEXTBUS_APP_API",
    "NEXTBUS_APP_VERSION",
    "NEXTBUS_PROXY_BASE",
    "NEXTBUS_PROXY_API_KEY",
]

# Mirrors src/auth.ts.
AUTH_PATH = "/get-access-token"
# The feed's replies are a few KB; anything near this is not the feed.
MAX_BYTES = 5_000_000

# ServiceDescription is not exposed on the bus proxy, so there is no call that
# lists the services. Route codes come from the current graph plus this list;
# a code that returns no pickup points is skipped, so extras cost one request.
KNOWN_ROUTES = ["A1", "A2", "D1", "D2", "K", "P", "R1", "R2", "E", "L", "BTC1", "BTC2"]

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
    # No X-Forwarded-Proto: it makes the NUS load balancer intermittently
    # answer 400 "Contradictory scheme headers". See src/auth.ts.
    h = {
        "X-HTD-API": os.environ["NEXTBUS_HTD_API"],
        "X-APP-API": os.environ["NEXTBUS_APP_API"],
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    for env_key, header in (
        ("NEXTBUS_REQUESTED_BY", "X-Requested-By"),
        ("NEXTBUS_SECURED_REQUEST", "X-Secured-Request"),
    ):
        if os.environ.get(env_key):
            h[header] = os.environ[env_key]
    return h


class NoRedirects(urllib.request.HTTPRedirectHandler):
    """urllib sends every header again to wherever a redirect points, http
    included, and these carry the feed's keys and token. The feed never
    redirects, so a redirect is refused rather than followed."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise urllib.error.HTTPError(req.full_url, code, "redirect refused", headers, fp)


OPENER = urllib.request.build_opener(NoRedirects)


def post_json(url: str, headers: dict, body: dict) -> dict:
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    path = urllib.parse.urlsplit(url).path
    try:
        with OPENER.open(req, timeout=30) as res:
            raw = res.read(MAX_BYTES + 1)
    except urllib.error.HTTPError as exc:
        # Only the status: the redirect's target or the base URL may be private.
        refused = " (redirect refused)" if 300 <= exc.code < 400 else ""
        raise SystemExit(f"POST {path} -> HTTP {exc.code}{refused}") from exc
    except urllib.error.URLError as exc:
        raise SystemExit(f"POST {path} -> unreachable ({exc.reason})") from exc
    if len(raw) > MAX_BYTES:
        raise SystemExit(f"POST {path} -> more than {MAX_BYTES} bytes; not the feed's usual reply")
    return json.loads(raw.decode("utf-8"))


def device_id() -> str:
    """One id for the whole run. The proxy rejects a call whose deviceid differs
    from the one the token was minted with, so mint and calls must agree."""
    return os.environ.get("NEXTBUS_DEVICE_ID") or secrets.token_hex(8)


def get_session() -> dict:
    """Mint the PUBLIC guest JWT, exactly as src/auth.ts does."""
    base = os.environ["NEXTBUS_AUTH_BASE"].rstrip("/")
    url = base if base.endswith(AUTH_PATH) else base + AUTH_PATH
    dev = device_id()
    body = post_json(url, app_headers(), {
        "deviceid": dev,
        "ipaddr": "127.0.0.1",
        "version": os.environ["NEXTBUS_APP_VERSION"],
    })
    data = body.get("data") or {}
    if body.get("code") != "00000" or not data.get("token"):
        raise SystemExit(f"token mint rejected: code={body.get('code')} msg={body.get('msg')}")
    return {
        "token": data["token"],
        "userid": data.get("userid", ""),
        "domain": data.get("domain", "PUBLIC"),
        "deviceid": dev,
    }


def proxy(session: dict, endpoint: str, **extra) -> dict:
    """POST to the uNivUS bus proxy and return its `data`. Failure is reported
    at HTTP 200 with a non-"00000" code, so the code is what gets checked."""
    url = os.environ["NEXTBUS_PROXY_BASE"].rstrip("/") + "/" + endpoint
    headers = {
        "x-api-key": os.environ["NEXTBUS_PROXY_API_KEY"],
        "Authorization": f"Bearer {session['token']}",
        "Content-Type": "application/json; charset=utf-8",
        "User-Agent": "Dart/3.5 (dart:io)",
        "Accept": "application/json",
    }
    body = post_json(url, headers, {
        "token": session["token"],
        "userid": session["userid"],
        "domain": session["domain"],
        "deviceid": session["deviceid"],
        "ipaddr": "127.0.0.1",
        "version": os.environ["NEXTBUS_APP_VERSION"],
        **extra,
    })
    if body.get("code") != "00000":
        raise SystemExit(f"{endpoint} rejected: code={body.get('code')} msg={body.get('msg')}")
    return body.get("data") or {}


def route_candidates(out_path: pathlib.Path) -> list:
    existing = []
    if out_path.exists():
        try:
            existing = list(json.loads(out_path.read_text()).get("routes", {}))
        except (ValueError, OSError):
            existing = []
    return list(dict.fromkeys([*existing, *KNOWN_ROUTES]))


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


def scrape(session: dict, route_codes: list) -> dict:
    raw_stops = pick_list(proxy(session, "bus-stops"), "busstops", "BusStops", "stops")
    if not raw_stops:
        raise SystemExit("bus-stops returned nothing")

    stops = []
    for s in raw_stops:
        if not isinstance(s, dict):
            continue
        # Confirmed shape: {"name": "COM3", "caption": "COM 3",
        #  "ShortName": "COM 3", "latitude": ..., "longitude": ...}
        # `name` is the CODE and `caption` is the human label -- not the other
        # way round. ShortName is already abbreviated the way a widget wants
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

    hours = {}

    routes = {}
    berths = {}
    loops = {}
    for svc in route_codes:
        points = pick_list(
            proxy(session, "pickup-point", route_code=svc),
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
            # Expected for speculative codes in KNOWN_ROUTES.
            continue
        ordered = [stop_of_berth(b, svc) for b in ordered_berths]
        loops[svc] = len(ordered) > 2 and ordered[0] == ordered[-1]
        routes[svc] = ordered
        berths[svc] = ordered_berths

    known = {s["code"] for s in stops}
    orphans = sorted({c for seq in routes.values() for c in seq} - known)
    if orphans:
        print(f"warning: {len(orphans)} route codes are not in BusStops: {orphans[:10]}", file=sys.stderr)


    return {
        "generated": datetime.now(timezone.utc).isoformat(),
        "source": "uNivUS bus proxy via scripts/scrape_stops.py",
        "stops": sorted(stops, key=lambda s: s["code"]),
        "routes": routes,
        "berths": berths,
        "loops": loops,
        # The proxy publishes no hours. They are hand-maintained in
        # data/service-hours.json and merged over this at load time.
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

    graph = scrape(get_session(), route_candidates(pathlib.Path(args.out)))
    print(
        f"{len(graph['stops'])} stops, {len(graph['routes'])} services: "
        + ", ".join(f"{k}({len(v)})" for k, v in sorted(graph["routes"].items()))
    )
    if args.dry_run:
        return 0

    out = pathlib.Path(args.out)
    # `generated` differs on every run, so comparing whole files would make the
    # weekly workflow commit a timestamp-only "refresh" every time. Only write
    # when something other than the timestamp actually changed.
    if out.exists():
        try:
            previous = json.loads(out.read_text())
        except ValueError:
            previous = None
        strip = lambda g: {k: v for k, v in g.items() if k != "generated"}
        if previous is not None and strip(previous) == strip(graph):
            print(f"stop graph unchanged; left {out} as is")
            return 0
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(graph, indent=2, ensure_ascii=False) + "\n")
    print(f"wrote {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
