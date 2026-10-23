# Shared fixtures

What the API answers and what every client is held to, in one place: the
API's tests write or check them, and the website's, Android's, the Mac's and
the iPhone's tests read them, so a change in one shows up in all.

- `answers/`: golden answers (`UPDATE_GOLDEN=1 pnpm test` rewrites them);
  `answers/zh/` the Chinese, checked word for word.
- `offline-day.json`: what each app shows offline from a kept day plan
  (`answers/day.json`).
- `live-activity.json`: the iPhone Live Activity's state the server pushes
  for each golden answer under way, which the app's own must equal
  (`apns.test.js` writes it with `UPDATE_GOLDEN=1`).
- `search.json`: the destination search's ranking rules and cases, which
  the website's `search.js` and the apps' searches are all held to.

The API's own fixtures (feed captures, the migrations' hashes) are in
[apps/api/test/fixtures](../apps/api/test/fixtures).
