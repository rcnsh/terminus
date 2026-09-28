-- Public beta: sign-up is open, so the invite list becomes a blocklist.
-- Its old rows were invitations, not blocks, so they are cleared first.
DELETE FROM invites;
ALTER TABLE invites RENAME TO blocklist;

-- Home is stored as stops only. Strip coordinates saved before this change.
UPDATE profiles SET json = json_remove(json, '$.home.lat', '$.home.lon') WHERE json_extract(json, '$.home') IS NOT NULL;
