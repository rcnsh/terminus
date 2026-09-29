-- "This answer was wrong" reports from the apps and the account page. The
-- answer the user was looking at is kept with the report, so it can be checked
-- against what the buses did. Deleted with the account.
CREATE TABLE IF NOT EXISTS feedback (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created     INTEGER NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('wrong', 'other')),
  note        TEXT NOT NULL,
  platform    TEXT NOT NULL,      -- android | mac | web
  app_version TEXT,
  context     TEXT                -- the answer as the user saw it, JSON
);
CREATE INDEX IF NOT EXISTS feedback_user ON feedback(user_id, created);
CREATE INDEX IF NOT EXISTS feedback_created ON feedback(created);
