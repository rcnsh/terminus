-- Push to the iPhone app (src/apns.ts). push_token takes its `apns:` token
-- like any other; beside it, the token of the trip's Live Activity while one
-- runs (`apnsla:`), the language the iPhone's notifications are worded in,
-- and whether its leave alerts are on (0: the trip's pushes are silent; NULL:
-- not said, as from a build before the setting was sent, so alerts as
-- before). NULL for every other device.
ALTER TABLE sessions ADD COLUMN live_token TEXT;
ALTER TABLE sessions ADD COLUMN push_lang TEXT;
ALTER TABLE sessions ADD COLUMN push_alerts INTEGER;
