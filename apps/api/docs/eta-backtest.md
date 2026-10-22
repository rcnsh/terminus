# Arrival-time backtest: results

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
- **How:** `scripts/record_eta.mjs` on a VM, reading terminus.run's public
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

After that, `ETA_MODEL=shadow` scores every day on its own. Give it about
4 weeks before deciding whether the model should answer anyone.
