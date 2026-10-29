# Arrival-time backtest: results

## Round 3: production days, walked forward, and the check

**The checked feed beats the feed by a tenth, on every day.** On the
stable site's recorder days from 7 to 28 October 2026, with the feed's
plated predictions from Analytics Engine, each weekday from 12 October
was answered by a model built only from the days before it (up to 28),
as the shadow does. That's 13 test days and 3,369 questions history
could answer.

| method | MAE | p90 | under 2 min | 2 to 5 | 5 to 10 | 10 to 30 | days beating the feed |
|---|---|---|---|---|---|---|---|
| feed | 110.0 s | 179.3 s | 78.9 | 121.5 | 60.0 | 134.4 | |
| corrected | 106.0 s | 163.7 s | 77.9 | 120.9 | 56.4 | 128.6 | 13 of 13 |
| **checked** | **99.1 s** | **159.2 s** | 70.6 | 104.6 | 56.4 | 121.6 | **13 of 13** |
| history | 267.0 s | 753.6 s | 87.1 | 113.8 | 140.0 | 404.8 | |
| history+gate | 106.0 s | 170.4 s | 77.6 | 121.9 | 59.4 | 127.0 | |
| history+gate+recent | 109.5 s | 179.4 s | 78.7 | 124.9 | 64.1 | 130.8 | |
| blend | 99.0 s | 160.9 s | 68.5 | 103.7 | 55.8 | 122.4 | 12 of 13 |

The horizon columns are MAE in seconds.

- **The feed's errors are mostly a few big ones.** Its median error is
  under a minute, but the 5% of questions it got over 5 minutes wrong
  make up 44% of its absolute error. The corrected feed can't fix those,
  since a median shift only moves the middle.
- **Many of them are times history can rule out.** On 19 October the
  feed held a D2 at about 3 minutes from PGP for many reads in a row,
  while the bus was on the far side of its loop (MUSEUM, UHC-OPP). It came
  25 to 30 minutes later, close to what history said. The gate had handed
  these to the feed, since the way there passes COM3, where buses wait.
  But a wait only adds time, so history at its quickest is still a floor.
- **The check** (eta-model.md, *The model*, 7) uses that: a time over 4
  minutes outside what the bus could do, at its quickest or at its
  slowest on its way, gives way to history's median. It only counts when
  the bus was seen at a stop in the last 90 s. Without that limit it
  misfired on buses last seen 8 to 17 minutes before, which had gone on
  unseen. It changes about 1 answer in 100, never made a day worse, and
  cut 19 October's MAE from 401 s to 325 s. The 4 minutes and 90 s were
  the strictest of the settings tried (1, 2 or 4 minutes; 90, 180 or
  300 s, or the bus's segment): looser ones gained a little more on
  average and lost on some days.
- **The buses just ahead hurt** on production days, at every setting
  tried (minimum 2 or 3, history's median worth 0, 4 or 10). The blend now
  weights gated history instead. The blend and the checked feed tie
  overall, but the blend's 10-to-30-minute weight on history went to 0.9
  or 1 from 20 October, and lost on that day (120 s against 105 s).
- **Finer feed corrections don't help.** A bias per stop, or per minute
  of the feed's time, did no better than per service and horizon.
- **Departures were scored as arrivals.** A time at COM3 for a D1 or D2
  leaving (the `-S` berth) was matched with the bus's arrival there,
  minutes earlier or a lap later: 176 predictions with a MAE of 793 s,
  adding about 30 s to every method's MAE in the shadow days so far. They
  aren't scored now, by eta.ts, the shadow or the backtest. The rest of
  this round leaves them out too.
- **Unused history.** The recorder has run since 7 October, but the
  shadow model built only on days it had scored itself, from 20 October.
  Both eta.ts and the shadow now look 28 days back, so the shadow runs
  every recorded day from the start, in order.

## Round 2: the gate and the buses just ahead (the same morning)

**Still nothing beats the feed overall, but history got much better.** On
the same split of the same morning as below (one weekday, 557 test
questions), the gate cut history's MAE by a fifth and its p90 by a third.
The buses just ahead added a little more. The blend now roughly ties the
feed: 60.7 s against 59.8 s.

| method | MAE | p90 | MAE vs feed | what it adds |
|---|---|---|---|---|
| feed | **59.8 s** | 127.8 s | | |
| corrected | 60.3 s | 131.9 s | +1% | |
| history | 84.0 s | 239.9 s | +40% | round 1's |
| history+gate | 67.0 s | 164.1 s | +12% | −17.0 s against history |
| history+gate+recent | 66.4 s | 163.1 s | +11% | −0.6 s against history+gate |
| blend | 60.7 s | 137.1 s | +2% | |

- **What the gate is.** History answers only for a bus on its way. Where the
  way to the stop leaves a route's first stop (KRB for A1 and A2, COM3 for
  D1 and D2), or the bus is held far past its segment's usual time, the
  feed's time is used. It handed 24% of the questions back to the feed. On
  the morning's segments, leaving a first stop took a median of 730–760 s
  at COM3, with a p90 of 960–1,100 s. That's waiting for the departure
  time, not driving. The held test caught A1s sitting at PGP for 14–19
  minutes, which history had counted as "overdue, 10 s away".
- **On the questions the gate lets through** (426), history is still worse
  than the feed: MAE 48.5 s (47.3 s with the buses just ahead) against
  38.9 s. History reads early: its mean signed error is +24 s, against the
  feed's +11 s.
- **By horizon.** Under 2 minutes, every history method still beats the
  feed (MAE 50–51 s against 54.4 s). History alone, ungated, was best there
  (45.4 s): close to a stop, an overdue bus usually is about to arrive. From
  2 to 10 minutes, the gate removes most of history's damage (2–5 min:
  81 → 63 s; 5–10 min: 144 → 89 s), but the feed still wins. At 10 to
  30 minutes (21 questions), the fitted weight on history was 1, so the
  blend was as bad as history. That's what too little training data does
  to the weights.
