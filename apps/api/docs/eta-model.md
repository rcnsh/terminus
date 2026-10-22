# Arrival-time model

Can terminus say when a bus will come more accurately than NUS's feed
does? This is what was found, what was built to answer it, and what it
needs before it answers anyone. The backtest's numbers are in
[eta-backtest.md](eta-backtest.md).

## How terminus gets bus data now

- **The feed.** NUS's uNivUS bus proxy (`NEXTBUS_PROXY_BASE`), with a
  public guest token (`src/auth.ts`). `src/fms.ts` is the only reader of its
  shape: `normalize()` turns a stop's `ShuttleService` reply into arrivals
  (`etaS`, the plate, crowding, the berth: `-S` runs starting at a terminus,
  `-E` ending there), and `normalizeBuses()` turns `ActiveBus` into raw
  positions (lat, lon, heading, speed, plate). The feed's arrival times are
  whole minutes, and a bus's position moves about every 15 to 20 s.
- **On request, not on a schedule.** Arrivals are read per stop when someone
  asks, through a 15 s edge cache (`TTL.arrivalsMs`) and the feed gate (one
  upstream call per key per window, every data centre); live buses per
  service through a 5 s cache. `src/buses.ts` places each bus on its route
  line with a track (`follow`), and `/api/buses` draws it at a stop or
  halfway between two (`sectionOf`), so the public `along` is quantised.
- **The one poller** is the timelapse recorder (`src/timelapse.ts`,
  `src/timelapsedo.ts`): every service's buses every 30 s, 06:30 to 00:30,
  through `getBuses()`, bounded by CLAUDE.md rule 2. It keeps each bus's
  own track position (metres along its line, not the drawn spot).

## What history already exists

All of it is in production, none of it in the repo:

| What | Where | Shape | Since |
| --- | --- | --- | --- |
| Where every bus was, every 30 s | R2 `timelapse/YYYY-MM-DD.json.gz` (downloads bucket) | `DayFile`: per sample, each bus's plate, position and metres along its line | Since the recorder was turned on (stable site) |
| What the feed predicted | Analytics Engine, `blob1 = 'arrival'` | per answer, up to 8 arrivals at the chosen stop: plate, stop, service, `etaS` (`analytics.ts`, "the segment-time seed"); sampled at high volume (`_sample_interval`) | AE keeps about 3 months |
| How wrong the feed was | R2 `eta/YYYY-MM-DD.json` | `EtaDay` rows `[service, etaS, errS, hour]` (`src/eta.ts`) | Only while the operator collects `eta` |

There is nothing in D1 or KV, and the repo's only real trace is
`test/fixtures/bus-trace.jsonl`: 15 minutes of four services.

So a new logger isn't needed, and CLAUDE.md rule 2 forbids one in the
Worker ("Don't add another poller"). Positions are the recorder's;
predictions are what users were already shown. This work reads those two,
and adds no call to NUS.

## The model (`src/etamodel.ts`)

It starts simple, and it runs in a Worker: medians and sums, no runtime
beyond the language.

1. **Arrivals.** When each bus reached each stop: `passingsOf` (eta.ts) on
   the recorder's day, interpolated 25 m before the stop; or
   `passingsFromReadings` on the map's placed buses (a bus heading for S in
   one reading and at S, or past it, in the next), for data from the public
   API.
2. **Segment times.** A bus's consecutive arrivals at adjacent stops of its
   route (`segmentsOf`). Their medians by service and stop pair, and by
   weekday/weekend and Singapore hour (`SegmentTable`), with each slot's
   median pulled towards the pair's overall one the fewer samples it has.
   A segment out of a loop's first stop includes the layover there (D1 at
   COM3: over 12 minutes in the trace).
3. **History's time.** From a bus's last stop and when it reached it, known
   only once it could have been (a poll after): the rest of its current
   segment, at least 10 s once it's overdue, then each segment to the stop
   (`historicalEtaS`). Without a plate, the soonest of the service's buses.
