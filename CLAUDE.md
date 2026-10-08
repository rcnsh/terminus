# CLAUDE.md

Guidance for AI agents working in this repo. Read it before you change
anything; the deeper "why" is in [apps/api/docs/internals.md](apps/api/docs/internals.md).

## What terminus is

terminus answers one question for NUS students: **which shuttle bus do I
catch, from which stop, and when do I leave (or is walking faster)?** It reads
the user's NUSMods timetable, NUS's live shuttle feed, the NUS calendar and
campus walking paths. It also has a campus map with live buses.

It runs on one Cloudflare Worker (`apps/api`), which does **all** the thinking.
Clients are thin:

| Client | Path | Stack |
| --- | --- | --- |
| API + website host | `apps/api` | TypeScript on Cloudflare Workers (D1, KV, R2, Durable Objects, Analytics Engine, Email) |
| Website + web app | `apps/web/public` | Preact + htm (vendored), CSS, **no build step**, served by the Worker |
| Android app + widgets | `apps/android` | Kotlin, Jetpack Compose, Glance, maplibre-compose |
| Mac menu bar app | `apps/macos` | SwiftUI, Sparkle updates, MapLibre Native (map window) |

Live at https://terminus.rcn.sh (API docs at `/docs`); beta at
https://beta.terminus.rcn.sh. It's an independent student project, not
affiliated with NUS.

## The rules that matter most

1. **The server computes the answer.** `/me/next`
   returns a ready-made card (labels, times, which bus). Clients only count
   down the clock. Never move logic into a client: four clients would then
   drift apart.
2. **Don't add load on NUS.** Arrivals are cached 15 s per stop
   (`TTL.arrivalsMs`), live buses 5 s per service (`TTL.busesMs`), all in
   `src/config.ts`. Never lower these, poll in bulk, or scan for endpoints.
   Upstream failures back off (`failMemoS`, `breakerS`): a refused version
   or key, a 429 or 5xx from a NUS host, or no answer at all (a timeout,
   a failed connection), opens the breaker; a failed token mint isn't
   tried again for `failMemoS`; a refused call is retried once, with a
   token minted at most once a minute (`remintGapS`). These limits hold
   per Cloudflare data centre, whose cache every isolate there shares.
   The same goes for LTA DataMall, the public buses' feed (`src/lta.ts`):
   one call per stop per 15 s, through the same cache
   (`src/edgecache.ts`).

   **One exception: the timelapse recorder**
   (`src/timelapse.ts`, `src/timelapsedo.ts`). It is the only code that
   polls the NUS feed on a schedule rather than on request. Its limits:
   - **Rate:** each service's live buses once per `TIMELAPSE.pollMs` (30 s),
     spread across that time, never below `MIN_POLL_MS` (15 s, enforced in
     code). Arrivals are never polled.
   - **Path:** `getBuses()`, the map's own path, so the 5 s cache,
     `failMemoS` and the breaker all apply. An open breaker skips the poll.
   - **Hours:** `TIMELAPSE.hours` (06:30 to 00:30 Singapore time), and only
     services inside their own operating hours. It stops early when no bus
     is out.
   - **Kill switch:** KV `config:timelapse` = `off` stops it within a round,
     without a deploy. Otherwise the `TIMELAPSE_ENABLED` var applies: on for
     the stable site, off for the beta, off when unset.

   - **Back-off:** after a round in which no service answered, the next
     waits 2, 4, then 8 times as long.

   At most 17,280 polls a day (`TIMELAPSE.maxPollsPerDay`, enforced in
   code: more routes in `stops.json` lengthen the interval), and every
   request counted on the dashboard (a retry inside a poll too). Don't add another poller, don't widen this one's
   hours or rate, don't point it at arrivals or LTA, and don't reuse its
   alarm for anything else that calls NUS.

   Two other scheduled reads exist, small and bounded; don't grow them.
   The stable Worker's 15-minute cron health check asks NUS for one stop
   and LTA for one stop each run, past the cache on purpose
   (`src/monitor.ts`). While NUS refuses our uNivUS version, the same check
   reads Google Play and APKCombo at most hourly and tries at most three new
   version strings on that stop per run, never one twice
   (`src/appversion.ts`). The beta's cron makes no health check: it reads
   the breaker trips its own traffic noted (`src/feedwatch.ts`), and runs
   the version search only while NUS is refusing the beta. Each push
   user's Trip object (`src/tripdo.ts`) wakes at most every 30 s to
   recompute the card, asking for its stops through the cache.
