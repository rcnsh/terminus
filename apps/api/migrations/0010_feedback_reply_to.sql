-- An address to reply to, typed on the Feedback page by an account without
-- an email of its own. Not checked: it is only ever shown to the operator.
ALTER TABLE feedback ADD COLUMN reply_to TEXT;