4. **The gate.** History answers only for a bus on its way. It refuses
   (and the feed's time stands) when the way to the stop leaves a route's
   first stop, the bus's own included, since buses wait there for NUS's
   departure time (A1 and A2 at KRB, D1 and D2 at COM3), which travel times
   can't predict; and when the bus is over twice its current segment's usual
   time into it, and at least 2 minutes over (`heldAfterS`), since it's held
   or lost. Without a plate, the soonest bus is still picked as if ungated,
   so one waiting at the first stop isn't swapped for the one after it.
5. **The buses just ahead.** Each segment's time is the median of the
   service's own buses that drove it in the last 30 minutes, when there are
   at least 2, instead of history's (`Recent`, `recentS`). A segment counts
   only once it could be known (the reading that showed its end), so no
   answer sees anything from after it was asked.
6. **The feed corrected.** The feed's time plus its median error for that
   service at that horizon in the training data (`biasS`).
7. **The blend.** Per horizon (under 2 min, 2 to 5, 5 to 10, 10 to 30), a
   weight on history (gated, with the buses just ahead) against the corrected feed, picked in tenths to
   minimise absolute error (`weightGrid`, `weightsFrom`; ties go to the
   feed). Without history it's the corrected feed; without the feed,
   history.

Nothing in the answer path calls it. Users see the feed's times as before.

## The backtest (`scripts/eta_backtest.mjs`)

Fits the model on the earlier data and scores the feed, the corrected
feed, history, history+gate, history+gate+recent and the blend on later
data it never saw, all on the same questions (those ungated history could
answer, with the share given). The gated methods fall back to the feed's
time where the gate refuses, as they would be served; a second table
compares them with the feed on just the questions the gate lets through.
`--recent-min`, `--recent-n` and `--recent-prior` change the buses just
ahead's settings. It reports
MAE, the median and 90th-percentile absolute error and the mean signed
error, overall and by horizon. Errors are the actual arrival minus the
time given: positive is the bus coming later.

What counts as the actual arrival (`actualFor`): the first arrival of that
plate (for a board without plates, any of the service's buses) from the
moment of asking to 30 minutes after the time said. A bus said to be about
there may already have arrived: a plate said to be 2 minutes or less away
is looked for from a minute before (as `scoreEtas`), a board's next bus said
to be a minute or less away from 30 s before. A board's time at a route's
first stop is for the bus leaving (the `-S` berth), not arriving, so it
isn't scored. Questions whose bus could have come after the data ends
aren't asked.

### On production data

```bash
cd apps/api
# Recorded days, from the stable site's downloads bucket:
pnpm exec cf r2 object get terminus-downloads/timelapse/2026-10-20.json.gz --file /tmp/day-2026-10-20.json.gz
pnpm exec cf r2 object get terminus-downloads/timelapse/2026-10-21.json.gz --file /tmp/day-2026-10-21.json.gz
# The feed's predictions, from Analytics Engine's SQL API (ANALYTICS_TOKEN, CF_ACCOUNT_ID), as it answers:
curl -s "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/analytics_engine/sql" \
  -H "Authorization: Bearer $ANALYTICS_TOKEN" \
  --data "SELECT blob6 AS plate, blob2 AS stop, blob3 AS svc, double1 AS eta, timestamp FROM terminus
          WHERE blob1 = 'arrival' AND blob6 != '' AND timestamp > NOW() - INTERVAL '3' DAY" > /tmp/ae.json
node scripts/eta_backtest.mjs --day /tmp/day-2026-10-20.json.gz --predictions /tmp/ae.json \
  --day /tmp/day-2026-10-21.json.gz --predictions /tmp/ae.json --out /tmp/backtest.md
```

Each `--day` keeps only the predictions inside its own recording window,
each cached answer once, so one predictions file can serve every day. With
two days or more, the last is the test. Analytics Engine samples at high
volume; the backtest scores the rows it has, each once.

### From the public API (`scripts/record_eta.mjs`)

For a developer's machine, when there's no recorder day to hand: it signs
in as a throwaway anonymous account (deleted at the end) and reads
`/api/buses` per service every 20 s and one `/api/arrivals` board every 15 s,
taking the stops in turn, all through the Worker's caches and feed gate;
while no bus is out it asks one service every 5 minutes. It appends JSON
lines under `dev/eta/` (gitignored). This data is weaker than production's:
positions are the map's drawn spot, so an arrival is known to about half
the poll, and the boards carry no plate.

```bash
node apps/api/scripts/record_eta.mjs --until 11:00          # Singapore time
node apps/api/scripts/eta_backtest.mjs --recording dev/eta/2026-10-22.jsonl --out /tmp/backtest.md
```

## In shadow (`src/etashadow.ts`)

With the `ETA_MODEL` var set to `shadow` (unset: off) and the operator
collecting `eta`, the cron runs the backtest on production every day, after
eta.ts has scored the day. For the newest closed day not yet done (oldest
first, up to three days back), one a run:

1. it builds the model from the 28 days before: their segment times
   (`eta/segments/<date>.json`), the feed's errors (`eta/<date>.json`'s
   rows) and their weight grids;
2. it answers each of the day's plated predictions every way, and keeps the
   errors and the day's weight grid as `eta/model/<date>.json`;
3. it keeps the day's own segment times.

It writes only those two files to the downloads bucket and calls no one
but Analytics Engine. Each day is scored by a model that never saw it.

`ETA_MODEL` is set in `cloudflare.config.ts`: `shadow` on the stable site,
`off` on the beta. The `eta` collector is the dashboard's switch (`POST
/api/admin/collect`). Because each day is scored only by the days before
it, the first days have no segment times to build from: history can answer
almost nothing, and every method but the feed and the corrected feed looks
empty. Coverage grows as segment days build up. Read the days from about a
week in, and judge after about four weeks.

## How much data a verdict needs

- **Segment times.** About 105 stop pairs over the 8 services. A bus laps
  in 30 to 40 minutes, so each pair gets about 6 to 10 samples an hour of
  service from a recorder day. An hourly slot needs about 5 to stand on its
  own, so one weekday fills the weekday slots thinly; **5 weekdays and 2
  weekends** fill each slot with 30 or more.
- **Questions.** To tell a 10 s difference in MAE apart when errors spread
  about a minute, a few hundred scored questions per horizon: **at least
  500 matched predictions a day over 5 days or more**, with test days
  after training days (never the same day).
- **A decision.** **4 weeks of shadow days** (the model's own window),
  across term and a vacation week if possible: timetables and traffic
  change between them, and medians from one won't fit the other.

## Before it answers anyone

- Read the shadow days (`eta/model/*.json`): the blend should beat the
  feed's MAE and p90 at every horizon, on most days, not just on average.
- Then it can answer behind a switch, for the `live` times only: a
  `scheduled` time stays a guess, labelled so.
- What it can't see: a bus about to leave service, a breakdown, a detour,
  a bus held at a terminus beyond its usual layover. The feed may know
  some of these; the corrected feed keeps that.