3. **`normalize()` / `normalizeBuses()` in `src/fms.ts` are the only code that
   touches the raw feed shape.** The feed is undocumented and changes, so
   they're tolerant and everything downstream assumes clean types. When the
   feed shifts, edit only there. `normalizePublic()` in `src/lta.ts` is the
   same for DataMall's shape.
4. **Secrets never go in git or in output.** NUS feed keys and the LTA DataMall
   account key live in `apps/api/.dev.vars` locally and as Worker secrets in
   production. All are gitignored, along with `dev/` (captured traffic), `.private/`, keystores,
   `*.p12`/`*.pem`/`*.key` and `apps/android/app/google-services.json`.
   Never print secret values, and never use NUSNET credentials: the feed uses
   a public guest token.
5. **Every user-facing string is in English and Simplified Chinese.** Tests
   fail without the Chinese. See "English and Chinese" below.
6. **No model identifiers** (Claude model names and IDs) in commits, code,
   comments or docs.

## Commands

```bash
pnpm install                          # Node 24 as in CI (22.18 or later works), pnpm from packageManager
pnpm test                             # API tests: Node's runner, no network, no keys
pnpm check                            # tests + tsc --noEmit (what CI's api job runs)
pnpm lint                             # oxlint over API, tests, scripts, website JS; warnings fail
node apps/api/scripts/dev-stub.mjs    # local Worker on :8787 with a fake feed and fake buses
```

- Run `pnpm lint` **and** `pnpm check` after your **last** edit, not before
  it. A stray `'` inside a single-quoted TS string (`doesn't`) has broken the
  build before. In `src/openapi.ts` and similar, write `does not` or use `’`.
- CI's `api` job also runs `pnpm exec cf deploy --dry-run` in `apps/api` to
  catch modules workerd won't load.
- Website JS: CI runs `node --check` on every file in `apps/web/public`.
- Android (CI): `./gradlew :app:lintStableDebug :app:testStableDebugUnitTest :app:compileBetaDebugKotlin`,
  then `:app:assembleStableRelease :app:assembleBetaRelease` (R8 and
  resource shrinking, debug-signed without the keystore) in `apps/android`
  (Java 21).
- Mac (CI, macOS runner): `swift build && swift test`, then
  `swift build -c release --arch arm64` in `apps/macos`.
- In a Linux cloud container without the Android SDK or Xcode, you can't
  build those apps. Check pure-Kotlin logic another way if you can (for
  example `MapData.kt` with its JUnit test, using a standalone `kotlinc`
  plus `org.json` and JUnit jars), then let CI build the app. List
  what you couldn't run.

### The dev stub

`apps/api/scripts/dev-stub.mjs` runs the real Worker under Node with:
- a fake NUS feed. Arrivals are made up; three buses per service drive round
  each route line, moving every 18 s like the real feed.
- an in-memory D1;
- the test account `you@u.nus.edu`. Sign-in codes and links print to the
  stub's stdout.
- the timelapse recorder on the fake buses. `POST /__stub/timelapse?minutes=N`
  records N minutes at once, moving the clock ahead. Then open
  `/admin/timelapse/` (token `dev`).
- every service running at any hour, unless `STUB_HOURS=real` (real hours,
  and no buses or times outside them). `STUB_NOW=2026-10-07T13:30:00Z`
  starts the clock there (a Wednesday 21:30 in Singapore: R1 and R2 have
  stopped); `POST /__stub/at?t=<ISO>` moves it later.

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
- The service worker fetches the app's files from the network first, so an
  edit reaches users without anything else. When the list of files it keeps
  (`SHELL_FILES` in `apps/web/public/sw.js`) changes, bump `SHELL` too, so the
  old copy is dropped.
- The stub sends a sign-in code only once per email for a while (later
  requests say "sent" but print nothing, as the real server does). Sign in
  once, keep the session cookie (`context.cookies()`) and reuse it, or
  restart the stub.
