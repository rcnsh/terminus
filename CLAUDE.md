# CLAUDE.md

Guidance for AI agents working in this repo. Read it before you change
anything; the deeper "why" is in [docs/internals.md](docs/internals.md).
The words for the domain (stop, service, trip, plan, estimate, …) are in
[GLOSSARY.md](GLOSSARY.md): name new code and copy with them. Decisions that
look odd but are deliberate are in [docs/adr/](docs/adr/).

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
| iPhone app + widgets | `apps/ios` | SwiftUI (iOS 17+), WidgetKit, ActivityKit, MapLibre Native; XcodeGen. Not released yet |

Live at https://terminus.run (API docs at `/docs`); beta at
https://beta.terminus.run. It's an independent student project, not
affiliated with NUS.

terminus.run is the address people see and the one the apps call (from
3.3.0, or 3.2.1-beta.2 among the betas; beta.terminus.run for the beta), with the Mac's update feed and the
release scripts: it's the project's own domain, the one that goes with it
if someone else takes it over. terminus.rcn.sh (and beta.terminus.rcn.sh),
the owner's, is the old address: apps before 3.3.0 (betas before
3.2.1-beta.2) call it, and apps before 3.6.0 fall back to it once when
they can't reach terminus.run at all (`Servers.order`). From 3.6.0 the
apps have only terminus.run built in.
Both addresses stay attached to each Worker (`test/deploy.test.js`) until
no app that uses the old one is left. The
apps' developer menu (Settings, About: always in debug and beta builds,
after seven taps on the version in a stable release) shows diagnostics and
the recent requests, for a bug report, and in debug builds switches to the
dev stub, never a typed server (`Servers.kt`, `Servers` in `Api.swift`).

Pages opened on the old address go to the same page on terminus.run
(`movedPage` in `src/site/site.ts`, on with `MOVE_PAGES`), and emailed links use
terminus.run (`linkOrigin`). If a network refuses terminus.run,
`cloudflare.config.ts` says how to switch both off. The
privacy contact is privacy@terminus.run, through Email Routing's catch-all,
so it goes with the domain. Every `terminus.rcn.sh` and `rcn.sh` left in the
repo is on purpose: don't find-and-replace them.

Every API route is under `/api` (`/api/me/next`, `/api/campus`). The
pages, `/download/*` and `/map/*` stay at the root, as do the two pages a
sign-in email links to (`/auth/verify`, `/auth/approve`). A call to an old
root path gets 426 from an app, 308 from anything else (`movedApi` in
`src/site/site.ts`). A new route goes under `/api`.

## The rules that matter most

1. **The server computes the answer.** `/api/me/next`
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
   token minted at most once a minute (`remintGapS`). The cache is per
   Cloudflare data centre, so a miss asks the feed gate
   (`src/feeds/feedgate.ts`, one Durable Object per stop or service) first: one
   call per key per window across every data centre. Don't route a feed
   call around it. The same goes for LTA DataMall, the public buses' feed (`src/feeds/lta.ts`):
   one call per stop per 15 s, through the same cache
   (`src/feeds/edgecache.ts`).

   **One exception: the timelapse recorder**
   (`src/map/timelapse.ts`, `src/map/timelapsedo.ts`). It is the only code that
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
   (`src/ops/monitor.ts`). While NUS refuses our uNivUS version, the same check
   reads Google Play and APKCombo at most hourly and tries at most three new
   version strings on that stop per run, never one twice
   (`src/feeds/appversion.ts`). The beta's cron makes no health check: it reads
   the breakers its own traffic opened (`src/feeds/feedwatch.ts`), and runs
   the version search only while NUS is refusing the beta. Each push
   user's Trip object (`src/push/tripdo.ts`) wakes at most every 30 s to
   recompute the card, asking for its stops through the cache.
3. **`src/feeds/fms.ts` is the only file that touches the raw feed shape.** The
   feed is undocumented and changes, so its readers (`normalize()`,
   `normalizeBuses()` and their helpers) are tolerant and everything
   downstream assumes clean types. When the feed shifts, edit only there.
   `src/feeds/lta.ts` is the same for DataMall's shape.
