-- Push to the iPhone app (src/apns.ts). push_token takes its `apns:` token
-- like any other; beside it, the token of the trip's Live Activity while one
-- runs (`apnsla:`), and the language the iPhone's notifications are worded
-- in. NULL for every other device.
ALTER TABLE sessions ADD COLUMN live_token TEXT;
ALTER TABLE sessions ADD COLUMN push_lang TEXT;