- Against the live sites (terminus.rcn.sh, the beta), Chromium's own
  connections through the container's proxy fail at random
  (`ERR_TOO_MANY_RETRIES`) and its trust store may predate the proxy's
  certificate. Route the page's requests through Node instead
  (`context.route` with `fetch`, run with `NODE_USE_ENV_PROXY=1`), and use
  a temporary anonymous account (`POST /auth/anon`, then `DELETE /me`).
- The container has Chromium only (`/opt/pw-browsers/chromium`), no WebKit;
  don't run `playwright install`. For Safari, use a one-off workflow
  (Playwright WebKit on Linux, or an iOS Simulator on a macOS runner).

### Working from a cloud session

- **CI logs** can't be downloaded from the container (the log host is
  blocked). Read them with the GitHub tool `get_job_logs`
  (`return_content: true`); step results are in `gh api
  repos/rcnsh/terminus/actions/runs/<id>/jobs`.
- **Artifacts** can't be downloaded either; the owner opens them on GitHub.
  For evidence of a UI change in the apps, a one-off workflow can record an
  emulator (`adb shell screenrecord`) or render the Mac's snapshots
  (`TERMINUS_SNAPSHOT=<dir> swift run`, on `macos-latest`). Remove it once
  it's been watched.
- **Android strings** need apostrophes escaped (`\'`).

## Repo map

