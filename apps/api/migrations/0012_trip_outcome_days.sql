-- How each trip went keeps the day, not the moment: `at` becomes the start
-- of that day in Singapore (UTC+8). The suggestions only count days, and an
-- exact time would say when you got off a bus. New rows are written this
-- way (outcomes.ts); this rounds the ones already kept.
UPDATE trip_outcomes SET at = at - ((at + 28800000) % 86400000);