4. **Secrets never go in git or in output.** NUS feed keys and the LTA DataMall
   account key live in `apps/api/.dev.vars` locally and as Worker secrets in
   production, as do the push keys (FCM, Web Push, and APNs's `APNS_KEY`,
   off until it's set). All are gitignored, along with `dev/` (captured traffic), `.private/`, keystores,
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
pnpm test                             # API and website tests: Node's runner, no network, no keys
pnpm check                            # tests + tsc --noEmit (what CI's api job runs)
pnpm lint                             # oxlint over API, tests, scripts, website JS; warnings fail
pnpm format                           # oxfmt: JS, TS, JSON (pnpm format:check in CI)
pnpm loc                              # lines of code by part and language (--json too)
node apps/api/scripts/dev/dev-stub.mjs # local Worker on :8787 with a fake feed and fake buses
```

- Run `pnpm lint` **and** `pnpm check` after your **last** edit, not before
  it. A stray `'` inside a single-quoted TS string (`doesn't`) has broken the
  build before. In `src/openapi/` and similar, write `does not` or use `’`.
- CI's `api` job also runs `pnpm exec cf deploy --dry-run` in `apps/api` to
  catch modules workerd won't load.
- Website JS: CI runs `node --check` on every file in `apps/web/public`.
- Formatting: Oxfmt (`.oxfmtrc.json`), swift-format (`.swift-format`) and
  ktfmt (`apps/android/.editorconfig`), all at 140 columns. `pnpm format`
  covers JS/TS/JSON; `pnpm format:swift` and `pnpm format:kotlin` the apps
  (`pnpm format:all` for the three). CI checks each one and fails on
  unformatted code. A Lefthook pre-commit hook (`lefthook.yml`, installed
  by `pnpm install`) formats staged JS/TS/JSON and Swift and re-stages
  them; run `pnpm format` before committing anyway, and
  `pnpm format:kotlin` for Kotlin, which the hook skips. The reformat
  commit is in `.git-blame-ignore-revs`. HTML and CSS are left as written:
  the Worker fills pages by their exact markup, the website translates
  page text keyed by it, and tests read CSS rule by rule. Templates inside
  JS (htm's html templates) aren't touched either, and neither is
  `cloudflare.config.ts`, which release-beta.sh and a test read as text.
- Android (CI): `./gradlew :app:ktfmtCheck :app:lintStableDebug :app:testStableDebugUnitTest :app:compileBetaDebugKotlin`,
  and beside it, a job each, `:app:assembleStableRelease` and `:app:assembleBetaRelease` (R8 and
  resource shrinking, unsigned without the keystore) in `apps/android`
  (Java 21).
- Android dependencies are locked and hash-checked. On a Dependabot Gradle
  PR, the `android deps` workflow writes the lockfiles and hashes and
  pushes them to its branch. After changing a version by hand, run
  `scripts/android-deps.sh` (or `scripts/android-deps.sh <pr>` for a PR
  the workflow didn't finish) and review the diff. Don't write hashes from
  a warm Gradle cache: CI's cold runners fetch files it leaves out.
- Mac (CI, macOS runner): `swift build && swift test`, then
  `swift build -c release --arch arm64` in `apps/macos`.
- iPhone (CI, macOS runner), in `apps/ios`: `python3 -I scripts/strings.py
  --check`, `scripts/fetch-maplibre.sh`, `xcodegen generate`, the unit tests
  (`-only-testing:TerminusTests`) on an iPhone simulator, then an unsigned
  Release build for `generic/platform=iOS`. The generated project, plists
  and entitlements aren't in git: `project.yml` is the source. CI doesn't
  run the UI tests: on a Mac, `apps/ios/scripts/ui-tests.sh [simulator]
  [suite]` starts a stub of its own, runs them against it and leaves
  screenshots in `apps/ios/build/shots`. Look at them.
- The mac and ios jobs are skipped when a run with exactly the same inputs
  has already passed (`swift-changes` in `ci.yml` hashes them). A file
  either job reads from outside its own app needs adding to that hash.
- In a Linux cloud container without the Android SDK or Xcode, you can't
  build those apps. Check pure-Kotlin logic another way if you can (for
  example `MapData.kt` with its JUnit test, using a standalone `kotlinc`
  plus `org.json` and JUnit jars), then let CI build the app. List
  what you couldn't run.

### The dev stub

`apps/api/scripts/dev/dev-stub.mjs` runs the real Worker under Node with:
- a fake NUS feed. Arrivals are made up; three buses per service drive round
  each route line, moving every 18 s like the real feed.
- an in-memory D1;
- the test account `you@u.nus.edu`. Sign-in codes and links print to the
  stub's stdout.
- the timelapse recorder on the fake buses. `POST /__stub/timelapse?minutes=N`
  records N minutes at once, moving the clock ahead. Then open
  `/admin/timelapse/` (token `dev`).
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
- The service worker fetches the app's files from the network first, so an
  edit reaches users without anything else. When the list of files it keeps
  (`SHELL_FILES` in `apps/web/public/sw.js`) changes, bump `SHELL` too, so the
  old copy is dropped.
- The stub sends a sign-in code only once per email for a while (later
  requests say "sent" but print nothing, as the real server does). Sign in
  once, keep the session cookie (`context.cookies()`) and reuse it, or
  restart the stub.
- Against the live sites (terminus.run, the beta), Chromium's own
  connections through the container's proxy fail at random
  (`ERR_TOO_MANY_RETRIES`) and its trust store may predate the proxy's
  certificate. Route the page's requests through Node instead
  (`context.route` with `fetch`, run with `NODE_USE_ENV_PROXY=1`), and use
  a temporary anonymous account (`POST /api/auth/anon`, then `DELETE /api/me`).
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
  src/                The Worker, a folder per part; shared basics at the top
    index.ts          Router; most endpoints live here or in accounts/me.ts
    config.ts         TTLs and tuning constants (WALK, RIDE, ...)
    types.ts          Env (the bindings) and the shared types
    http.ts           JSON helpers, CORS, security headers (CSP lives here)
    i18n.ts           Server strings, m(), ERRORS_ZH
    openapi.ts        OpenAPI 3.1 spec (a test fails if routes drift from it); its paths,
                      schemas, shared parts and the /docs page are in openapi/
    origin.ts         Which Worker this is, stable or beta (isBeta); emailed links' origin
    geo.ts, clock.ts  Distance on the Earth; clock times and lateness, worded once
  src/feeds/          Reading NUS's and LTA's feeds, politely (rule 2). Imports only the
                      top level, never another folder (a test checks)
    fms.ts            NUS feed client + normalisation (see rule 3)
    lta.ts            LTA DataMall client: the public buses at a stop (see below)
    edgecache.ts      Fetch through the edge cache, stale on failure, breaker: both feeds
    feedgate.ts       The feed gate: one feed call per key per window, every data centre
    auth.ts           Guest token mint, KV memo, app-version breaker
    appversion.ts     Tracks the uNivUS app version the feed demands
    feedwatch.ts      The beta's feed health, from the breakers its own traffic opened
  src/answer/         The answer engine: which bus, from which stop, when to leave
    next.ts           /api/me/next: the plan, free days, riding, the trip's phase
    answer.ts         Stops near you, arrivals, the best option, worded
    card.ts           What every client shows, worded once (the card's lines)
    plan.ts, leave.ts Which bus a trip is about; when to set off
    trip.ts           Today's trip signals and the day's state
    resolve.ts        Stop + bus choice: haversine, directional pairing, scoring
    transfer.ts       A trip that changes buses once (TRANSFER in config)
    walk.ts           Walking times along campus paths (walks.json)
    graph.ts          The stop graph: stops.json with hand-kept hours and opposites; GRAPH_PUBLIC
    public.ts         Public buses in the graph: withPublic, route keys, ride metres
    crowd.ts          Full buses, tallied as the Worker answers
    format.ts         Labels/details and the degrade ladder (live → scheduled)
    via.ts, landmarks.ts, residences.ts  Places a bus passes; food courts with several
                      stops; on-campus homes
  src/timetable/      Your week: the profile, classes, the academic calendar
    profile.ts        The profile (validated) and the planner
    day.ts            /api/me/day
    nusmods.ts        NUSMods timetable import
    calendar.ts       The academic calendar: which weeks and days a class runs
    calendarsync.ts   The academic calendar, refreshed into KV by the cron
  src/accounts/       Who you are: sign-in, sessions, devices
    me.ts             /api/auth, /api/pair, /api/me/* (accounts)
    accounts.ts       Sign-in codes/links, sessions, anonymous accounts, pairing (D1)
    applogin.ts       App sign-in approved from the email (RFC 8628-like)
    access.ts         Who may call the keyed routes (an API key or a session)
    passkey.ts        Passkeys for the operator's pages (adding one needs HEALTH_TOKEN)
    outcomes.ts       How each trip went (taps, Not going) and what it suggests
  src/push/           Notifications and the trip that sends them
    tripdo.ts         Per-user Durable Object: wakes, recomputes the card, pushes
    push.ts, webpush.ts, apns.ts  FCM to Android, Web Push to the web app, APNs to the iPhone
  src/map/            The map: live buses, stops and lines, the street map, the timelapse
    buses.ts          /api/buses: live buses placed on their route line (see below)
    campus.ts         /api/campus: stops, route lines, colours, destination search
    pairs.ts          /api/stops/pairs: every stop with its opposite stop
    map.ts            /map/*: PMTiles street map, style, fonts, sprites from R2
    timelapse.ts, timelapsedo.ts  The timelapse recorder (rule 2's one exception)
                      and /api/timelapse/days; one Durable Object per Singapore day
  src/ops/            Running it: the cron, the dashboard, its statistics, reports
    monitor.ts        15-minute cron: feed health, incidents, housekeeping
    admin.ts          /api/admin/stats for the dashboard; analytics.ts logs to Analytics Engine
    collect.ts        The dashboard's switches for the statistics below, all off until turned on
    usage.ts, eta.ts, apperrors.ts  Daily active counts; the feed's arrival times against
                      the timelapse; crash reports (/api/errors), scrubbed, with no one on them
    legacy.ts, settings.ts  What still uses the old address and paths, by app version and
                      route; how many accounts have each setting, daily totals
    etamodel.ts, etashadow.ts  An arrival-time model (segment medians, the feed's usual
                      error, a blend), pure; run in shadow by the cron with ETA_MODEL=shadow,
                      answering no one (docs/eta-model.md)
    feedback.ts       "This was wrong" reports, stored and emailed to the operator
  src/site/           The website's server side and email
    landing.ts, site.ts, pagesky.ts  The landing page; the old address's redirect
                      (movedPage); the small pages' sky
    seo.ts            robots.txt, the sitemap, /llms.txt for AI agents (the beta asks not to be crawled)
    downloads.ts      App downloads from R2 (latest.json, the APKs, the DMG, the appcast)
    mail.ts           Every email's HTML, built with react-email (the plain text is beside it)
  data/               Bundled JSON: stops.json (graph), shapes.json (route lines),
                      public.json (public buses), calendar.json, walks.json,
                      venues/rooms/landmarks/residences; hand-kept: service-hours.json,
                      opposites.json (stops across the road the scrape can't pair),
                      nus-days.json (NUS's days off, e.g. Well-Being Days: holiday hours),
                      src/venue-stops.json (the stops students use for a building,
                      where the map's nearest is wrong; then run walk_routes.py)
  migrations/         D1 schema, numbered NNNN_name.sql
  scripts/dev/        dev-stub.mjs, stub-admin.mjs (its dashboard numbers);
                      render-timelapse.mjs (renders a recorded day headless, e.g. on a VPS)
  scripts/deploy/     predeploy.mjs (first step of a deploy); vapid-key.mjs (makes the Web Push key, once)
  scripts/data/       The weekly scrapers (scrape_stops.py, scrape_lta.py, route_shapes.py,
                      fetch_calendar.py), walk_routes.py, check_scraped.py
  scripts/probes/     probe_buses.py (feed update-rate probe); probe_arrivals.py (how often
                      arrival times change, run by hand); record_buses.mjs (checks /api/buses on a live site);
                      record_eta.mjs + eta_backtest.mjs (the arrival-time model's data and backtest)
  test/               *.test.js + worker.smoke.js; _stubs.mjs, _d1.mjs (D1 on node:sqlite);
                      fixtures/ (feed captures, the migrations' hashes)
  cloudflare.config.ts     Worker config (stable + beta via --mode beta)
  wrangler.config.ts       Website assets directory
apps/web/
  test/               The website's tests (web-*, search, offline, daylight, vendor), happy-dom
apps/web/public/
  index.html          Landing page
  account/            The account page (app.js): sign-in, onboarding.js, settings.js +
                      settings-pages.js (Settings, shared with the app), preview.js (the
                      card), profile.js (the profile and /api/campus, shared), search.js
                      (ranking, tested) + search-box.js; journey.js (the card styles,
                      as on Android); dom.js has t, api, clock; sky.js (Now's sky
                      and horizon), daylight.js (its colours by the hour), livery.js
                      (the services' stripes)
  app/                Installed web app: app.js (Now, tabs), buses.js (Buses tab), map.js
                      (Map tab), board.js (a stop's board, shared by both), map-files.js,
                      offline.js, pull.js (pull to refresh), timing.js (when Now refetches)
  admin/, status/, pair/, privacy/ (the summary; privacy/policy/ the full policy;
                      each with zh/), not-found/ (the Worker's 404 page)
  admin/timelapse/    Replays a recorded day on the map and exports a video
                      (replay.js, shared with the API tests; Mediabunny encodes)
  assets/             ui.js (Preact, hooks, htm, stores), site.css (shared colours/type),
                      i18n.js, zh.js (Chinese), theme.js, landing.js, docs.js (/docs),
                      tabbar.css (the app's bar), fonts.css + fonts/ (self-hosted), shots/;
                      sky.css + sky-phase.js + sky-page.js: the app's sky on the site's pages
  vendor/             Preact + htm (scripts/vendor/vendor-preact.sh), MapLibre GL + PMTiles
                      (scripts/vendor/vendor-map.sh), Mediabunny (scripts/vendor/vendor-mediabunny.sh):
                      never hand-edited, not linted
  sw.js               Service worker: offline app shell and map
apps/android/app/src/main/java/sh/rcn/terminus/
  Api.kt              API client and answer types
  Servers.kt          Which server the app calls (the developer menu's choices); JVM-tested
  MapData.kt          Map data, GeoJSON, RoutePath + Slides (bus animation); JVM-tested
  MapFiles.kt         Street map file kept for offline
  ui/                 Screens (MainScreen, MapScreen, Settings, Onboarding, ...)
  widget/             Glance widgets and their refresh schedule
  LeaveAlerts.kt, LiveService.kt, Push.kt   Notifications and FCM
apps/macos/
  Sources/Terminus/   Api.swift (with Servers, the server it calls), AppModel.swift (state/refresh/pairing), views, Updater.swift,
                      MapWindow.swift + MapData.swift + MapFiles.swift (the map window)
  Vendor/             MapLibre.xcframework.zip, from scripts/vendor/vendor-maplibre-mac.sh
  Support/            Info.plist (version, SUPublicEDKey), zh-Hans strings, app icons
  Tests/              swift test, on the API's answer fixtures
  build.sh            Builds terminus.app (CHANNEL=beta for the beta)
apps/ios/
  project.yml         XcodeGen: the app, widgets, notification service, tests; version, bundle ids, app group
  Sources/Shared/     Shared by the app and its extensions: Api.swift, Answer.swift (types), Account.swift,
                      JourneyText.swift, Spoken.swift (VoiceOver's sentences), OfflineDay.swift, SkyDraw.swift
  Sources/App/        Now/, Buses/, Map/, Settings/, Onboarding/, Model/ (AppModel), UI/ (Sky, theme),
                      System/ (Push.swift: APNs and Live Activities, TripSync.swift, Links.swift: terminus://)
  Sources/Widgets/    WidgetKit widgets and the Live Activity
  Sources/NotificationService/  Rewords a push before it's shown
  Support/            zh-Hans strings (a table per part), assets
  Tests/, UITests/    Unit tests on the API's fixtures; XCUITests against the dev stub
  scripts/            strings.py (fills and checks the Chinese), fetch-maplibre.sh, run.sh,
                      sideload.sh (a free Apple ID's build, on a plugged-in iPhone or as an .ipa; SIDELOAD.md)
  store/              App Store listing (listing.md, English and Chinese), the screenshots and
                      header, capture.sh + frame.mjs, which take and draw them (StoreShotsUITests),
                      and ExportOptions.plist for the upload
scripts/              map-tiles.sh (+ map-tiles.lock), android-deps.sh (+ android_deps.py),
                      format-swift.sh, loc.mjs (pnpm loc)
scripts/release/      release.sh, release-beta.sh (+ release-lib.sh, their shared checks;
                      verify-sparkle.swift, release-check.py), github-release.sh, package-mac.sh,
                      appcast.py, release-notes.py
scripts/vendor/       vendor-map.sh, vendor-maplibre-mac.sh, vendor-preact.sh,
                      vendor-mediabunny.sh (+ vendor-lib.sh)
fixtures/             What every client is held to: answers/ (golden answers, zh/ the Chinese),
                      offline-day.json, search.json; read by the API's, website's and apps' tests
docs/                 internals.md (how everything works, in depth), architecture.md,
                      analytics.md, eta-model.md (+ eta-backtest.md, its results), adr/;
                      readme/ (the README's pictures and the scripts that render them)
marketing/posters/    A3 campus posters (never-run, ticket, board): each .html (source), .pdf (print), .png
.github/workflows/    ci.yml, scrape.yml (weekly data),
                      map-tiles.yml, probe-buses.yml (manual feed probe),
                      probe-arrivals.yml (manual: how often arrival times change),
                      record-buses.yml (manual: no bus switches sides after a deploy),
                      android-deps.yml (lockfiles and hashes for Dependabot's Gradle PRs)
```

## How the core works (short version)

- **Data graph.** `data/stops.json` (stops, route order, operating hours) is
  scraped weekly by `scrape.yml` → `scripts/data/scrape_stops.py`, along with
  `shapes.json` (route lines from OpenStreetMap via Overpass) and
  `calendar.json`. The workflow is three jobs: `scrape` holds the feed
  secrets and runs only the repo's standard-library Python; `test` runs the
  tests and `check_scraped.py` with no secrets; `commit`, the only job that
  can push, runs no npm code and fast-forwards main to a data-only commit
  on top of the tested one (if main moved, it pushes nothing: run it
  again). A last job, `heartbeat`, holds only the `HC_SCRAPE_URL` secret
  and runs only curl, pinging healthchecks.io with the run's outcome.
  `check_scraped.py` compares with HEAD and fails on a stop moved
  over 100 m, a changed stop order, any item lost from a list under 20,
  odd names, or a moved semester; such a change is committed by hand. A failed
  shapes, public-buses or calendar refresh keeps the committed file and
  shows as a warning on the run. The data is bundled into the
  Worker, so a data change needs a deploy. The calendar is the exception:
  the cron also fetches it weekly into KV (`src/timetable/calendarsync.ts`), so it
  doesn't run out when nobody deploys.
- **Answering.** `resolve.ts` picks candidate stops near the user, pairs each
  stop with its opposite stop across the road, checks the bus goes downstream to the
  destination, and scores the options by arrival time. Rides are
  `RIDE.secondsPerHop` a stop, no faster than `RIDE.longHopMs` over a long
  stretch (`RIDE` in config). Walking is
  recommended only when it beats the bus by `WALK.beatsBusByS`. Where no
  single bus goes there, a trip changes buses once (`src/answer/transfer.ts`,
  `TRANSFER` in config): at most `TRANSFER.maxFetch` change stops fetched
  per answer, the second bus in `change`, the trip as sure as its less
  sure bus.
  A room can have several stops (`venueStops()`, `stops` in `venues.json`):
  a trip from or to a class considers each, with the room's own walk to it.
  Where the map's nearest stop is the wrong one, fix it in
  `data/src/venue-stops.json` and run `scripts/data/walk_routes.py`.
  Standing in a building, the walk to a stop is the path from it (`out` in
  `venues.json`, `buildingStops()`), and only by its listed stops when it
  has them, not the straight line.
- **Quality ladder.** Each answer says how sure it is: `live`, `scheduled` (a
  headway guess inside operating hours, labelled as such), and so on. Never
  label a guess as live.
- **Feed etiquette.** The feed answers through a 15 s edge cache per stop.
  On failure it serves a stale answer if one exists (up to `staleMaxS`), and
  a failed stop isn't asked again for `failMemoS`. A version or key
  rejection, a 429 or 5xx, or no answer at all (a timeout, a failed
  connection) opens a breaker. The uNivUS version string must track the
  Play Store; KV `config:appVersion` overrides the secret.
- **Accounts.** D1. Sign-in is by emailed code or link. Apps get a device
  token: anonymous on first launch, then sign-in approved from the email, or
  pairing codes. Rate limits are Workers rate-limit bindings (`RL_*`). The
  cron deletes anonymous accounts unused for 60 days.
- **Live buses (`/api/buses`, `src/map/buses.ts`).** NUS's feed moves a bus about
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
- **Public buses (`src/answer/public.ts`, `src/feeds/lta.ts`, `data/public.json`).** Off
  by default; an account turns them on (`publicBuses` in the profile). The
  public buses that call at the campus's stops (95, 151, 96 and others, from
  LTA DataMall via `scripts/data/scrape_lta.py`, weekly) join a second graph,
  `GRAPH_PUBLIC`, used only when asked: a public stop on a shuttle stop's
  shelter is the same stop with a `publicCode`; a stop of its own keeps
  LTA's five-digit code. A two-way service is two routes, `151/1` and
  `151/2`, shown as `151` (`svcName()`). Ride time comes from metres along
  the route (`along`) rather than a count of stops. A public bus is the headline
  only when it beats the free bus by `PUBLIC.fareWorthS`; its leg carries
  `paid: true`, and a timetabled time (LTA's `Monitored: 0`) is
  `scheduled`, never `live`. The map shows no public buses.
- **Timelapse (`src/map/timelapse.ts`, `src/map/timelapsedo.ts`).** Rule 2's one
  exception: a Durable Object per Singapore day records every service's
  buses every 30 s through `getBuses()`, inside 06:30 to 00:30, and writes
  the day to R2 (`timelapse/YYYY-MM-DD.json.gz`) at the close.
  `/admin/timelapse/` replays a day (`replay.js`, which the tests share) and
  exports a video with Mediabunny, frame by frame. Details in internals.md.
- **Map.** `/api/campus` returns stops and route lines. The street map is a
  PMTiles extract on R2, in each site's own downloads bucket
  (`terminus-downloads`, `terminus-beta-downloads`), uploaded by the
  `map tiles` workflow or `scripts/map-tiles.sh` (`CHANNEL=stable|beta|both`).
  What goes up is pinned in `scripts/map-tiles.lock` (the Protomaps build,
  the basemaps-assets commit, the Noto Sans SC tag that fills in Chinese,
  SHA-256s of the cut and of every font and icon); nothing uploads unless
  it matches. To refresh: `scripts/map-tiles.sh
  --update`, review and commit the lock, then run the workflow within a few
  days (Protomaps keeps a build about a week). Its schedule only checks for
  a newer build. The style is Protomaps basemaps without
  points of interest, with every URL on our own domain.

## English and Chinese

- **API:** use `m()` from `src/i18n.ts`. Errors stay English in the code
  (`json({ error: '...' })`) and get an entry in `ERRORS_ZH`. The Chinese
  goldens in `fixtures/answers/zh` are checked word for word.
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
- **iPhone:** `L("English %@", value)` too, with the Chinese in
  `apps/ios/Support/zh-Hans.lproj/` (a table per part: `Now.strings`,
  `Settings.strings`, ...; anything else in `Localizable.strings`).
  `scripts/strings.py` fills in what Android or the Mac already says, and
  `--check` (in CI) fails on anything missing.
- Place and service names (KR MRT, COM3, D2) stay English in both.
- One glossary for all of it, at the top of `src/i18n.ts` (class 课, stop
  车站, favourite 收藏, packed 很挤, email address 邮箱, …), with a space
  between Chinese and Latin letters or digits. When you change a word, change it
  everywhere.

## Tests

- **Running them.** `pnpm test` runs both packages' tests: the API's
  (`apps/api/test`) and the website's (`apps/web/test`), each plain
  `node --test` over `test/*.test.js`, importing the TypeScript sources directly. Node strips the types, so the
  TS must be erasable: no enums, namespaces or parameter properties, and
  type-only imports use `import type` (`verbatimModuleSyntax`).
- **Golden answers.** `golden.test.js` pins whole answers to
  `fixtures/answers/`. After an intended change, run
  `UPDATE_GOLDEN=1 pnpm test` and review the fixture diff. The Android and
  Mac unit tests read the same fixtures, so a changed answer shape must
  still parse there.
- **Account tests** run the real migration SQL against `node:sqlite`.
- **Writing tests.** Add tests for API changes. Prefer tests on real data,
  such as the real `shapes.json` lines, over synthetic ones. Check a new
  test fails without your fix.
- **The spec.** Changing an endpoint's shape means updating the spec
  (`src/openapi/paths.ts` and `components.ts`: schema, example, description) and `docs/internals.md`.

## Deploying and releasing

- **Deploying.** `main` is **not** auto-deployed.
  - Deploy from `apps/api` with `pnpm run deploy` (not `pnpm deploy`, which
    is a pnpm built-in). It first runs `scripts/deploy/predeploy.mjs`, which
    refuses unmerged files, conflict markers or uncommitted changes in
    `apps/api` and `apps/web/public` and runs `pnpm check`; then it applies
    the stable D1's pending migrations and runs `cf deploy`. It needs
    Cloudflare credentials: `CLOUDFLARE_API_TOKEN`, or a browser login
    with `pnpm exec cf auth login`, which `cf` keeps on the machine.
    `pnpm exec cf auth whoami` says which is in use; a missing token in
    the shell doesn't mean a deploy can't run.
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
    deployed. Android, Mac and iPhone changes need an app release.
- **Releasing.**
  - **Which version.** Whenever a release, a beta or a version bump comes
    up, work the version out this way and say why, rather than guessing or
    taking the next number. Compare against the last stable tag,
    `T=$(git describe --tags --abbrev=0 --exclude='*-beta*')`. App code
    means `apps/android/app/src/main`, `apps/macos/Sources`,
    `apps/macos/Support`, `apps/ios/Sources` and `apps/ios/Support`.
    1. **No release:** nothing in app code changed
       (`git diff --quiet $T HEAD -- <app code>`). Server and website
       changes only need `pnpm run deploy`; docs, tests, CI and scripts
       need nothing.
    2. **Major** (`x+1.0.0`): only for a break: an app no longer updated
       stops working, users must sign in or set up again, a feature is
       removed, or an endpoint in `/docs` changes incompatibly. Ask the
       owner first; this is rare.
    3. **Minor** (`x.y+1.0`): any `feat` commit touching app code
       (`git log --format=%s $T..HEAD -- <app code> | grep '^feat'`), or
       anything a user would notice as new. Goes through a beta first.
    4. **Patch** (`x.y.z+1`): everything else, that is fixes, wording and
       performance in the apps. May go straight to stable when small or
       urgent.
  - **Betas** are named after the stable version they become: a minor's
    betas are `x.y+1.0-beta.n`, never a patch's number. Cut one whenever
    there's something worth testing on real phones, as often as that is: a
    fix to a bug in the last beta goes out straight away rather than waiting
    for a quiet day. Batch what's ready rather than one per commit; quick
    iteration before that uses debug builds and the dev stub. After the
    first beta of a version, only fixes join it;
    new features wait for the next minor. A beta soaks for at least one
    full campus day before it becomes stable, and the stable release is the
    exact commit of the last beta. Anything newer means another beta first
    (a hotfix patch is the exception).
  - Before running either script, tell the owner the version, which rule
    picked it and the commits that decided it.
  - Bump Android `versionName`/`versionCode` (`apps/android/app/build.gradle.kts`),
    the Mac `CFBundleShortVersionString`/`CFBundleVersion`
    (`apps/macos/Support/Info.plist`), the iPhone's `MARKETING_VERSION`/
    `CURRENT_PROJECT_VERSION` (`apps/ios/project.yml`) and `API_VERSION` (`apps/api/src/openapi.ts`,
    the version on the API docs) together. A test fails if the versions
    differ, or if `versionCode`, `CFBundleVersion` and
    `CURRENT_PROJECT_VERSION` do. The release scripts don't build the
    iPhone app; it goes to the App Store by hand (below).
  - Push `main`, wait for CI to pass, deploy the Worker (`pnpm run deploy`),
    then run `scripts/release/release.sh --dry-run` and `scripts/release/release.sh` on the
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
  - Betas use `scripts/release/release-beta.sh <x.y.z-beta.n>`, on the same Mac,
    with the same checks: also from `origin/main` with CI passed. It deploys
    the beta Worker itself and uploads nothing until that deploy has
    finished (a beta keeps `API_VERSION`, so the live API's version can't
    tell the new Worker from the old).
  - Both start from the lockfiles: they delete `node_modules` and
    `apps/macos/.build`, then install with `--frozen-lockfile` and
    `--force-resolved-versions`. The Sparkle key only goes to a `sign_update`
    matching `SIGN_UPDATE_SHA256` in `scripts/release/release-lib.sh`; a Sparkle bump
    means updating `SPARKLE_VERSION` and that hash (check the new zip
    against the checksum in Sparkle's `Package.swift` first). The appcast
    itself is signed too, and nothing may edit it afterwards.
  - Agents don't create GitHub releases or tags by hand; the scripts do.
  - **The iPhone app** goes to App Store Connect (app 6825759345, team
    `BUKSCHP3SV`) from the owner's Mac, by hand, after the stable release,
    from the same clean worktree. The listing is in `apps/ios/store/`.
    - Xcode must be signed in to the team's Apple Account, and the team
      needs a registered device (the Mac counts): automatic signing makes a
      development profile before it archives, and fails with "no devices"
      without one.
    - In `apps/ios`: `scripts/fetch-maplibre.sh && xcodegen generate`, then
      `xcodebuild -project terminus.xcodeproj -scheme Terminus
      -configuration Release -destination generic/platform=iOS
      -archivePath build/appstore/terminus.xcarchive
      -derivedDataPath build/dd-release DEVELOPMENT_TEAM=BUKSCHP3SV
      -allowProvisioningUpdates archive`.
    - Check the archive's entitlements (`codesign -d --entitlements -` on
      `Terminus.app` and each `PlugIns/*.appex`): the app group in all
      three, and push, Time Sensitive and `applinks:terminus.run` in the
      app. Never archive with `CODE_SIGNING_ALLOWED=NO`: the export then
      signs the app without any of them, and widgets and push break.
    - Upload: `xcodebuild -exportArchive -archivePath
      build/appstore/terminus.xcarchive -exportPath build/appstore/upload
      -exportOptionsPlist store/ExportOptions.plist
      -allowProvisioningUpdates`. A warning that MapLibre has no dSYM is
      expected.
    - When Apple has processed it (an email, minutes to an hour), pick the
      build on the version's page in App Store Connect and add it for
      review. Release is manual: the owner presses Release after approval.
      Push needs the stable Worker's `APNS_*` secrets (set; the key is
      `~/.terminus/AuthKey_9NH85A3927.p8`).