```
apps/api/
  src/index.ts        Router; most endpoints live here or in me.ts
  src/me.ts           /auth, /pair, /me/* (accounts)
  src/next.ts         /me/next: the plan, free days, riding, the trip's phase
  src/answer.ts       The answer engine: stops near you, arrivals, the best option, worded
  src/card.ts         What every client shows, worded once (the card's lines)
  src/plan.ts, leave.ts  Which bus a trip is about; when to set off
  src/profile.ts      The saved setup (validated) and the planner; day.ts is /me/day
  src/nusmods.ts      NUSMods timetable import
  src/walk.ts         Walking times along campus paths (walks.json)
  src/crowd.ts        Full buses, tallied as the Worker answers
  src/resolve.ts      Stop + bus choice: haversine, directional pairing, scoring
  src/format.ts       Labels/details and the degrade ladder (live → scheduled)
  src/fms.ts          NUS feed client + normalisation (see rule 3)
  src/lta.ts          LTA DataMall client: the public buses at a stop (see below)
  src/graph.ts        The stop graph: stops.json with hand-kept hours and opposites; GRAPH_PUBLIC
  src/public.ts       Public buses in the graph: withPublic, route keys, ride metres
  src/edgecache.ts    Fetch through the edge cache, stale on failure, breaker: both feeds
  src/auth.ts         Guest token mint, KV memo, app-version breaker
  src/appversion.ts   Tracks the uNivUS app version the feed demands
  src/buses.ts        /buses: live buses placed on their route line (see below)
  src/timelapse.ts, timelapsedo.ts  The timelapse recorder (rule 2's one exception)
                      and /timelapse/days; one Durable Object per Singapore day
  src/campus.ts       /campus: stops, route lines, colours, destination search
  src/map.ts          /map/*: PMTiles street map, style, fonts, sprites from R2
  src/accounts.ts     Sign-in codes/links, sessions, anonymous accounts, pairing (D1)
  src/applogin.ts     App sign-in approved from the email (RFC 8628-like)
  src/trip.ts, tripdo.ts  Per-user Durable Object with today's trip signals
  src/outcomes.ts     How each trip went (taps, Not going) and what it suggests
  src/monitor.ts      15-minute cron: feed health, incidents, housekeeping
  src/feedwatch.ts    The beta's feed health, from breaker trips its traffic noted
  src/calendarsync.ts The academic calendar, refreshed into KV by the cron
  src/push.ts, webpush.ts  Push: FCM to Android, Web Push to the installed web app
  src/access.ts       Who may call the keyed routes (an API key or a session)
  src/admin.ts        /admin/stats for the dashboard; analytics.ts logs to Analytics Engine
  src/feedback.ts     "This was wrong" reports, stored and emailed to the operator
  src/downloads.ts    App downloads from R2 (latest.json, the APKs, the DMG, the appcast)
  src/landing.ts, site.ts, pagesky.ts  The landing page; stable or beta; the small pages' sky
  src/types.ts        Env (the bindings) and the shared types
  src/openapi.ts      OpenAPI 3.1 spec + docs page (a test fails if routes drift from it)
  src/http.ts         JSON helpers, CORS, security headers (CSP lives here)
  src/seo.ts          robots.txt, the sitemap, /llms.txt for AI agents (the beta asks not to be crawled)
  src/i18n.ts         Server strings, m(), ERRORS_ZH
  src/config.ts       TTLs and tuning constants (WALK, RIDE, ...)
  data/               Bundled JSON: stops.json (graph), shapes.json (route lines),
                      public.json (public buses), calendar.json, walks.json,
                      venues/rooms/landmarks/residences; hand-kept: service-hours.json,
                      opposites.json (stops across the road the scrape can't pair)
  migrations/         D1 schema, numbered NNNN_name.sql
  scripts/            dev-stub.mjs; predeploy.mjs (first step of a deploy); scrapers (scrape_stops.py, scrape_lta.py,
                      route_shapes.py, fetch_calendar.py, walk_routes.py,
                      check_scraped.py);
                      probe_buses.py (feed update-rate probe); record_buses.mjs (checks /buses on a live site);
                      render-timelapse.mjs (renders a recorded day headless, e.g. on a VPS);
                      vapid-key.mjs (makes the Web Push key, once)
  test/               *.test.js + worker.smoke.js; _stubs.mjs, _d1.mjs (D1 on node:sqlite)
  test/fixtures/answers/   Golden answers, shared with the Android and Mac tests
  cloudflare.config.ts     Worker config (stable + beta via --mode beta)
  wrangler.config.ts       Website assets directory
  docs/internals.md        How everything works, in depth; docs/analytics.md
apps/web/public/
  index.html          Landing page
  account/            The account page (app.js): sign-in, onboarding.js, settings.js +
                      settings-pages.js (Settings, shared with the app), preview.js (the
                      card), profile.js (the profile and /campus, shared), search.js
                      (ranking, tested) + search-box.js; journey.js (the card styles,
                      as on Android); dom.js has t, api, clock; sky.js (Now's sky
                      and horizon), daylight.js (its colours by the hour), livery.js
                      (the services' stripes)
  app/                Installed web app: app.js (Now, tabs), buses.js (Buses tab), map.js
                      (Map tab), map-files.js, offline.js
  admin/, status/, pair/, privacy/ (the summary; privacy/policy/ the full policy;
                      each with zh/), not-found/ (the Worker's 404 page)
  admin/timelapse/    Replays a recorded day on the map and exports a video
                      (replay.js, shared with the API tests; Mediabunny encodes)
  assets/             ui.js (Preact, hooks, htm, stores), site.css (shared colours/type),
                      i18n.js, zh.js (Chinese), theme.js, landing.js, docs.js (/docs),
                      tabbar.css (the app's bar), fonts.css + fonts/ (self-hosted), shots/;
                      sky.css + sky-phase.js + sky-page.js: the app's sky on the site's pages
  vendor/             Preact + htm (scripts/vendor-preact.sh), MapLibre GL + PMTiles
                      (scripts/vendor-map.sh), Mediabunny (scripts/vendor-mediabunny.sh):
                      never hand-edited, not linted
  sw.js               Service worker: offline app shell and map
apps/android/app/src/main/java/sh/rcn/terminus/
  Api.kt              API client and answer types
  MapData.kt          Map data, GeoJSON, RoutePath + Slides (bus animation); JVM-tested
  MapFiles.kt         Street map file kept for offline
  ui/                 Screens (MainScreen, MapScreen, Settings, Onboarding, ...)
  widget/             Glance widgets and their refresh schedule
  LeaveAlerts.kt, LiveService.kt, Push.kt   Notifications and FCM
apps/macos/
  Sources/Terminus/   Api.swift, AppModel.swift (state/refresh/pairing), views, Updater.swift,
                      MapWindow.swift + MapData.swift + MapFiles.swift (the map window)
  Vendor/             MapLibre.xcframework.zip, from scripts/vendor-maplibre-mac.sh
  Support/            Info.plist (version, SUPublicEDKey), zh-Hans strings, app icons
  Tests/              swift test, on the API's answer fixtures
  build.sh            Builds terminus.app (CHANNEL=beta for the beta)
scripts/              release.sh, release-beta.sh (+ release-lib.sh, their shared checks;
                      verify-sparkle.swift), github-release.sh, package-mac.sh,
                      appcast.py, release-notes.py, map-tiles.sh (+ map-tiles.lock),
                      vendor-map.sh, vendor-maplibre-mac.sh, vendor-preact.sh,
                      vendor-mediabunny.sh
.github/workflows/    ci.yml, scrape.yml (weekly data),
                      map-tiles.yml, probe-buses.yml (manual feed probe),
                      record-buses.yml (manual: no bus switches sides after a deploy)
```

