# Reading the analytics

`pnpm exec cf analytics_engine sql query --file query.sql`, or the GraphQL API.

Dataset: `terminus`. Positional schema lives in `src/analytics.ts` — it is
the query contract, so it is append-only.

## Is the direction algorithm right?

The one thing nothing else measures. High-confidence answers that keep pointing
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

It is currently 95, and it is a guess that the whole ranking inherits. The
walk comparison fires more often than expected on the real graph, which is
either correct (this campus is walkable) or a sign the constant is too high.

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
`(timestamp_B + eta_B) - (timestamp_A + eta_A)` — each row predicts an absolute
arrival instant, and the difference between two of them is a segment time.
Bucket by hour of day and you have the table phase 2 wants.

This needs weeks of calendar time, which is why it collects from day one even
though nothing reads it yet.

## Crowding

`blob7` is low/medium/high, derived from a real headcount against 88-seat
buses. At peak the question is not when the bus arrives but whether you get on.

```sql
SELECT toHour(timestamp) AS hr, blob3 AS svc,
       countIf(blob7 = 'high') / count() AS pct_packed
FROM terminus WHERE blob1 = 'arrival' AND blob7 != ''
GROUP BY hr, svc ORDER BY hr
```

## Degradation in the wild

How often does the ladder actually degrade?

```sql
SELECT blob5 AS quality, count() AS n
FROM terminus WHERE blob1 = 'answer' GROUP BY quality ORDER BY n DESC
```

A lot of `unknown` means upstream is flaky or auth is failing. A lot of
`stale` means the 15-second cache is doing its job during outages.
