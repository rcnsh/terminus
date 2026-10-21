# Arrival-time backtest: results

**No backtest on real data has been run yet.** The local recording planned
for the morning of 22 October 2026 (`scripts/record_eta.mjs`) was stopped
before the shuttles started, with no buses recorded. So there is no evidence
yet that the model ([eta-model.md](eta-model.md)) beats the feed.

## What has been checked

- **The tests** (`test/etamodel.test.js`, `test/etashadow.test.js`),
  including arrival detection on the real feed trace
  (`test/fixtures/bus-trace.jsonl`).
- **The pipeline, on synthetic data.** This used two made-up recorder days
  in the production format: three D2 buses for two hours, a little slower
  on the second day, and a feed that is 60 s too early ± 45 s. These numbers
  only show the script runs and finds a bias it was given. They say nothing
  about real buses.

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
