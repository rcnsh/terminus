# The dev stub

`apps/api/scripts/dev/dev-stub.mjs` runs the real Worker under Node with:
- a fake NUS feed. Arrivals are made up; three buses per service drive round
  each route line, moving every 18 s like the real feed.
- an in-memory D1;
- the test account `you@u.nus.edu`. Sign-in codes and links print to the
  stub's stdout.
- the timelapse recorder on the fake buses. `POST /__stub/timelapse?minutes=N`
  records N minutes at once, moving the clock ahead. Then open
  `/admin/#/timelapse` (token `dev`).
- made-up numbers for the dashboard (`/admin/`, token `dev`): accounts,
  answers, crash reports, reports and arrival-time scores
  (`scripts/dev/stub-admin.mjs`). `STUB_ADMIN=empty` shows it as a new install
  would.
- every service running at any hour, unless `STUB_HOURS=real` (real hours,
  and no buses or times outside them). `STUB_NOW=2026-10-07T13:30:00Z`
  starts the clock there (a Wednesday 21:30 in Singapore: R1 and R2 have
  stopped); `POST /__stub/at?t=<ISO>` moves it. `POST /__stub/hours?real=1`
  switches the real hours on at runtime, `POST /__stub/class?in=N` puts the
  test class N minutes ahead, and `POST /__stub/reset` puts the clock and
  hours back: the iPhone's UI tests set what each suite needs with these.

It listens on loopback only; `STUB_HOST=0.0.0.0` opens it to the network
(a phone on the same Wi-Fi), and `PORT` moves it from 8787.

It serves `apps/web/public` from disk, so a reload shows your change. Use it
with a headless browser (Playwright plus Chromium) to check web UI changes,
and take screenshots for UI changes. The admin dashboard token is `dev`.
Street-map tiles are absent unless you put a map in `dev/map/`; routes and
stops still draw.

- Polling pages never reach "network idle" in Playwright: wait for a URL or
  an element instead.
- Block service workers in Playwright (`serviceWorkers: 'block'`), or the
  web app's service worker can serve a file from before your edit.
- The stub sends a sign-in code only once per email for a while (later
  requests say "sent" but print nothing, as the real server does). Sign in
  once, keep the session cookie (`context.cookies()`) and reuse it, or
  restart the stub.
