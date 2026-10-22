# Live buses are shown at a stop or between two, not where the feed puts them

The NUS feed moves a bus only every 15–20 s, by 200–300 m, and many routes use the same road both ways, so drawing buses at their GPS position (or gliding them along the route line) kept putting them on the wrong side of the road and sliding them backwards. After three attempts in three days (d5da14e0, reverted in 4126a77a; b076f5bd), a bus is now placed by its track along its own route and drawn at the stop it is at, or between the stop it passed and the next (fe6bb98e). It is never moved backwards, and it is hidden if it is far off its route.

## Considered Options

- Raw feed positions: wrong side on two-way roads, two buses on one point.
- Snapping each fix to the line, with interpolated motion: reverted, because a single update could carry a bus round its loop.
- A track held in one Worker instance's memory: other instances placed buses afresh, and they switched sides about 14 times in 12 minutes. Tracks now live in the edge cache with the placed buses.
