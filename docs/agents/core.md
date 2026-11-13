# How the core works (short version)

The short version of [internals.md](../internals.md), which has the
depth. Read the bullet for the part you're changing.

- **Data graph.** `data/stops.json` (stops, route order, operating hours) is
  scraped weekly by `scrape.yml` → `scripts/data/scrape_stops.py`, along with
  `shapes.json` (route lines from OpenStreetMap via Overpass) and
  `calendar.json`. The workflow is three jobs: `scrape` holds the feed
  secrets and runs only the repo's standard-library Python; `test` runs the
  tests and `check_scraped.py` with no secrets; `commit`, the only job that
  can push, runs no npm code and fast-forwards main to a data-only commit
  on top of the tested one (if main moved, it pushes nothing: run it
  again). A last job, `heartbeat`, holds only the `HC_SCRAPE_URL` secret
  and runs only curl, pinging healthchecks.io with the run's outcome.
  `check_scraped.py` compares with HEAD and fails on a stop moved
  over 100 m, a changed stop order, any item lost from a list under 20,
  odd names, or a moved semester; such a change is committed by hand. A failed
  shapes, public-buses or calendar refresh keeps the committed file and
  shows as a warning on the run. The data is bundled into the
  Worker, so a data change needs a deploy. The calendar is the exception:
  the cron also fetches it weekly into KV (`src/timetable/calendarsync.ts`), so it
  doesn't run out when nobody deploys.
- **Answering.** `resolve.ts` picks the candidate stops near the user likeliest
  to get them there soonest (worked out from the route data, not the
  nearest: `likelyTripS`), pairs each
  stop with its opposite stop across the road, checks the bus goes downstream to the
  destination, and scores the options by arrival time. Rides are
  `RIDE.secondsPerHop` a stop, no faster than `RIDE.longHopMs` over a long
  stretch (`RIDE` in config). Walking is
  recommended only when it beats the bus by `WALK.beatsBusByS`. Where no
  single bus goes there, a trip changes buses once (`src/answer/transfer.ts`,
  `TRANSFER` in config): at most `TRANSFER.maxFetch` change stops fetched
  per answer, the second bus in `change`, the trip as sure as its less
  sure bus.
  A room can have several stops (`venueStops()`, `stops` in `venues.json`):
  a trip from or to a class considers each, with the room's own walk to it.
  Where the map's nearest stop is the wrong one, fix it in
  `data/src/venue-stops.json` and run `scripts/data/walk_routes.py`.
  Standing in a building, the walk to a stop is the path from it (`out` in
  `venues.json`, `buildingStops()`), and only by its listed stops when it
  has them, not the straight line.
- **Quality ladder.** Each answer says how sure it is: `live`, `scheduled` (a
  headway guess inside operating hours, labelled as such), and so on. Never
  label a guess as live.
- **Accounts.** D1. Sign-in is by emailed code or link. Apps get a device
  token: anonymous on first launch, then sign-in approved from the email, or
  pairing codes. Rate limits are Workers rate-limit bindings (`RL_*`). The
  cron deletes anonymous accounts unused for 60 days.
- **Live buses (`/api/buses`, `src/map/buses.ts`).** NUS's feed moves a bus about
  every 15–20 s (measured with the `probe live-bus feed` workflow).
  - Many routes use the same road both ways, so the two directions of the
    line are metres apart (often on the same points) and GPS can't choose.
    Each bus has a **track**, its last place along the line. A new position
    counts only where the bus could have driven to since, so its next stop
    only moves forward and it keeps its side (`follow`). With no track, its
    heading, then the stop it's standing at, then distance decide. The track
    gives way after two moving fixes heading the other way.
  - Tracks are kept in the edge cache with the placed buses
    (`trackedBuses`), so every instance answers the same. Placing is a pure
    function of the update, its time and the tracks.
  - The readings are too far apart and noisy to draw a bus where it is, so
    it's shown **at a stop or between two** (`sectionOf`): within 40 m of a
    stop along its line, at that stop's dot (`at`, `slot` when several are
    there); otherwise halfway between the stop it passed and the next, or
    spread evenly with several (thirds for two). On the same stretch, a
    bus's spot never moves backwards; it waits where it was. Between stops it comes with its `stretch`, which a tapped bus
    highlights, so the midpoint isn't read as its position. A bus over 50 m off its line isn't shown.
  - Clients poll every 5 s. A bus at a stop is drawn a few pixels beside
    the dot, on the kerb side (left of its heading), the ones behind it
    further back; a bus that changes place slides there along the line in
    1–4 s, longer the further it goes (web `map.js` `moveTo`;
    Android `Slides`), or jumps.
  - `test/fixtures/bus-trace.jsonl` is a real feed trace (the probe
    workflow with `trace`); `buses.test.js` replays it.
  - Each bus comes with its number plate (`plate`, shown on its card on
    the map); `id` is a hash, stable while it runs.
- **Public buses (`src/answer/public.ts`, `src/feeds/lta.ts`, `data/public.json`).** Off
  by default; an account turns them on (`publicBuses` in the profile). The
  public buses that call at the campus's stops (95, 151, 96 and others, from
  LTA DataMall via `scripts/data/scrape_lta.py`, weekly) join a second graph,
  `GRAPH_PUBLIC`, used only when asked: a public stop on a shuttle stop's
  shelter is the same stop with a `publicCode`; a stop of its own keeps
  LTA's five-digit code. A two-way service is two routes, `151/1` and
  `151/2`, shown as `151` (`svcName()`). Ride time comes from metres along
  the route (`along`) rather than a count of stops. A public bus is the headline
  only when it beats the free bus by `PUBLIC.fareWorthS`; its leg carries
  `paid: true`, and a timetabled time (LTA's `Monitored: 0`) is
  `scheduled`, never `live`. The map shows no public buses.
- **Timelapse (`src/map/timelapse.ts`, `src/map/timelapsedo.ts`).** Rule 2's one
  exception: a Durable Object per Singapore day records every service's
  buses every 30 s through `getBuses()`, inside 06:30 to 00:30, and writes
  the day to R2 (`timelapse/YYYY-MM-DD.json.gz`) at the close.
  The dashboard's Timelapse (`/admin/#/timelapse`) replays a day (`replay.js`, which the tests share) and
  exports a video with Mediabunny, frame by frame. Details in internals.md.
- **Map.** `/api/campus` returns stops and route lines. The street map is a
  PMTiles extract in each site's own R2 bucket
  (`terminus`, `terminus-beta`), uploaded by the
  `map tiles` workflow or `scripts/map-tiles.sh` (`CHANNEL=stable|beta|both`).
  What goes up is pinned in `scripts/map-tiles.lock` (the Protomaps build,
  the basemaps-assets commit, the Noto Sans SC tag that fills in Chinese,
  SHA-256s of the cut and of every font and icon); nothing uploads unless
  it matches. To refresh: `scripts/map-tiles.sh
  --update`, review and commit the lock, then run the workflow within a few
  days (Protomaps keeps a build about a week). Its schedule only checks for
  a newer build. The style is Protomaps basemaps without
  points of interest, with every URL on our own domain.
