-- Accounts in the apps: an app can start with an anonymous account (no email)
-- and add one later, approved from the email (login_requests).
--
-- users.email loses NOT NULL. SQLite can't drop a constraint, so users is
-- rebuilt. D1 always enforces foreign keys, and DROP TABLE users would run
-- every ON DELETE CASCADE (defer_foreign_keys doesn't stop cascades), so the
-- five tables that reference users are rebuilt with it: new tables are
-- created and filled first, the old children are dropped before the old
-- users table, and renaming users_new to users rewrites the new children's
-- REFERENCES to match.

CREATE TABLE users_new (
  id         TEXT PRIMARY KEY,
  -- NULL for an anonymous account. SQLite allows many NULLs under UNIQUE.
  email      TEXT UNIQUE,
  created    INTEGER NOT NULL,
  -- Last request from any of its sessions, so idle anonymous accounts can go.
  last_seen  INTEGER NOT NULL,
  -- 'web': signed up on the account page. 'app': started in an app.
  via        TEXT NOT NULL DEFAULT 'web',
  -- When an anonymous account added an email.
  email_added INTEGER
);
INSERT INTO users_new (id, email, created, last_seen, via)
  SELECT u.id, u.email, u.created,
         COALESCE((SELECT MAX(s.last_seen) FROM sessions s WHERE s.user_id = u.id), u.created),
         'web'
    FROM users u;

CREATE TABLE sessions_new (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users_new(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('web', 'device')),
  name       TEXT,
  created    INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL,
  expires    INTEGER,
  platform   TEXT,
  -- The x-terminus-client header, e.g. "android/1.4.0".
  client     TEXT
);
INSERT INTO sessions_new (token_hash, user_id, kind, name, created, last_seen, expires, platform)
  SELECT token_hash, user_id, kind, name, created, last_seen, expires, platform FROM sessions;

CREATE TABLE pair_codes_new (
  code    TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users_new(id) ON DELETE CASCADE,
  expires INTEGER NOT NULL
);
INSERT INTO pair_codes_new SELECT code, user_id, expires FROM pair_codes;

CREATE TABLE profiles_new (
  user_id TEXT PRIMARY KEY REFERENCES users_new(id) ON DELETE CASCADE,
  json    TEXT NOT NULL,
  updated INTEGER NOT NULL
);
INSERT INTO profiles_new SELECT user_id, json, updated FROM profiles;

CREATE TABLE api_keys_new (
  id        TEXT PRIMARY KEY,
  user_id   TEXT NOT NULL REFERENCES users_new(id) ON DELETE CASCADE,
  key_hash  TEXT NOT NULL UNIQUE,
  name      TEXT NOT NULL,
  hint      TEXT NOT NULL,
  created   INTEGER NOT NULL,
  last_used INTEGER
);
INSERT INTO api_keys_new SELECT id, user_id, key_hash, name, hint, created, last_used FROM api_keys;

CREATE TABLE feedback_new (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users_new(id) ON DELETE CASCADE,
  created     INTEGER NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('wrong', 'other')),
  note        TEXT NOT NULL,
  platform    TEXT NOT NULL,
  app_version TEXT,
  context     TEXT
);
INSERT INTO feedback_new SELECT id, user_id, created, kind, note, platform, app_version, context FROM feedback;

-- Children first: once they're gone, dropping users cascades into nothing.
DROP TABLE sessions;
DROP TABLE pair_codes;
DROP TABLE profiles;
DROP TABLE api_keys;
DROP TABLE feedback;
DROP TABLE users;

ALTER TABLE users_new RENAME TO users;
ALTER TABLE sessions_new RENAME TO sessions;
ALTER TABLE pair_codes_new RENAME TO pair_codes;
ALTER TABLE profiles_new RENAME TO profiles;
ALTER TABLE api_keys_new RENAME TO api_keys;
ALTER TABLE feedback_new RENAME TO feedback;

CREATE INDEX sessions_user ON sessions(user_id);
CREATE INDEX api_keys_user ON api_keys(user_id);
CREATE INDEX feedback_user ON feedback(user_id, created);
CREATE INDEX feedback_created ON feedback(created);
CREATE INDEX users_anon_idle ON users(last_seen) WHERE email IS NULL;

-- Signing in from an app, confirmed from the email (RFC 8628 style): the
-- code in the email typed into the app, or the email's link opened anywhere
-- and the app's number chosen. The app polls with `poll`; the email carries
-- different secrets (`code`, `link`), so the app that started a request
-- can't confirm it itself. All stored hashed.
CREATE TABLE login_requests (
  id           TEXT PRIMARY KEY,
  email        TEXT NOT NULL,
  poll_hash    TEXT NOT NULL,
  link_hash    TEXT NOT NULL UNIQUE,
  code_hash    TEXT NOT NULL,
  -- Wrong codes typed so far; the request dies at five.
  code_tries   INTEGER NOT NULL DEFAULT 0,
  -- The number the app shows; the approver must pick it.
  match        INTEGER NOT NULL,
  device_name  TEXT NOT NULL,
  platform     TEXT,
  -- The anonymous account of the device asking, if it had one.
  anon_user_id TEXT,
  -- pending | approved | denied | done. 'blocked' behaves as pending, forever.
  status       TEXT NOT NULL,
  created      INTEGER NOT NULL,
  expires      INTEGER NOT NULL
);
CREATE INDEX login_requests_email ON login_requests(email, created);
