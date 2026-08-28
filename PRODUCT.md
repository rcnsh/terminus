# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Any NUS student. Two situations, both real:

1. **The habitual case** — leaving a building for a bus stop under time
   pressure, deciding whether to run, on the way to a lecture or home. Reached
   via their own personal `/next` link (NUSMods-derived or hardcoded trips).
2. **The occasional/ad-hoc case** — same student, or anyone else on campus,
   needing a one-off answer the default trip doesn't cover: "what's near me
   right now", "how do I get from here to there", or just browsing a route's
   live timings the way they would in a generic tracker. This is the case a
   drop-in replacement for existing trackers must also serve.

## Product Purpose

A single fast pre-rendered answer — "when is my bus, and should I run" — for
the recurring/habitual trip, PLUS full feature parity with the general-purpose
trackers students already use (bus.hewliyang.com, nusbus.app), so nobody needs
to keep both apps installed. The zero-tap answer is the hook and the USP; the
map, route browser, and route planner exist so the product is a complete
replacement, not just a companion.

## Positioning

**USP:** the fastest answer to "where and when do I go next to catch the bus
to my next lecture" — beating every competitor on the one question that
happens dozens of times a week, via route-topology-resolved direction (not GPS
proximity) and a personal recurring-trip link.

**Parity target, not differentiation:** everything else a competing tracker
offers should also exist here, at the same or better quality, so switching
away from bus.hewliyang.com or nusbus.app costs a user nothing. Confirmed via
direct inspection 2026-08-28:

- `bus.hewliyang.com` (open source, `hewliyang/nus-nextbus-web`, per its own
  README): full-screen interactive map with a geolocation crosshair, reactive
  search, bookmarking ("Starred"), dark mode, installable PWA.
- `nusbus.app`: live arrivals home; `/services` — browse all 8 routes (A1,
  A2, D1, D2, K, P, R1, R2) with stop sequences and live arrivals; `/directions`
  — a route planner between stops, buildings, and named landmarks (Kent Ridge
  MRT, UTown, PGP); `/info` — about page.

## Operating Context

Habitual flow unchanged: semester timetable imported once via NUSMods share
URL → module/lesson selections → NUSMods API → venue → `data/venues.json`
(building → nearest ISB stop) → a weekday/arrive-by/destination trip, encoded
into the user's own link. Weekday 08:40 SGT cron push wakes the service
worker with zero location permissions needed.

Ad-hoc flow (new, to reach parity): a student anywhere on campus opens the
app without a preconfigured trip and either (a) sees a map/list of stops near
their live location with arrivals, (b) browses any of the 8 services directly,
or (c) asks "where am I going" — gives a destination (search by building/
landmark/stop, reusing the same `data/venues.json` mapping already built for
NUSMods import) and gets a nearest-origin-stop-to-destination route computed
the same way `/next`/`/trip` already do it, just without a preconfigured trip
key.

## Capabilities and Constraints

- **One shared public deployment.** A single Worker instance serves every
  user via their own link. The uNivUS/FMS auth token and the README's
  acceptable-use rate ceiling (~1 request per stop per 15s) apply to combined
  traffic across all users, not per user.
- **Stateless personal links.** A user's NUSMods-derived trips encode into
  their own URL; the server stores no per-user timetable data.
- **Guest-only auth.** uNivUS's public/guest access-token flow only. No
  NUSNET credentials are ever handled, by design.
- **Zero-tap default, by design — scoped, not absolute.** The habitual/default
  answer never requires picking a stop or destination; that is still the
  product's core reason to exist. A separate, explicit "find any route" mode
  (map, service browser, route planner) is allowed to take a destination or
  stop input, because picking an endpoint is the whole point of that mode —
  it does not reintroduce the tap the default flow exists to remove.