- **How sensitive.** The held limit (1.2× to 3× the usual time) moves
  history+gate between 65.7 and 67 s. The buses just ahead's settings
  (20–45 min back, 1–3 segments, replacing or shrunk) move
  history+gate+recent between 64.6 and 66.4 s. Every setting helps a
  little. The defaults (twice the usual time and 2 minutes over; 30 min,
  at least 2, replacing) were fixed before looking. These are tested on
  90 minutes of one morning, so none of the settings were tuned on it.

**What's next:** the same comparison trained on this morning and tested on
the afternoon (being recorded today), then on whole days once later ones
are in (the VM records every day to 12 November). Regime shift, round 1's
first suspect, is untouched by either change. Only more days can test it.

## First real data: one weekday morning

**Nothing beat the feed overall.** On one weekday morning, the feed's own
times had the lowest error overall: MAE 59.8 s against 60.3 s for the
corrected feed, 61.6 s for the blend and 84 s for history (557 test
questions). The one gain: when the feed said under 2 minutes, history alone
erred less (MAE 45.4 s against 54.4 s) and the blend 10% less. Beyond
2 minutes, history was much worse. This is a first look, not a verdict.

How it was recorded and tested:

- **When:** Thursday 22 October 2026, 07:20–11:00 SGT (A1, A2, D1, D2 and K).
- **How:** `scripts/probes/record_eta.mjs` on a VM, reading terminus.run's public
  API: `/api/buses` per service every 20 s, one `/api/arrivals` board every
  15 s. That's 10,503 bus readings and 879 board reads, with no failed
  requests.
- **Limits of the data:** positions are where the map draws a bus (at a stop
  or halfway between two), so an arrival is known to about half the poll
  (around 10 s). Boards carry no plate, so each board time is scored against
  the service's next bus of any plate.
- **Split:** trained on the first 60% of the morning (07:20–09:31), tested on
  the rest (09:31–10:59). History's medians come from a little over two hours
  of one morning, and hourly slots after 09:00 had little or no training data
  of their own.

### Data

| source | date | span (SGT) | bus readings | passings | questions |
|---|---|---|---|---|---|
| vm-2026-10-22.jsonl | 2026-10-22 | 07:20–10:59 | 10503 | 1711 | 1935 |

Training: 925 segment times over 67 stop pairs (53 with 5 or more), and 970 questions with an actual arrival for the bias and weights.
Test: 637 questions with an actual arrival; history could answer 87% of them, and every method is scored on those 557.

Methods: **feed**, the feed's time as served; **corrected**, plus the feed's median error at that horizon for that service in training;
**history**, the bus's last stop and the segment medians on from it; **blend**, history and corrected, weighted per horizon.