- **Signing keys.** The Android keystore (`~/.gradle/gradle.properties`
  `TERMINUS_*`), the Mac certificate (in the login keychain, from
  `~/.terminus/mac-signing.p12`), the Sparkle key
  (`~/.terminus/sparkle-ed25519.key`) and the APNs key
  (`~/.terminus/AuthKey_*.p8`) live off-repo, only on the owner's Mac.
  The iPhone's distribution certificate is Apple's cloud-managed one, used
  through Xcode's sign-in.

## Code style

- Match the surrounding code. Comments explain **why**, in plain English, in
  the present tense, at the density of the file around them. No history
  ("used to", "since 3.2", dates): that's what git log is for. Don't
  restate the name or the next line. Don't repeat internals.md at length;
  point to it. The exception is evidence about the outside feeds (NUS,
  LTA, NUSMods): what was observed and when stays, because nothing else
  records it.
- **User-facing copy** is short, plain and concrete, in British spelling
  (colour, metres), with no jargon. It names what the user sees ("the map",
  "your stop"), not internals.
- **The interface explains itself.** Someone glancing at the screen for
  the first time should know what each thing is and what each control
  will do, from how it looks and where it sits alone: not from a tooltip,
  a hover, an accessibility label or having used it before. If a control
  could be read two ways, it's a bug, even when it works.
  - Placement and grouping say what something belongs to: a control sits
    with the thing it acts on, and things that look alike behave alike.
  - Use the look each platform's users already know for that job, rather
    than a new one.
  - The four clients show the same thing the same way. Before building
    or changing something in one, look at how the others already do it
    and match them, or improve all of them together.
  - Judge it from a screenshot of every state (chosen and not, empty and
    full, light and dark) with fresh eyes, as a new user would, not from
    the code.
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
    why.
- **Merging.** Pull requests are squash-merged (GitHub's default here;
  merge commits are off). The PR title becomes the commit on `main`, with
  ` (#n)` added, so the title follows the commit rules above and stays
  under 94 characters. Commits on the branch can be rough, and merging
  `main` into it is fine; both are squashed away. Use rebase-and-merge
  only for a PR whose commits each build and stand alone. GitHub deletes
  the branch on merge; locally, `git branch -D <branch>` (a squashed
  branch never looks merged to Git, so `-d` refuses) and
  `git fetch --prune`.
- **After pushing,** watch CI on the commit and fix anything red straight
  away.
- **History.** Never rewrite pushed history unless asked. It was rewritten
  once to this convention (3 October 2026): every commit's message, with
  the files, authors and dates unchanged.
