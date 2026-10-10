# Reading the analytics

`pnpm exec cf analytics_engine sql query --file query.sql`, or the GraphQL API.

Dataset: `terminus` (the beta's is `terminus_beta`). Positional schema lives
in `src/analytics.ts`. It is the query contract, so it is append-only.

An `answer` row is an answer someone asked for: `/api/next`, `/api/trip` or
`/api/me/next`. The Trip object's wakes and `/api/me/day`'s leave-bys are not
logged, and neither are their `arrival` rows.

## Is the direction algorithm right?

Nothing else measures this. High-confidence answers that keep pointing
at the same stop for the same trip are probably fine; a trip whose chosen stop
flips between a directional pair is the smell.

```sql
SELECT blob4 AS dest, blob2 AS stop, blob3 AS svc,
       count() AS n, avg(double7) AS confidence
FROM terminus
WHERE blob1 = 'answer' AND blob4 != ''
GROUP BY dest, stop, svc
ORDER BY dest, n DESC
```

Answers where the direction could not be resolved:

```sql
SELECT blob2 AS stop, blob3 AS svc, count() AS n
FROM terminus WHERE blob1 = 'answer' AND double8 = 1
GROUP BY stop, svc ORDER BY n DESC
```

## Is `RIDE.secondsPerHop` any good?

It is 95, a guess, and it is what the ranking uses for every shuttle ride.
The walk comparison fires more often than
expected on the real graph, which is either correct (this campus is walkable)
or a sign the constant is too high.

Segment times come from `arrival` rows: one vehicle, seen at two stops, at two
times. `blob6` is the plate and it is the join key.

```sql
SELECT blob6 AS plate, blob2 AS stop, blob3 AS svc,
       double1 AS eta_s, timestamp
FROM terminus
WHERE blob1 = 'arrival' AND blob6 != ''
ORDER BY plate, timestamp
```

For a plate seen at stop A then stop B, the travel time A→B is roughly
`(timestamp_B + eta_B) - (timestamp_A + eta_A)`: each row predicts an absolute
arrival instant, and the difference between two of them is a segment time.
Bucket by hour of day and you have a table to check `RIDE.secondsPerHop`
against. Nothing in the Worker reads it.

## Changing buses

Answers that change buses (`TRANSFER` in `src/config.ts`): where, to
which bus, how sure, and how long the wait at the change stop was
reckoned. A wait that is often long says the change is in the wrong
place; quality mostly `scheduled` says the second bus is usually past
what the feed lists.

```sql
SELECT blob2 AS stop, blob3 AS svc, blob10 AS via, blob11 AS svc2, blob5 AS quality,
       count() AS n, avg(double11) AS waitS
FROM terminus
WHERE blob1 = 'answer' AND blob10 != ''
GROUP BY stop, svc, via, svc2, quality
ORDER BY n DESC
```

## Crowding

`blob7` is low/medium/high, derived from a headcount against 88-seat
buses. At peak, what matters is whether you get on.

```sql
SELECT toHour(timestamp) AS hr, blob3 AS svc,
       countIf(blob7 = 'high') / count() AS pct_packed
FROM terminus WHERE blob1 = 'arrival' AND blob7 != ''
GROUP BY hr, svc ORDER BY hr
```

## Degradation in the wild

How often does the ladder degrade?

```sql
SELECT blob5 AS quality, count() AS n
FROM terminus WHERE blob1 = 'answer' GROUP BY quality ORDER BY n DESC
```

A lot of `unknown` means upstream is flaky or auth is failing. A lot of
`stale` means the 15-second cache is doing its job during outages.

## What the timelapse recorder costs NUS

The recorder (`src/timelapse.ts`) is the only code that polls the feed's
live buses on a schedule (the 15-minute health check reads one stop's
arrivals), so every poll writes a `timelapse` row: `blob2` says what it cost
(`upstream` a real request to NUS that was answered, `error` one that
failed, `hit` an answer the edge cache already had, `stale` and `failed`
nothing new without asking, `skipped` the breaker was open), and each
request past the first inside a poll (a token minted for it, a second call)
adds a `retry` row, so requests to NUS are `upstream` + `error` + `retry`;
`blob3` the service, `double1` the buses the feed reported. The dashboard
shows the same per day.

```sql
SELECT toDate(timestamp) AS day, blob2 AS outcome, SUM(_sample_interval) AS n
FROM terminus WHERE blob1 = 'timelapse'
GROUP BY day, outcome ORDER BY day
```

`upstream` plus `error` plus `retry` per day is the recorder's real extra
load. The polls themselves are at most 17,280 a day at the defaults (8
services, one poll each per 30 s, 18 hours), and fewer on the days the
services keep shorter hours.

## Trip signals

Each trip signal (`/api/me/signal`: on the bus, missed, not going, arrived,
and the rest) writes a `signal` row: `blob2` is the kind, `double1` is 1
and `index1` is `signal`. Nothing else, so it counts how
often each is used, never by whom or where.

```sql
SELECT blob2 AS signal, SUM(_sample_interval) AS n
FROM terminus WHERE blob1 = 'signal' GROUP BY signal ORDER BY n DESC
```

## The operator's switches

Three more kinds of statistics are collected only once switched on, on the
dashboard (`POST /api/admin/collect`, KV `config:collect:<name>`, `src/collect.ts`).
All start off, and KV failing to answer reads as off.

### Active accounts (`active`)

Once a Singapore day, the first cron run after midnight counts the accounts
whose sessions were used in the last 1, 7 and 30 days (`src/usage.ts`), in
all, by app (`web`, `android`, `mac`, `ios`, `unknown`; `api` counts keys
used) and by version (devices, from `x-terminus-client`). Only the totals
are written: `blob2` scope, `blob3` name, `blob4` the day, `double1..3` the
three windows.

```sql
SELECT blob4 AS day, blob3 AS app, max(double1) AS daily, max(double2) AS weekly
FROM terminus WHERE blob1 = 'active' AND blob2 = 'app'
GROUP BY day, app ORDER BY day
```

### Arrival-time accuracy (`eta`)

No rows of its own: the cron joins a closed day's `arrival` rows (what the
feed said, with the plate) with the timelapse recording of the same day
(where each plate was along its line every 30 s), and keeps the result in
R2 as `eta/YYYY-MM-DD.json` (`src/eta.ts`): per prediction, the service,
how far ahead it was, how much later than said the bus came, and the hour.
It needs the recorder on, the downloads bucket and `ANALYTICS_TOKEN`; it
calls nobody but Analytics Engine. A bus counts as arrived 25 m before its
stop's mark on the line, interpolated between readings; the answer is good
to about 15 s.

