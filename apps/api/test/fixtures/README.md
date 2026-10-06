# Fixtures

- `stop-*.json`: real stop responses, captured 2026-08-27 ~19:55 SGT from
  `bus.hewliyang.com/api/stop/<CODE>` (below).
- `connectx-ShuttleService-COM3.json`: a raw ConnectX `ShuttleService` body
  for COM3 (2026-08-28), the shape the bus proxy's `data` still carries.
- `buswidget-init.json`: the retired ConnectX token hop's reply, tokens
  redacted.
- `graph.json`: a frozen stop graph, so tests don't move when the weekly
  scrape changes `data/stops.json`.
- `answers/`: golden answers (`UPDATE_GOLDEN=1 pnpm test` rewrites them),
  read by the Android and Mac tests too; `answers/zh/` the Chinese.
- `offline-day.json`: what each app shows offline from a kept day plan, for
  the API, Android and Mac tests.
- `lta-BusArrival-*.json`: real LTA DataMall `v3/BusArrival` replies for two
  campus shelters (YIH, 16171; UHC, 18329), captured 2026-10-06 17:28 SGT.
  The second has buses the feed marks `Monitored: 0` (timetabled, with no
  position), which `normalizePublic()` reads as `scheduled`.

## The stop captures

**Provenance caveat:** that endpoint is `hewliyang/nus-nextbus-web`'s own
SvelteKit server route, not the ConnectX FMS directly. The outer envelope
(`{ etas: { ... }, degraded }`) is his; the row shape inside `timings` is
passthrough -- `arrivalTime`, `nextArrivalTime`, `arrivalTime_veh_plate`,
`arrivalTime_capacity`, `busStopCode` are FMS field names.

So: trust the rows, treat the envelope as one of several `normalize()` must
handle. The raw ConnectX body above confirms the rows; a capture of the
current bus proxy's reply would be better still.

## What they establish

- The list key is `timings`, under an `etas` envelope. Not `shuttles`.
- Crowding is `arrivalTime_capacity` / `arrivalTime_ridership` -- a real
  headcount against 88-seat buses, not a `passengers` string. Some vehicles
  report neither.
- `arrivalTime: "0"` is a real value, distinct from `"-"`.
- **`busStopCode` carries a berth suffix at terminus stops.** `-S` is the run
  STARTING at that stop, `-E` is a run ENDING there, so COM3 is the D1/D2
  terminus and returns both. `UHALL-OPP` and `UHC` are mid-route and carry no
  suffix. Only `-S` is boardable; see `resolveBerths()` in resolve.ts.
  Confirmed by plate: PD760D is 1 min from UHC and UHALL-OPP and 11 min from
  COM3-D2-E, i.e. mid-loop and about to terminate.
- `arrivalTime_ts` IS NOT the predicted arrival time. Half these rows carry a
  timestamp minutes in the past while `arrivalTime` is positive. Do not use it.
- Stop codes pair as `X` / `X-OPP` (`UHALL` / `UHALL-OPP`); captions pair as
  `X` / `Opp X`.
