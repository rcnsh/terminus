-- Every class-trip answer reads crowd_stats for today's kind of day at up
-- to eight stops (loadCrowdRisk). The primary key starts with svc, which
-- the lookup doesn't know, so without this it read the whole table each time.
CREATE INDEX IF NOT EXISTS crowd_stats_lookup ON crowd_stats(daytype, stop);

-- A push token lives on one session: registering it clears it from any
-- other session first (setPushToken), which scanned every session.
CREATE INDEX IF NOT EXISTS sessions_push ON sessions(push_token) WHERE push_token IS NOT NULL;
