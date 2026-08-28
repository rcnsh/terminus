---
version: 1
slug: "src-page-ts"
primary_target: "src/page.ts"
related_targets: ["route:/map","route:/plan"]
---

# Surface brief: Map + Route Planner

## 1. Job and audience

Two NUS Bus audiences from PRODUCT.md, both served by this pair of surfaces:
the habitual commuter who already has a `/next` link but occasionally needs to
go somewhere their configured trips don't cover, and the ad-hoc/occasional
user with no configured trip at all who just opened the app cold. Mode is
**Operate**: both surfaces exist so a task gets completed (find a stop, get a
route) as fast and legibly as possible — not to persuade or to be browsed.

## 2. Outcome and proof

- **Map:** see every ISB stop's true relative position on campus and its
  live arrivals at a glance; tap a stop to see its next few buses without
  leaving the map.
- **Plan a trip:** name a destination (building, landmark, or stop) and get
  back the same kind of answer `/next` already gives for a configured trip —
  nearest useful stop, walk-vs-ride comparison, quality-ladder-honest arrival
  time — just for an arbitrary destination instead of a hardcoded one.
- Proof/evidence used: `data/stops.json` (33 real stops, real lat/lon, 8
  routes, 5 of them loops), `data/venues.json` (building → nearest stop),
  and the existing `resolve.ts` scoring engine — nothing here invents new
  data, it's the existing engine given a different entry point.

## 3. Selected direction

**Visual authority:** unchanged. This is a composition decision, not a
redesign — the existing dark/light token system, card style, typography
(`page.ts`'s CSS custom properties, accent orange, tabular-nums clock, etc.)
carries over exactly as-is to the new surfaces.

**Structural thesis — three-tab shell, replacing the current single-answer
page + dropdown menu:**

Per your steer ("the whole home page probably needs reworking anyway... take
creative liberty"), the home page becomes a persistent bottom tab bar with
three peers instead of one page with a buried menu:

- **Now** — today's zero-tap answer, verbatim. This tab is the default on
  load, unconditionally (Product Principle #4 — the habitual flow stays
  exactly as fast as it is today; this is a navigation change around it, not
  a change to it).
- **Map** — the real-coordinate SVG diagram.
- **Plan** — the destination search + computed answer.

The existing dropdown menu's account-y actions (import NUSMods timetable,
manage personal link) move to a small persistent icon in the shared header,
visible on all three tabs, rather than living inside any one tab.

**Why a tab bar over the current single-page-plus-menu:** with three
first-class surfaces instead of one, burying two of them in a dropdown
undersells them relative to competitors (nusbus.app gives `/services` and
`/directions` their own top-level pages). A bottom tab bar is the standard,
thumb-reachable mobile-PWA pattern for exactly this "3-5 peer destinations"
shape, and keeps every tab a single fast switch with no page reload —
consistent with the "fetch-on-demand, no client-side computation" architecture
already in place.

**Map focal moment:** the SVG diagram itself, on load, already centered and
scaled to show the whole campus with every stop as a small node; a subtle
pulse on the nearest stop to the user's live location (reusing the same
`live`/`scheduled`/`stale` dot language from the Now tab) draws the eye
without needing a legend read first.

**Plan focal moment:** a single search field at the top (autocomplete against
venues + stops), and the moment a destination is chosen, the answer renders
in the same oversized-label treatment as the Now tab's `#label` — reinforcing
that this is the same trustworthy answer engine, not a lesser generic result
list.

## 4. Scope and boundaries

- **Fidelity:** production-ready, not exploration — both tabs fully built,
  matching the existing page's craft level.
- **Breadth:** the tab-bar shell (header + nav replacing the current
  menu-only footer), the Map tab, and the Plan tab. Service browser and
  bookmarking are explicitly out of scope for this brief (per your earlier
  scope answer) — a follow-up shape pass.
- **Named targets:** `src/page.ts` (shell rework), two new client panels
  within it (or new modules it composes), and `src/index.ts` (new data
  endpoints the panels call — implementation detail for the build phase, not
  decided here).
- **Must remain untouched:** `/next`, `/trip`, `/health`, `/subscribe`,
  `/vapid` contracts; the Now tab's rendering and copy; the quality-ladder
  semantics; no NUSNET auth; no server-side storage of a user's timetable or
  ad-hoc destinations.
- **Anti-goals:** no third-party map tile provider or map SDK; no
  reintroduction of a stop-picker into the Now tab; no client-side
  recomputation of anything the server already resolves (walk/ride scoring,
  direction, quality).

## 5. States and ranges

- **Map:** live / scheduled / stale / ended per stop, same ladder as today;
  geolocation denied or unavailable → map still renders fully (it doesn't
  depend on the user's location to be useful), just without the
  nearest-stop pulse; a stop with literally no arrivals in the feed shows its
  node dimmed, not hidden.
- **Plan:** destination not found in venues/stops search → say so plainly,
  don't silently fall back to guessing; no viable route in current service
  hours → same honest "ended" language the Now tab already uses; a
  walk-only answer (per `WALK.beatsBusByS`) is a legitimate, clearly labelled
  result, not an error state.
- **Shell:** first load with no geolocation permission prompt yet dismissed
  should not block Now (unchanged) or Map (renders without it) from being
  useful immediately.

## 6. Interaction and layout

- Bottom tab bar, three items, persistent across tabs, safe-area-aware
  (matches the existing `env(safe-area-inset-*)` handling).
- Shared header across all three tabs: brand mark (left) + the account/menu
  icon (right, replacing today's dropdown trigger) + the existing clock,
  unchanged.
- Map: fixed viewBox sized to the campus's real lat/lon bounding box, no
  pinch-zoom needed at this scale; tapping a stop node opens a small
  in-place popover (reusing the existing card visual language) with that
  stop's next arrivals, not a full-screen takeover.
- Map ↔ Plan cross-link: tapping a stop's popover offers "plan a trip from
  here," handing that stop to the Plan tab as a preset origin.
- Plan: search field with autocomplete, results grouped as "Buildings" vs
  "Stops"; once a destination is chosen, the answer card layout mirrors the
  Now tab's hierarchy (big label, secondary detail line, tertiary alt line).
- Transitions: tab switches are instant (client-side panel swap, no network
  round-trip for the shell itself); each tab's own data still loads
  async with the same loading/blur treatment `#label` already uses.

## 7. Constraints and open decisions (left to the build phase)

- Two new lightweight data endpoints are implied — one aggregating
  live arrivals for the stops shown on the map, one computing a route for an
  arbitrary origin/destination pair — both are new call sites into the
  existing `resolve.ts`/`fms.ts` machinery, not new logic.
- The map/aggregate endpoint's caching strategy against the shared rate
  ceiling (flagged in PRODUCT.md) is a build-phase decision, not resolved
  here.
- Whether tabs get real bookmarkable routes (`/map`, `/plan`) or stay
  client-side-only panel switches under `/` is a build-phase implementation
  choice; either satisfies this brief.
- Accessibility specifics (focus handling on tab switch, map node labeling
  for screen readers) are not yet established as product requirements
  (PRODUCT.md leaves this open) — the build should not regress below the
  existing page's baseline, but no stricter bar is set here.
