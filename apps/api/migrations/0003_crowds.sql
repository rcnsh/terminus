-- How often each service is packed at each stop, by day type and half hour.
-- Counted as the Worker answers; no bus is ever polled for it.
CREATE TABLE IF NOT EXISTS crowd_stats (
  svc TEXT NOT NULL,
  stop TEXT NOT NULL,
  daytype TEXT NOT NULL,   -- term | exam | break | sat | sun
  slot INTEGER NOT NULL,   -- half hours past midnight SGT, 0-47
  n INTEGER NOT NULL DEFAULT 0,
  packed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (svc, stop, daytype, slot)
);

-- One count per bus per stop per half hour, however many people look at it.
-- Kept two days, then pruned by the cron.
CREATE TABLE IF NOT EXISTS crowd_seen (
  plate TEXT NOT NULL,
  stop TEXT NOT NULL,
  day TEXT NOT NULL,       -- YYYY-MM-DD SGT
  slot INTEGER NOT NULL,
  PRIMARY KEY (plate, stop, day, slot)
);