## How the core works (short version)

- **Data graph.** `data/stops.json` (stops, route order, operating hours) is
  scraped weekly by `scrape.yml` → `scripts/scrape_stops.py`, along with
  `shapes.json` (route lines from OpenStreetMap via Overpass) and
  `calendar.json`. The workflow is three jobs: `scrape` holds the feed
  secrets and runs only the repo's standard-library Python; `test` runs the
  tests and `check_scraped.py` with no secrets; `commit`, the only job that
  can push, runs no npm code and fast-forwards main to a data-only commit
  on top of the tested one (if main moved, it pushes nothing: run it
  again). `check_scraped.py` compares with HEAD and fails on a stop moved
  over 100 m, a changed stop order, any item lost from a list under 20,
  odd names, or a moved semester; such a change is committed by hand. A failed
  shapes, public-buses or calendar refresh keeps the committed file and
  shows as a warning on the run. The data is bundled into the
  Worker, so a data change needs a deploy. The calendar is the exception:
  the cron also fetches it weekly into KV (`src/calendarsync.ts`), so it
  doesn't run out when nobody deploys.
- **Answering.** `resolve.ts` picks candidate stops near the user, pairs each
  stop with its twin across the road, checks the bus goes downstream to the
  destination, and scores the options by arrival time. Rides are
  `RIDE.secondsPerHop` a stop, no faster than `RIDE.longHopMs` over a long
  stretch (`RIDE` in config). Walking is
  recommended only when it beats the bus by `WALK.beatsBusByS`.
- **Quality ladder.** Each answer says how sure it is: `live`, `scheduled` (a
  headway guess inside operating hours, labelled as such), and so on. Never
  label a guess as live.
- **Feed etiquette.** The feed answers through a 15 s edge cache per stop.
  On failure it serves a stale answer if one exists (up to `staleMaxS`), and
  a failed stop isn't asked again for `failMemoS`. A version or key
  rejection, a 429 or 5xx, or no answer at all (a timeout, a failed
  connection) trips a breaker. The uNivUS version string must track the
  Play Store; KV `config:appVersion` overrides the secret.
- **Accounts.** D1. Sign-in is by emailed code or link. Apps get a device
  token: anonymous on first launch, then sign-in approved from the email, or
  pairing codes. Rate limits are Workers rate-limit bindings (`RL_*`). The
  cron deletes anonymous accounts unused for 60 days.
- **Live buses (`/buses`, `src/buses.ts`).** NUS's feed moves a bus about
  every 15–20 s (measured with the `probe live-bus feed` workflow).
  - Many routes use the same road both ways, so the two directions of the
    line are metres apart (often on the same points) and GPS can't choose.
    Each bus has a **track**, its last place along the line. A new position
    counts only where the bus could have driven to since, so its next stop
    only moves forward and it keeps its side (`follow`). With no track, its
    heading, then the stop it's standing at, then distance decide. The track
    gives way after two moving fixes heading the other way.
  - Tracks are kept in the edge cache with the placed buses
    (`trackedBuses`), so every instance answers the same. Placing is a pure
    function of the update, its time and the tracks.
  - The readings are too far apart and noisy to draw a bus where it is, so
    it's shown **at a stop or between two** (`sectionOf`): within 40 m of a
    stop along its line, at that stop's dot (`at`, `slot` when several are
    there); otherwise halfway between the stop it passed and the next, or
    spread evenly with several (thirds for two). On the same stretch, a
    bus's spot never moves backwards; it waits where it was. Between stops it comes with its `stretch`, which a tapped bus
    highlights, so the midpoint isn't read as its position. A bus over 50 m off its line isn't shown.
  - Clients poll every 5 s. A bus at a stop is drawn a few pixels beside
    the dot, on the kerb side (left of its heading), the ones behind it
    further back; a bus that changes place slides there along the line in
    1–4 s, longer the further it goes (web `map.js` `moveTo`;
    Android `Slides`), or jumps.
  - `test/fixtures/bus-trace.jsonl` is a real feed trace (the probe
    workflow with `trace`); `buses.test.js` replays it.
  - Each bus comes with its number plate (`plate`, shown on its card on
    the map); `id` is a hash, stable while it runs.