### Crash reports (`errors`)

`POST /api/errors` (`src/apperrors.ts`), from the apps and the website, one
row each: `blob2` platform, `blob3` version, `blob4` fingerprint, `blob5`
type, `blob6` message, `blob7` stack, `blob8` OS or browser, `double2` 1
for a crash that ended the app. While switched off, reports are answered
and dropped.

```sql
SELECT blob4 AS fingerprint, blob5 AS type, blob3 AS version, SUM(_sample_interval) AS n
FROM terminus WHERE blob1 = 'apperror' AND timestamp > NOW() - INTERVAL '7' DAY
GROUP BY fingerprint, type, version ORDER BY n DESC
```

## What the rows hold about people

None holds an account, email, IP address or coordinates, and none is
indexed by person. An `answer` or `arrival` row's stop is the one nearest
the caller when the app sent a location, `double6` is the walk to it, and
`blob4` is the destination (a class's venue, a place): together with the
time, that is a rough idea of where someone was and where they were
going. The privacy policy says so; don't add anything finer.

`active` rows are totals only; nothing in them names or follows an account.
An `apperror` row holds no account, session, device or install id, and the
address it came from is used only for the rate limit; its message and stack
are scrubbed of URL queries, email addresses, home folder names, coordinates,
long numbers and token-like strings (`scrub()`). Each app has a switch to
stop sending them. The ETA files hold no stop and no plate, only service,
lead time, error and hour.
