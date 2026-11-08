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