- **Public buses (`src/public.ts`, `src/lta.ts`, `data/public.json`).** Off
  by default; an account turns them on (`publicBuses` in the profile). The
  public buses that call at the campus's stops (95, 151, 96 and others, from
  LTA DataMall via `scripts/scrape_lta.py`, weekly) join a second graph,
  `GRAPH_PUBLIC`, used only when asked: a public stop on a shuttle stop's
  shelter is the same stop with a `publicCode`; a stop of its own keeps
  LTA's five-digit code. A two-way service is two routes, `151/1` and
  `151/2`, shown as `151` (`svcName()`). Ride time comes from metres along
  the route (`along`) rather than a count of stops. A public bus is the headline
  only when it beats the free bus by `PUBLIC.fareWorthS`; its leg carries
  `paid: true`, and a timetabled time (LTA's `Monitored: 0`) is
  `scheduled`, never `live`. The map shows no public buses.
- **Timelapse (`src/timelapse.ts`, `src/timelapsedo.ts`).** Rule 2's one
  exception: a Durable Object per Singapore day records every service's
  buses every 30 s through `getBuses()`, inside 06:30 to 00:30, and writes
  the day to R2 (`timelapse/YYYY-MM-DD.json.gz`) at the close.
  `/admin/timelapse/` replays a day (`replay.js`, which the tests share) and
  exports a video with Mediabunny, frame by frame. Details in internals.md.
- **Map.** `/campus` returns stops and route lines. The street map is a
  PMTiles extract on R2, in each site's own downloads bucket
  (`terminus-downloads`, `terminus-beta-downloads`), uploaded by the
  `map tiles` workflow or `scripts/map-tiles.sh` (`CHANNEL=stable|beta|both`).
  What goes up is pinned in `scripts/map-tiles.lock` (the Protomaps build,
  the basemaps-assets commit, SHA-256s of the cut and of every font and
  icon); nothing uploads unless it matches. To refresh: `scripts/map-tiles.sh
  --update`, review and commit the lock, then run the workflow within a few
  days (Protomaps keeps a build about a week). Its schedule only checks for
  a newer build. The style is Protomaps basemaps without
  points of interest, with every URL on our own domain.

## English and Chinese

- **API:** use `m()` from `src/i18n.ts`. Errors stay English in the code
  (`json({ error: '...' })`) and get an entry in `ERRORS_ZH`. The Chinese
  goldens in `test/fixtures/answers/zh` are checked word for word.
- **Website:** use `t('English {0}', value)`, in templates too
  (`${t('Go there')}`, never bare words). The Chinese, keyed by the English,
  goes in `apps/web/public/assets/zh.js`; `web-i18n.test.js` checks it, and
  fails on English written straight into an `html` template. A sentence
  with a link inside uses `Rich`; one with a node in a blank (an email in
  bold, a button) uses `Fill` with `t('… {0} …', MARK)`.
- **Android:** `res/values/strings.xml` plus `res/values-zh/strings.xml`.
  Lint fails on a missing translation.
- **Mac:** `L("English %@", value)`, with the Chinese in
  `Support/zh-Hans.lproj/Localizable.strings`.
- Place and service names (KR MRT, COM3, D2) stay English in both.
- One glossary for all of it, at the top of `src/i18n.ts` (class 课, stop
  车站, favourite 收藏, packed 很挤, email address 邮箱, …), with a space
  between Chinese and Latin letters or digits. When you change a word, change it
  everywhere.

## Tests

- **Running them.** API tests are plain `node --test` over `test/*.test.js`,
  importing the TypeScript sources directly. Node strips the types, so the
  TS must be erasable: no enums, namespaces or parameter properties, and
  type-only imports use `import type` (`verbatimModuleSyntax`).
- **Golden answers.** `golden.test.js` pins whole answers to
  `test/fixtures/answers/`. After an intended change, run
  `UPDATE_GOLDEN=1 pnpm test` and review the fixture diff. The Android and
  Mac unit tests read the same fixtures, so a changed answer shape must
  still parse there.
- **Account tests** run the real migration SQL against `node:sqlite`.
- **Writing tests.** Add tests for API changes. Prefer tests on real data,
  such as the real `shapes.json` lines, over synthetic ones. Check a new
  test fails without your fix.
- **The spec.** Changing an endpoint's shape means updating `src/openapi.ts`
  (schema, example, description) and `docs/internals.md`.

## Deploying and releasing

- **Deploying.** `main` is **not** auto-deployed.
  - Deploy from `apps/api` with `pnpm run deploy` (not `pnpm deploy`, which
    is a pnpm built-in). It first runs `scripts/predeploy.mjs`, which
    refuses unmerged files, conflict markers or uncommitted changes in
    `apps/api` and `apps/web/public` and runs `pnpm check`; then it applies
    the stable D1's pending migrations and runs `cf deploy`. It needs
    `CLOUDFLARE_API_TOKEN`.
  - The beta is `pnpm run deploy:beta`, with its own D1, KV and R2; it
    applies the beta D1's migrations the same way.
  - By hand, a migration is applied **before** deploying:
    `pnpm exec cf d1 migrations apply <db-id>` (ids are in
    `cloudflare.config.ts`; `test/deploy.test.js` checks the scripts match).
  - Migrations must be additive, since the old Worker runs on the new schema
    until the deploy lands: no renames, drops or `NOT NULL` without a default.
    Change a column in steps (expand, backfill, contract; see
    `docs/internals.md`), and never edit a migration already applied.
    `test/deploy.test.js` enforces this: an `ALTER TABLE` that drops,
    renames or adds `NOT NULL` without a default fails unless the file has a
    `-- contract:` line, and applied migrations are locked by hash in
    `test/fixtures/migrations.sha256` (append a new one's line once it's
    applied to both databases).
  - `wrangler` is only installed in `apps/api`, so run wrangler/R2 commands
    from there.
  - Server-side changes, the website included, are live for everyone once
    deployed. Android and Mac changes need an app release.
- **Releasing.**
  - Bump Android `versionName`/`versionCode` (`apps/android/app/build.gradle.kts`),
    the Mac `CFBundleShortVersionString`/`CFBundleVersion`
    (`apps/macos/Support/Info.plist`) and `API_VERSION` (`apps/api/src/openapi.ts`,
    the version on the API docs) together. A test fails if the versions
    differ, or if `versionCode` and `CFBundleVersion` do.
  - Push `main`, wait for CI to pass, deploy the Worker (`pnpm run deploy`),
    then run `scripts/release.sh --dry-run` and `scripts/release.sh` on the
    owner's Mac. It refuses a commit that isn't `origin/main` or whose CI
    hasn't passed, a live API older than this version (deploy first), a
    build number not above the live one, an APK not signed with the key in
    `assetlinks.json`, a Sparkle signature that doesn't verify with
    `SUPublicEDKey`, an ad-hoc signed Mac app, or an `apiBase` Gradle
    property. Then it tests; builds the signed split APKs and the signed Mac
    DMG with its Sparkle appcast; uploads the APKs and the DMG to R2; tags
    and pushes `v<version>` (the appcast links to the tag's page); uploads
    the appcast and `latest.json`; and publishes the GitHub release. Nothing
    waits for an approval. A dry run builds into `build/dry-run/`; a release
    that stops partway prints what's live and the commands that finish it.
  - Betas use `scripts/release-beta.sh <x.y.z-beta.n>`, on the same Mac,
    with the same checks: also from `origin/main` with CI passed. It deploys
    the beta Worker itself and uploads nothing until that deploy has
    finished (a beta keeps `API_VERSION`, so the live API's version can't
    tell the new Worker from the old).
  - Both start from the lockfiles: they delete `node_modules` and
    `apps/macos/.build`, then install with `--frozen-lockfile` and
    `--force-resolved-versions`. The Sparkle key only goes to a `sign_update`
    matching `SIGN_UPDATE_SHA256` in `scripts/release-lib.sh`; a Sparkle bump
    means updating `SPARKLE_VERSION` and that hash (check the new zip
    against the checksum in Sparkle's `Package.swift` first). The appcast
    itself is signed too, and nothing may edit it afterwards.
  - Agents don't create GitHub releases or tags by hand; the scripts do.
- **Signing keys.** The Android keystore (`~/.gradle/gradle.properties`
  `TERMINUS_*`), the Mac certificate (in the login keychain, from
  `~/.terminus/mac-signing.p12`) and the Sparkle key
  (`~/.terminus/sparkle-ed25519.key`) live off-repo, only on the owner's Mac.

## Code style

- Match the surrounding code. Comments explain **why**, in plain English, at
  the density of the file around them. Doc comments describe behaviour, not
  history.
- **User-facing copy** is short, plain and concrete, in British spelling
  (colour, metres), with no jargon. It names what the user sees ("the map",
  "your stop"), not internals.
- **TypeScript:** ES modules, `.ts` import specifiers, single quotes,
  numeric separators (`15_000`), small pure functions exported for tests.
- **Website:** Preact components with htm templates, imported from
  `/assets/ui.js`; no bundler, no build step, so a page loads the files as
  written. What several components share (the profile, what the card is
  for) lives in a `store()` read with `useStore()`, not copied into each.
  MapLibre is driven directly, inside the Map tab's effects. With no
  bundler, `/app/` and `/account/` list the modules they start with as
  `<link rel="modulepreload">`, so the browser asks for them at once;
  `web-sw.test.js` fails when an import changes and the list doesn't. Load
  what isn't needed at first with `import()` (the map, Settings). Every word
  goes through `t()` (see below). External code only goes in `vendor/`, via its
  script, which pins each npm tarball's integrity; `vendor/SHA256SUMS`
  records every vendored file and `vendor.test.js` fails when one changes
  without its script. The CSP is in `src/http.ts`; new origins need adding
  there. Workers come from `'self'` only; blob: workers are allowed on
  `/admin/timelapse/` alone (Mediabunny), via `cspFor()`.
- **Kotlin:** keep logic that can be tested on the JVM out of composables
  (see `MapData.kt`).

## Git and GitHub conventions

- **Identity.** Commit as the person you're working for, with the git
  identity their own setup already gives you. Never set `user.name` or
  `user.email`, in any config, to someone else's, the owner's included:
  every contributor's agent reads this file, so a name here would sign
  their work as someone else. If no identity is set, ask the person whose
  session it is. Don't add `Co-Authored-By` lines, session links or
  "Generated with" lines to commit messages or PR descriptions.
- **Branches.** Work on a branch and open a pull request against `main`;
  without write access, from a fork. Only the owner pushes to `main`, and
  says so in their own instructions (see below). If you were given a
  working branch, use it.
- **The owner's own setup** (their identity, pushing straight to `main`)
  lives outside the repo: in `CLAUDE.local.md` or `~/.claude/CLAUDE.md` on
  their machines, and in their cloud environment's settings. Follow it when
  it's there; it's never checked in (`CLAUDE.local.md` is gitignored).
- **Commit messages** follow [Conventional Commits](https://www.conventionalcommits.org):
  `type(scope): summary`, the whole line under 100 characters.
  - Types: `feat`, `fix`, `docs`, `refactor`, `perf`, `test`, `build`,
    `ci`, `chore`, `revert`.
  - The scope names the part changed: `api`, `web`, `android`, `mac`,
    `widget`, `map`, `calendar`, `i18n`, `data`, `scripts`, `release`,
    `deps`. Leave it out when a change spans several.
  - The summary is short plain English, lower case after the colon, saying
    what a user or developer would notice: `fix(map): stops easier to tap
    on a phone`, `fix(scripts): map-tiles.sh uploads from apps/api, where
    wrangler is installed`.
  - A version bump is `chore(release): terminus <version>`.
  - The body is wrapped at about 72 characters and says what changed and
    why. Merge commits keep Git's own message.
- **After pushing,** watch CI on the commit and fix anything red straight
  away.
- **History.** Never rewrite pushed history unless asked. It was rewritten
  once to this convention (3 October 2026): every commit's message, with
  the files, authors and dates unchanged.
