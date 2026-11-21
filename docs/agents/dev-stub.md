# The dev stub

`apps/api/scripts/dev/dev-stub.mjs` runs the real Worker under Node with:
- a fake NUS feed. Arrivals are made up; three buses per service drive round
  each route line, moving every 18 s like the real feed.
- an in-memory D1;
- the test account `you@u.nus.edu`. Sign-in codes and links print to the
  stub's stdout. Its profile: home stop PGP, favourites KR MRT, UTown and
  Gym, a class (GEA1000 at UTown) `CLASS_IN_MIN` (50) minutes after the
  clock starts, and pairing codes `TEST67`, `TEST78` and `TEST89`. It is
  saved at version 1, as a saved profile is (0 means none, and a page
  saving with `If-Match` could never save over it).
- crowd history saying every bus at PGP is usually packed, so the full-bus
  warning shows.
- a fake LTA DataMall: each public bus at the stop about every 10 minutes,
  a third from the timetable (`Monitored` 0), as the real feed does at night.
- a fake NUSMods: every module has a Monday lab, a Tuesday online tutorial
  and a Wednesday off-campus lecture; `XX9999` is not offered and
  `DOWN1000` answers 502.
- the map's files from `dev/map/` when it's there (`scripts/map-tiles.sh
  --dry-run`, then copy `build/map` to `dev/map`), standing in for R2, byte
  ranges included. `latest.json` names this version, with no app files.
- real FCM pushes when `.private/fcm-service-account.json` is there (the
  real Firebase project, so they reach a real device; each send logs its
  status only). Web Push gets a fresh VAPID key each run, and a browser
  subscribed to an old one subscribes again.
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
(a phone on the same Wi-Fi), and `PORT` moves it from 8787. It listens on
127.0.0.1 and ::1 (the first alone without IPv6). `STUB_TLS=<dir with
localhost.key and localhost.pem>` serves it over HTTPS on `PORT + 1` too,
for a page that needs a secure origin (Web Push on iOS): trust the
certificate's CA on the device first, and a phone needs `STUB_HOST`.

- `POST /__stub/freeze` and `/__stub/thaw` stop and restart the clock (light
  and dark screenshots of one moment); `POST /__stub/skip?min=N` moves it
  ahead, to walk through a trip. `at`, `hours` and `reset` also forget what
  the edge cache and feed gates hold, since an answer fetched at a later
  time would stay fresh for good once the clock goes back.
- Every reply's `Date` header carries the stub's clock, which the apps set
  their clock by. The recorder's alarms fire on time, and its starting cron
  runs every minute rather than every 15.
- `GET /__stub/trips` shows each Trip object's alarm and storage;
  `GET /__stub/push` which sessions take push (tokens masked).
- WebKit (iOS Safari, the installed web app) keeps no `Secure` or `__Host-`
  cookie over plain http, even on localhost, so the stub sends the session
  cookie as `tm_dev` and renames it back for the Worker.
- The Mac app takes `TERMINUS_API_BASE=http://localhost:8787`; an Android
  debug build can be built with `./gradlew installStableDebug
  -PapiBase=http://localhost:8787`.
- The dashboard's made-up Analytics Engine rows (`fakeAeRows` in
  `stub-admin.mjs`) take their column names from `analytics-rows.ts`, the
  declaration admin.ts queries by, so a moved column moves in the stub too.

It serves `apps/web/public` from disk, so a reload shows your change. Check
web UI changes against it in headless Chromium and screenshot them:
`node apps/api/scripts/dev/shot.mjs <url> <out.png>` (`--scheme dark`,
`--width 390` for a phone, `--wait <selector>`, `--operator dev` for the
dashboard signed in). Playwright is pinned in the root `package.json`; its
browser once: `pnpm exec playwright install chromium-headless-shell`. For
clicks and typing, write a script on the same `playwright` import. The admin
dashboard token is `dev`.
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

## Running an app against it

