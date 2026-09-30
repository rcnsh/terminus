-- Phase 8.2: measured ride times.
--
-- ride_times: one row per ride that detection saw start and end by the
-- phone's location (the bus leaving, and reaching the stop you get off at).
-- The service, the two stops, how many stops apart, how long, the hour and
-- kind of day it started, and the bus's plate when known. No user, no
-- device, no location. Kept 120 days (the cron prunes older rows). Once a
-- day the cron turns them into seconds per stop for each service and hour,
-- kept in KV (ride:hops), which the planner uses in place of the guess.
CREATE TABLE IF NOT EXISTS ride_times (
  svc       TEXT NOT NULL,
  from_code TEXT NOT NULL,
  to_code   TEXT NOT NULL,
  hops      INTEGER NOT NULL,
  seconds   INTEGER NOT NULL,
  daytype   TEXT NOT NULL,     -- term | exam | break | sat | sun
  hour      INTEGER NOT NULL,  -- 0-23, SGT, when the bus left
  day       TEXT NOT NULL,     -- YYYY-MM-DD SGT
  plate     TEXT
);
CREATE INDEX IF NOT EXISTS ride_times_day ON ride_times (day);
