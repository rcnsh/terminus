-- Whether an iPhone shows 12-hour times (1) or 24-hour (0), as it said when it
-- registered its `apns:` token: the Trip object words that iPhone's
-- notifications and Live Activity with it when the account follows each
-- device's clock (src/push/push.ts). NULL for every other device, and for an
-- iPhone that hasn't said.
ALTER TABLE sessions ADD COLUMN push_h12 INTEGER;
