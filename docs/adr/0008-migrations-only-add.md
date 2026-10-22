# D1 migrations only add, and applied ones are frozen

The old Worker keeps running on the new schema until a deploy lands, and D1 cascades deletes when a referenced table is dropped: migration 0006 had to rebuild `users` and the five tables that reference it (24d70888). From 0007 on, migrations may not rename, drop or add `NOT NULL` without a default unless they say `-- contract:`. A column change goes expand, backfill, contract. Applied migrations are locked by hash (cbab92e6), and `test/deploy.test.js` enforces both.