- **New capabilities required for tracker parity** (none exist in code yet;
  these are product requirements, not implementation decisions):
  - Interactive map showing stops near the user's live location with current
    arrivals (parity with bus.hewliyang.com).
  - A full route/service browser: all 8 services (A1, A2, D1, D2, K, P, R1,
    R2) with their stop sequences and live arrivals (parity with nusbus.app's
    `/services`).
  - A general point-to-point route planner/"directions" mode: any origin
    (typically the user's live location) to any destination (building,
    landmark, or stop, searched via `data/venues.json`), not limited to the
    user's configured recurring trips (parity with nusbus.app's `/directions`
    and the ad-hoc "where am I going" ask).
  - Bookmarking/favoriting for ad-hoc stops or destinations a user checks
    often but hasn't turned into a full recurring trip (parity with
    bus.hewliyang.com's "Starred").
- **Rate/caching constraint this creates.** The existing 15-second edge cache
  is keyed per resolved stop code for a single-answer request. A map or
  service-browser view fetching many stops at once is a materially different
  load pattern against the same shared, rate-limited upstream token — it
  needs its own aggregation/caching strategy, not just reuse of the
  single-stop cache, or it risks the shared token being throttled for every
  user including the habitual zero-tap flow.
- **Honest degradation everywhere.** The existing `quality` ladder
  (`live → scheduled → stale → ended`) must extend to every new view, not
  just the single-answer one — a stale answer keeps its original timestamp
  rather than pretending to be fresh, on the map and the route planner too.
- **Known open weaknesses to preserve, not silently paper over:**
  `RIDE.secondsPerHop` (95s) is a guessed constant, so ranking confidence is
  unreliable below ~0.6; terminus berth (`-S`/`-E`) disambiguation is
  confirmed against only one captured terminus (COM3). A route planner
  surfaces these same weaknesses more often than the single-trip flow does,
  since it computes routes on demand for arbitrary pairs.
- **Whether the Worker is reachable at all off NUS wifi is unverified** — the
  README flags this as the one unconfirmed assumption everything else depends
  on.

## Brand Commitments

User-facing product name is "NUS Bus" (page `<title>` and manifest name).
Repo/codename is `nusbus-edge`. No other binding brand or identity
constraints have been set.

## Evidence on Hand

- `data/stops.json` — real scraped stop/route graph, refreshed by a weekly
  GitHub Action (`npm run scrape`).
- `data/venues.json` — building → nearest ISB stop, precomputed from uNivUS
  map-venue coordinates. Already the right foundation for a building/landmark
  search in a general route planner, not just NUSMods import.
- `data/service-hours.json` — hand-maintained operating hours, merged over
  the scraped graph.
- `test/fixtures/` — real captured uNivUS/ConnectX responses with documented
  findings (berth-suffix behaviour, crowding fields, timestamp quirks); see
  `test/fixtures/README.md`.
- Competitor feature audit, done 2026-08-28 by direct inspection (see
  Positioning above for the concrete findings on bus.hewliyang.com and
  nusbus.app).
- No user testimonials, adoption numbers, or usage metrics exist yet beyond
  the Workers Analytics Engine schema in `docs/analytics.md`. Do not
  fabricate either.

## Product Principles

1. One pre-rendered answer, shared verbatim by every client — never let a
   client compute or format its own interpretation.
2. Never infer direction from GPS proximity alone; always resolve from route
   topology.
3. An honest, clearly labelled degraded answer beats a spinner or a blank
   state, in every view, not just the default one.
4. The default/habitual flow is zero-tap, always — no stop or destination
   picker. A separate, explicit route-planning mode is allowed to take an
   endpoint, because choosing one is that mode's entire purpose.
5. Never store a user's personal schedule data server-side; it lives only in
   their own link.
6. Match or beat every general-purpose competitor feature (map, route
   browser, route planner) so the fast default answer is a reason to prefer
   this app, never an excuse for it to do less than the alternatives.

## Accessibility & Inclusion

No product-specific accessibility requirement has been established yet.
