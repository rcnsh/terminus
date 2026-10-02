-- Wrong guesses at the emailed sign-in code, counted on the link's row. KV
-- held the count before, read and written back separately, so guesses sent
-- all at once each saw the count from before the others. One UPDATE spends
-- a try atomically.
ALTER TABLE magic_links ADD COLUMN code_tries INTEGER NOT NULL DEFAULT 0;
