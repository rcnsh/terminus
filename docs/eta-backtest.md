# Arrival-time backtest: results

## Round 7: fitted to leave no more buses early than the feed

**The blend now passes at every horizon.** The correction and the blend's
weights are fitted for the least error among the choices that leave no
more buses early than the feed's own times did (`biasOf`, `weightsFrom`).
Same 30 days and predictions as round 6, walked forward from 12 October,
so each day is fitted only on the days before it. Without the 19 October
incident (change against the feed, 95% interval):

| feed said | method | MAE change, s | p90 change, s | early: feed → method | early change, points | verdict |
|---|---|---|---|---|---|---|
| any time | checked | −2.4 (−3.6 to −1.3) | −1.6 (−3.0 to +0.5) | 7.7% → 7.5% | −0.2 (−0.7 to +0.2) | better |
| any time | blend | −4.1 (−5.3 to −3.0) | −3.6 (−9.3 to −0.1) | 7.7% → 8.1% | +0.5 (−0.2 to +1.1) | better |
| under 2 min | blend | −12.8 (−21.8 to −5.9) | −8.1 (−13.0 to −3.3) | 1.2% → 1.1% | −0.2 (−0.8 to +0.7) | better |
| 2 to 5 min | blend | −2.1 (−3.0 to −1.3) | −7.7 (−16.8 to −3.1) | 4.3% → 4.0% | −0.3 (−1.7 to +0.8) | better |
| 5 to 10 min | blend | −1.5 (−2.2 to −0.8) | −3.5 (−6.1 to +0.6) | 4.8% → 5.0% | +0.2 (−0.2 to +0.6) | better |
| 10 to 30 min | blend | −3.5 (−5.9 to −1.5) | −9.3 (−15.6 to −3.2) | 11.5% → 12.5% | +0.9 (0 to +1.9) | better |

With 19 October in, the blend is better at every horizon too, and its MAE
falls by 9.9 s overall.

- **The gain is smaller than round 6's** (4.1 s rather than 7.8 s), and
  that's the point: round 6's extra 4 s came from moving times later,
  which made more people miss their bus.
- **Early buses are held, not cut.** The limit holds on the days a model
  is fitted on; on the days after, early buses drift up a little, most at
  10 to 30 minutes (+0.9 points, the interval touching 0). The bar still
  passes, but that is the horizon to watch in the shadow. The limit is
  checked on the blend before the check (checkS) replaces any times, which
  may be part of it.
- **Almost no correction passes.** Every correction big enough to help
  moves some buses to early: for all services together it is 0 at every
  horizon but 1 s at 5 to 10 minutes, and for single services between 8 s
  sooner and 16 s later. The gain is history's and the check's.