### Errors in seconds (actual minus predicted: positive is the bus coming later)

#### Overall

| method | n | MAE | p50 abs | p90 abs | mean signed | MAE vs feed |
|---|---|---|---|---|---|---|
| feed | 557 | 59.8 | 24.9 | 127.8 | 32 |  |
| corrected | 557 | 60.3 | 25 | 131.9 | 35.3 | +1% |
| history | 557 | 84 | 33.8 | 239.9 | 53.7 | +40% |
| blend | 557 | 61.6 | 25 | 140.1 | 36.5 | +3% |

#### Feed said under 2 min

| method | n | MAE | p50 abs | p90 abs | mean signed | MAE vs feed |
|---|---|---|---|---|---|---|
| feed | 224 | 54.4 | 19.8 | 115.9 | 31.1 |  |
| corrected | 224 | 53.9 | 19.6 | 123.2 | 38.2 | −1% |
| history | 224 | 45.4 | 20.1 | 115.9 | 7.8 | −17% |
| blend | 224 | 48.9 | 18.7 | 128.9 | 32.1 | −10% |

#### Feed said 2 to 5 min

| method | n | MAE | p50 abs | p90 abs | mean signed | MAE vs feed |
|---|---|---|---|---|---|---|
| feed | 193 | 51.3 | 27.9 | 92.3 | 25.8 |  |
| corrected | 193 | 52.4 | 28 | 94.4 | 27.6 | +2% |
| history | 193 | 81.3 | 40.4 | 196.8 | 54.1 | +58% |
| blend | 193 | 52.4 | 28 | 94.4 | 27.6 | +2% |

#### Feed said 5 to 10 min

| method | n | MAE | p50 abs | p90 abs | mean signed | MAE vs feed |
|---|---|---|---|---|---|---|
| feed | 119 | 77.5 | 38.2 | 164.1 | 42.1 |  |
| corrected | 119 | 79.6 | 38.2 | 166 | 39.9 | +3% |
| history | 119 | 144.2 | 73.9 | 377.8 | 123.1 | +86% |
| blend | 119 | 79.6 | 38.2 | 166 | 39.9 | +3% |

#### Feed said 10 to 30 min

| method | n | MAE | p50 abs | p90 abs | mean signed | MAE vs feed |
|---|---|---|---|---|---|---|
| feed | 21 | 94.5 | 100 | 197 | 40.5 |  |
| corrected | 21 | 92 | 96.9 | 193 | 50.3 | −3% |
| history | 21 | 179.5 | 155.9 | 314 | 145.7 | +90% |
| blend | 21 | 179.5 | 155.9 | 314 | 145.7 | +90% |

### Fitted model

Weight on history, by horizon: under 2 min 0.2; 2 to 5 min 0; 5 to 10 min 0; 10 to 30 min 1.

Feed bias (median error, s, all services), by horizon: under 2 min -9 (n 268); 2 to 5 min -2 (n 328); 5 to 10 min 8 (n 225); 10 to 30 min 2 (n 149).

## Pipeline check (synthetic data, not evidence)

Two made-up recorder days in the production format: three D2 buses for two
hours, a little slower on the second day, and a feed 60 s too early ± 45 s.
This only shows the script runs and finds a bias it was given.

| method | n | MAE (s) | p50 abs | p90 abs | mean signed |
|---|---|---|---|---|---|
| feed | 1830 | 61.3 | 65.2 | 96.1 | 61.3 |
| corrected | 1830 | 22.9 | 21.8 | 41.9 | 0.5 |
| history | 1830 | 62.6 | 33.8 | 71.8 | 60 |
| blend | 1830 | 21.5 | 20.7 | 40.2 | 7.4 |

## To get real results

The quickest way is from history production already has: recorder days
from R2 and the feed's predictions from Analytics Engine. The commands are
in [eta-model.md](eta-model.md), under "On production data". For a verdict:

- at least 5 weekdays and 2 weekend days of recorder days;
- at least 500 matched predictions a day;
- test days after the training days, never the same day.

Shadow mode has scored every day on its own on the stable site since
22 October 2026 (`ETA_MODEL=shadow`, with the `eta` collector on). The
results are in the R2 bucket as `eta/model/<date>.json`, one file a
day. Give it about 4 weeks, to around 19 November, before deciding whether
the model should answer anyone, and weigh it alongside the VM recordings'
backtest.
