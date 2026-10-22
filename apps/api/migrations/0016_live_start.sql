-- An iPhone's token to start its trip Live Activity by push (ActivityKit
-- push-to-start, `apnsstart:`; src/apns.ts), kept while its Live Activity
-- setting is on. NULL for every other device, and for an iPhone that hasn't
-- sent one.
ALTER TABLE sessions ADD COLUMN start_token TEXT;
