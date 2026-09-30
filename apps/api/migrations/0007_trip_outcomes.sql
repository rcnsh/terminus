-- Phase 3: tap to confirm, and push.
--
-- trip_outcomes: what happened to each planned trip, one row per trip per
-- day: the answer to "On the 9:41 D2?" (boarded, missed), "Not going"
-- (skipped), "I'm there" (arrived), or no answer at all (none). Never a time
-- of day beyond when it was said, a stop or a location. Kept 35 days (the
-- cron prunes older rows) and deleted with the account. It drives three
-- things: the question stops after five trips in a row without an answer,
-- three misses in a month suggest leaving a bus earlier, and three weeks of
-- "Not going" offer to stop the reminders.
CREATE TABLE IF NOT EXISTS trip_outcomes (
  user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  trip_key TEXT NOT NULL,
  day      TEXT NOT NULL,                       -- 2026-09-30, Singapore
  outcome  TEXT NOT NULL CHECK (outcome IN ('boarded', 'missed', 'skipped', 'arrived', 'none')),
  at       INTEGER NOT NULL,
  PRIMARY KEY (user_id, trip_key, day)
);
CREATE INDEX IF NOT EXISTS trip_outcomes_recent ON trip_outcomes (user_id, at);

-- trip_prefs: what the user chose for one weekly trip. 'earlier' and 'quiet'
-- are accepted suggestions (leave one bus earlier; no reminders); the 'no-'
-- forms are suggestions turned down, not offered again for 30 days.
CREATE TABLE IF NOT EXISTS trip_prefs (
  user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  trip_key TEXT NOT NULL,
  pref     TEXT NOT NULL CHECK (pref IN ('earlier', 'quiet', 'no-earlier', 'no-quiet')),
  label    TEXT,
  set_at   INTEGER NOT NULL,
  PRIMARY KEY (user_id, trip_key, pref)
);

-- The question comes back on: only answers after this count toward muting it.
ALTER TABLE users ADD COLUMN ask_from INTEGER;

-- Where to push this device's card (Firebase Cloud Messaging token), if anywhere.
ALTER TABLE sessions ADD COLUMN push_token TEXT;