- **The weights:** under 2 minutes 0.6 on history, 2 to 5 0.6, 5 to 10 0,
  10 to 30 1 (round 6's fit: 0.6, 0.7, 0.5, 1). At 5 to 10 minutes history
  makes buses early, so it gets none.
- **A price on early buses didn't work.** Fitting to the error plus the
  service's headway for each bus over a minute early (the wait for the next)
  overcorrected: it moved times 12 to 59 s sooner, early buses fell to 3%,
  and MAE rose 7 s, worse at every horizon but the first. A quarter of the
  headway failed at 5 to 10 minutes. A price assumes a rider arrives just
  in time; the limit needs no price and matches the bar in eta-model.md.

## Round 6: tested over the days together, early buses counted

**The blend's gain is real, but it makes buses come early more often.**
The stable site's 30 recorder days (7 October to 5 November 2026) and
the feed's plated predictions from Analytics Engine, walked forward from
12 October as before: 25 test days, 5,293 questions history could answer.
"Is it better than the feed?" (eta-model.md, *The backtest*) now tests
each method against the feed over the days together, and counts the
share of buses that came over a minute sooner than said.

19 October is an incident: the feed over 5 minutes off on 36% of the 284
questions it answered that day, mostly times stuck and buses leaving a
first stop. Without it
(24 days, 5,039 questions; change against the feed, 95% interval):

| feed said | method | MAE change, s | p90 change, s | early: feed → method | early change, points | verdict |
|---|---|---|---|---|---|---|
| any time | checked | −7.0 (−8.8 to −5.3) | −15.4 (−22.0 to −8.7) | 7.7% → 13.3% | +5.6 (+4.4 to +6.8) | worse |
| any time | blend | −7.8 (−9.4 to −6.3) | −14.9 (−23.4 to −8.0) | 7.7% → 12.9% | +5.2 (+4.1 to +6.4) | worse |
| under 2 min | blend | −12.9 (−21.9 to −6.0) | −8.4 (−13.2 to −3.8) | 1.2% → 0.9% | −0.3 (−0.9 to +0.5) | better |
| 2 to 5 min | blend | −2.8 (−4.1 to −1.7) | −11.6 (−19.6 to −5.8) | 4.3% → 4.4% | +0.1 (−1.4 to +1.4) | better |
| 5 to 10 min | blend | −5.8 (−7.9 to −3.6) | −17.3 (−26.1 to −11.3) | 4.8% → 11.1% | +6.4 (+4.6 to +8.3) | worse |
| 10 to 30 min | blend | −8.8 (−11.1 to −6.8) | −23.7 (−29.4 to −13.9) | 11.5% → 19.2% | +7.7 (+6.3 to +9.1) | worse |

- **The gain holds.** MAE and p90 improve at every horizon, and the
  intervals stay below zero: it isn't a few good days. With 19 October
  in, the blend's MAE falls by 14.1 s rather than 7.8 s.
- **Early buses are the cost.** From 5 minutes ahead, the blend says the
  bus comes later than the feed does, and the bus beats it by over a
  minute on 11 to 19% of answers against the feed's 5 to 12%. Someone who
  leaves by those times misses the bus more often, which MAE can't show:
  it counts a minute early the same as a minute late.
- **The correction causes it.** With every method tested
  (`--methods corrected,checked,gated,recent,blend`), the corrected feed
  alone adds 5.6 points of early buses overall, the same as checked,
  against history+gate's 1.6 and history+gate+recent's 4.0. The feed's median error is the bus coming later
  (24 s at 5 to 10 minutes, 36 s at 10 to 30), so adding it moves the
  times later for every bus, including the ones that were already going
  to be early.
- **Under 5 minutes the blend is better** with no more early buses: the
  check and history do the work there, and the correction is small.
- **Next:** correct the feed by less than its median error (a lower
  percentile), or fit the weights with a cost on early buses, and run
  this again. Until then the blend shouldn't answer anyone from 5 minutes
  out.

## Round 5: the recorder's buses kept to their side of the road

**With the passings repaired, the blend beats the feed by 16%, not 9%.**
Round 4's "went by" misses came from the timelapse recorder, not the
feed. Rerun on the same 27 days and predictions, walked forward from 12
October as before:

| method | MAE | p50 | p90 | over 5 min | under 2 min | 2 to 5 | 5 to 10 | 10 to 30 |
|---|---|---|---|---|---|---|---|---|
| feed | 95.5 s | 47.9 s | 175.6 s | 4.1% | 48.5 | 89.7 | 57.2 | 124.1 |
| checked | 82.2 s | 44.9 s | 153.9 s | 3.0% | 39.9 | 73.9 | 53.1 | 106.5 |
| blend | 79.9 s | 44.0 s | 154.9 s | 3.0% | 36.9 | 72.6 | 52.2 | 103.7 |

The horizon columns are MAE in seconds; 4,127 questions (more than round
4's 3,904, since more passings are found). Every method gains on every
horizon, the feed included: these were errors in the scoring.

- **What went wrong.** The recorder places each bus as the map does, from
  its track (buses.ts `follow`), but the tracks it saved to the edge cache
  never came back to its Durable Object between polls. Placed afresh every
  30 s, a bus on a road its line takes both ways (LT13 and LT13-OPP, AS5
  and NUSS-OPP, TCOMS and TCOMS-OPP) was put on the far side for a
  reading: 3.8% of D1's readings and 2.8% of D2's, against 0.01% of A1's,
  whose line has no such road. `passingsOf` compared each reading only with
  the one before, so a far-side reading cost the passings either side of
  it. Replaying the feed trace (`bus-trace.jsonl`) every 30 s through
  `follow` gives no such reading with the track kept, and 4 to 7% on D1
  and D2 without it.
- **The fix**, in two parts. The recorder keeps its tracks in its own
  storage, so new days are placed right. `passingsOf` measures each
  reading from the last good one, passing over one more than 500 m back or
  too far ahead until three in a row agree with each other, so the
  recorded days are repaired too. Two agreeing aren't enough against a
  good reading: two far-side readings in a row are common (about 100 a
  day). A loop's end leads to its start only within 1,200 m of the two
  ends together: a reading far back could otherwise pass for a lap ahead.
  A1 and A2 reversing out of KRB (up to 500 m back) still count, and a
  stop is passed once: driving on after a step back doesn't pass the
  stops it already had again.
- **On the 27 days,** passings rise by 2% (D2 8%, D1 5%), passings in a
  row that skip a stop fall from 9,545 to 4,218, a stop twice within 5
  minutes from 2,422 to 274, and impossibly quick ones (adjacent stops
  under 8 s apart) from 30 to 20. What's gone is mostly A1 and A2 at KRB:
  a bus that reversed out of the terminal and drove off passed KRB a
  second time, on leaving.
- **Went by: 36 misses to 7.** What's left looks like something else: D1
  off its line in the COM3 bay, an A1 seen at neither BIZ2 nor TCOMS-OPP
  between AS5 and PGP on 22 October, and a run of far-side readings
  longer than 2 minutes.
- **The misses now:** 168 (4.1%), 37% of the feed's error. Waiting at a
  first stop is the biggest cause (64, 13.1%), then other (43, 8.8%) and
  stuck (40, 8.6%).
- **Under 2 minutes**, only 1.6% of the feed's answers are misses (round 4:
  4.2%): most of those were the scoring's.

## Round 4: where the feed's worst answers come from

**A fifth of the feed's worst answers are the scoring's mistake, not the
feed's.** The stable site's recorder days from 7 October to 2 November
2026 and the feed's plated predictions from Analytics Engine, walked
forward from 12 October (`--walk-from`: each day answered by a model
fitted on the 28 days before it): 22 test days, 3,904 questions history
could answer. Each of the feed's answers over 5 minutes off was put down
to its cause (eta-model.md, *Why an answer is far off*).

| method | MAE | p50 | p90 | over 5 min |
|---|---|---|---|---|
| feed | 108.7 s | 48.6 s | 182.9 s | 4.9% |
| checked | 98.1 s | 45.6 s | 159.7 s | 4.1% |
| blend | 98.5 s | 44.7 s | 161.3 s | 4.1% |

The feed was over 5 minutes off on 190 questions (4.9%), and those were
45% of its absolute error:

| cause | misses | bus later than said | of the feed's error | feed | checked | blend |
|---|---|---|---|---|---|---|
| went by | 36 | 100% | 13.9% | 1,638 s | 1,753 s | 1,800 s |
| at the stop | 12 | 58% | 3.4% | 1,190 s | 905 s | 905 s |
| stuck | 34 | 74% | 6.9% | 864 s | 613 s | 607 s |
| first stop | 74 | 91% | 14.6% | 838 s | 731 s | 725 s |
| held | 2 | 100% | 0.2% | 344 s | 314 s | 314 s |
| other | 32 | 38% | 6.4% | 854 s | 586 s | 456 s |

The last three columns are the mean error on those questions. 25 more
misses were on buses unseen for 20 minutes, which history can't answer
and so aren't scored.

- **Went by: the scoring's mistake.** The recorder saw the bus at stops
  before and after the one asked about, one straight after the other, and
  never at it, so the question was matched with the bus's next lap, 25 to
  30 minutes later. It happens at a few stops: AS5 and LT13 for D1 (seen
  at CLB, then at BIZ2), LT13-OPP for A2, BIZ2 for A1, and S17 for every D2
  on the morning of 19 October. Only 36 questions, but each about 27
  minutes "late". Without them, every method's MAE drops by 14 to 16 s:
  the feed 94.5 s, the checked feed and the blend 82.7 s (−12%). The 12
  "at the stop" misses may be the same kind: the bus last seen reaching
  the stop asked about, so possibly still there, and matched with its
  next lap.
- **The 2-to-5-minute rise is two things.** Its median error (34 s) is
  below 5 to 10 minutes' (45 s); only its misses (5.5% against 0.7%) put
  its mean above. 11 of them went by. Of the other 21, 17 are D2 at PGP
  on 19 October, 07:28 to 08:14: the feed said about 3 minutes for every
  D2 while the buses still waited at COM3, two stops back, and they came
  14 to 31 minutes later. Without the went-by questions, the feed's MAE
  at 2 to 5 minutes is 84.8 s and the blend's 68.4 s.
- **Waiting at a first stop is the biggest cause the feed owns**: 74
  misses, 14.6% of its error, 91% of them buses coming later than said.
  The check helps a little (838 s to 731 s on them); nothing in the model
  knows when a bus will leave COM3 or KRB.
- **Stuck times are fewer than expected** (34, 6.9%), almost all at 10 to
  30 minutes. The check already takes about a third off them. A stuck
  time across buses, as on 19 October at PGP, isn't caught: each bus's
  time moved a little.
- **The check's 90 s limit stops it on most misses**: 107 of the 190 were
  on a bus last seen at a stop more than 90 s before.

**What's next:** fix the scoring first (round 5). Then the departures
from a first stop, the biggest cause that is the feed's own.

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
