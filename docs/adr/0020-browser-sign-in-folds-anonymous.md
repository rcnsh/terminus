# A browser signing in folds its anonymous account into the email's; only the apps ask

A browser can use terminus without an email (`POST /api/auth/anon/web`, "Use terminus without an email", for an iPhone with no app), so signing in from it can meet an email that already has an account, each with its own setup. The apps meet the same case and ask which setup to keep (`choose`, then `POST /api/auth/app/merge`): a phone's setup can hold a term's timetable, favourites and pinned stops, and losing either side unasked would cost real work.

A browser doesn't ask (`claimEmail` in `src/accounts/accounts.ts`). A new email goes to the browser's account, setup and all. An email that has an account already wins: the browser's setup moves to it only when the account has none of its own, and the browser's anonymous account is deleted, its reports moved with it. A browser's setup is a minute to redo, and a question at the end of the email sign-in, on a page reached from a link, would be one more step where people drop off. The changes run in the sign-in's own D1 batch, guarded by its link or code being unspent, so a failure part way leaves both accounts as they were.

The browser's anonymous account is the app's kind of account, made as a web session. A browser can run Turnstile, so it does, on top of the per-IP and global limits the apps' first launch has (`RL_AUTH`, `RL_ANON`); the cron's 60-day sweep deletes either kind left unused.

We considered asking in the browser as the apps do, and always keeping the email account's setup. The first adds a page for the rare case of two real setups; the second throws away a setup made before the account had one, which is the common case when someone tries the web app first and signs in later.
