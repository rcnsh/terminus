-- Accounts for the invite-only personal layer. Tokens are stored as SHA-256
-- hex, never raw. Times are epoch milliseconds.

-- The allowlist. Add a friend with:
--   pnpm exec cf d1 query <database id> --sql "INSERT INTO invites VALUES ('a@b.com', unixepoch() * 1000)"
CREATE TABLE invites (
  email   TEXT PRIMARY KEY,
  created INTEGER NOT NULL
);

CREATE TABLE users (
  id      TEXT PRIMARY KEY,
  email   TEXT NOT NULL UNIQUE,
  created INTEGER NOT NULL
);

CREATE TABLE magic_links (
  token_hash TEXT PRIMARY KEY,
  email      TEXT NOT NULL,
  created    INTEGER NOT NULL,
  expires    INTEGER NOT NULL
);
CREATE INDEX magic_links_email ON magic_links(email, created);

-- kind 'web' is a browser cookie that expires; kind 'device' is a paired app
-- token that lives until it is revoked.
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('web', 'device')),
  name       TEXT,
  created    INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL,
  expires    INTEGER
);
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE pair_codes (
  code    TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires INTEGER NOT NULL
);

CREATE TABLE profiles (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  json    TEXT NOT NULL,
  updated INTEGER NOT NULL
);
