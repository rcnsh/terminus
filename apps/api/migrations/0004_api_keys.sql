-- API keys for the bus-answer routes. Self-serve from the account page;
-- only a hash is kept, like session tokens. Gone with the account.
CREATE TABLE IF NOT EXISTS api_keys (
  id        TEXT PRIMARY KEY,
  user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key_hash  TEXT NOT NULL UNIQUE,
  name      TEXT NOT NULL,
  hint      TEXT NOT NULL,       -- the key's last four characters, to tell keys apart
  created   INTEGER NOT NULL,
  last_used INTEGER
);
CREATE INDEX IF NOT EXISTS api_keys_user ON api_keys(user_id);