Point the app at the stub before its first launch: a debug build otherwise
starts on terminus.run, and its first answers come from NUS (rule 2). Give
each agent its own `PORT` and stop only the stub you started, by its PID.

- **iPhone (Simulator, debug build):** the app reads `TERMINUS_*`
  variables from its environment (the list and what each does are in
  `DevLaunch`, `apps/ios/Sources/App/TerminusApp.swift`). Set them in the
  simulator's launchd, then launch the app:

  ```sh
  TOK=$(curl -s -X POST http://127.0.0.1:$PORT/__stub/session | python3 -I -c 'import sys,json; print(json.load(sys.stdin)["token"])')
  for kv in TERMINUS_API_BASE=http://127.0.0.1:$PORT TERMINUS_RESET=1 TERMINUS_TOKEN=$TOK TERMINUS_EMAIL=you@u.nus.edu TERMINUS_LANG=en; do
    xcrun simctl spawn <udid> launchctl setenv "${kv%%=*}" "${kv#*=}"
  done
  ```

  `TERMINUS_TOKEN` signs it in without the code; `TERMINUS_RESET=1` starts
  from a fresh install. They last until the simulator restarts: afterwards,
  `launchctl unsetenv` each one, so the next run on that simulator isn't
  pointed at a stub that's gone. `scripts/ui-tests.sh` starts and stops a
  stub of its own and needs none of this, but it runs only on a simulator
  in Xcode's own set, not on one leased from Simlock.
- **Android (emulator, debug build):** the app's stub server is always
  `http://localhost:8787`; map it to yours with
  `adb -s <serial> reverse tcp:8787 tcp:$PORT`, then choose
  `http://localhost:8787` under Developer at the bottom of Settings, About
  (always there in a debug or beta build). `adb reverse --remove tcp:8787`
  afterwards.
- On a device leased from [Simlock](https://callstackincubator.github.io/simlock/docs/introduction),
  run these through it instead: `simlock simctl …` for `xcrun simctl …`,
  `simlock adb …` for `adb …`.
- A fresh worktree has no `node_modules`: `pnpm install` before starting
  the stub, and `curl http://127.0.0.1:$PORT/` before launching anything.

## The README's pictures

`docs/readme/` holds each picture's page and the script that renders it,
light and dark, to WebP (`cwebp`) in a headless Chromium (Playwright's, or
`CHROME`; `PLAYWRIGHT=<path>/node_modules/playwright` if it isn't
resolvable). Each page is light by default and dark with `#dark`, in the
site's own tokens and fonts.

- `node docs/readme/shots.mjs` takes the screenshots from the real site
  under the stub: Now, the Stops tab with two stops pinned (as the store
  screenshots have), and the map with D2 picked. It adds a phone's room
  under the tab bar, which a browser window lacks, so the frames don't
  clip the bar's end labels. Take them in Singapore's daytime (the stub's
  class is 50 minutes from the real clock and the sky follows the real
  hour), or give the stub and the pages a morning:
  `STUB_NOW=2026-10-09T01:26:00Z CLASS_IN_MIN=34 SHOTS_AT=2026-10-09T01:26:00Z`.
- Then the pictures composed from them: `node docs/readme/hero.mjs`
  (`hero.html`, the banner: every client on the campus map under the
  sky) and `sh docs/readme/features.sh` (`clients.html` and `knows.html`,
  on a transparent background so they sit on GitHub's).
- `sh docs/readme/diagram.sh` (`diagram.html`, "How it fits together"),
  `sh docs/readme/loc.sh` (`loc.html`: the lines of code from
  `pnpm loc --json`, passed in the address as base64, so the page holds no
  counts of its own) and `sh docs/readme/render.sh` (`banner.html#og`, the
  site's 1280x672 link preview, `apps/web/public/assets/og.png`).
- `pnpm loc` counts the non-blank lines of the files git tracks, by part
  and language, leaving out vendored code, lockfiles, test fixtures and
  bundled data (`NO_COLOR` turns its colours off).
