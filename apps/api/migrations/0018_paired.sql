-- 1 for a device that joined its account by redeeming a pairing code. On an
-- account without an email it marks the devices that aren't the one that
-- started it: those use the account but can't delete it, give it an email,
-- pair or remove devices (SessionInfo.paired in src/accounts/accounts.ts).
ALTER TABLE sessions ADD COLUMN paired INTEGER NOT NULL DEFAULT 0;
