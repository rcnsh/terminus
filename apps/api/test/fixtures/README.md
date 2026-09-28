# Fixtures

Real responses, captured 2026-08-27 ~19:55 SGT from `bus.hewliyang.com/api/stop/<CODE>`.

**Provenance caveat:** that endpoint is `hewliyang/nus-nextbus-web`'s own
SvelteKit server route, not the ConnectX FMS directly. The outer envelope
(`{ etas: { ... }, degraded }`) is his; the row shape inside `timings` is
passthrough -- `arrivalTime`, `nextArrivalTime`, `arrivalTime_veh_plate`,
`arrivalTime_capacity`, `busStopCode` are FMS field names.

So: trust the rows, treat the envelope as one of several `normalize()` must
handle. Replace these with raw `ShuttleService` bodies once the capture exists.

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
