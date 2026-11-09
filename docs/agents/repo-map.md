# Repo map

Which file owns what. The API's own layout, in more depth, is in
[internals.md](../internals.md#layout).

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
    analytics-rows.ts Every Analytics Engine row's columns, declared once (ROWS);
                      writeRow writes by name, COL gives queries the columns
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
    rider.ts          The rider's answer: answered for a request, a wake or a reword;
                      saves what each should and nudges the rider's devices
    answer.ts         Stops near you, arrivals, the best option, worded
    card.ts           What every client shows, worded once (the card's lines)
    plan.ts, leave.ts Which bus a trip is about; when to set off
    trip.ts           Today's trip signals and the day's state, kept in the Trip object
    signal.ts         A signal applied to the day (applySignal): the trip's record, its outcome
    phase.ts          A trip's phase now, and when it next changes (the Trip object's wake)
    resolve.ts        Stop + bus choice: haversine, directional pairing, scoring
    departures.ts     A service's buses from a stop: its feed rows and berths, live times, then
                      estimates a headway apart
    hours.ts          When a service runs (operating hours, day kinds) and its headway by the hour
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
    profiles.ts       The profile read back from D1 (getProfile), what still holds kept
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
    keyuse.ts         Requests made with each API key, for the dashboard's API keys table
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
                      headways.json (each shuttle's gaps by hour, from measure_headways.mjs),
                      src/venue-stops.json (the stops students use for a building,
                      where the map's nearest is wrong; then run walk_routes.py)
  migrations/         D1 schema, numbered NNNN_name.sql
  scripts/dev/        dev-stub.mjs, stub-admin.mjs (its dashboard numbers); shot.mjs
                      (a page's screenshot); render-timelapse.mjs (renders a recorded day
                      headless, by hand), its selectors in render-timelapse-ui.mjs
  scripts/deploy/     predeploy.mjs (first step of a deploy); smoke.mjs (checks a deployed Worker answers); vapid-key.mjs (makes the Web Push key, once)
  scripts/data/       The weekly scrapers (scrape_stops.py, scrape_lta.py, route_shapes.py,
                      fetch_calendar.py), walk_routes.py, check_scraped.py;
                      measure_headways.mjs (data/headways.json from the recorder's days, by hand)
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
  app/                Installed web app: app.js (Now, tabs), buses.js (Stops tab), map.js
                      (Map tab), board.js (a stop's board, shared by both), map-files.js,
                      offline.js, pull.js (pull to refresh), timing.js (when Now refetches)
  admin/, status/, pair/, privacy/ (the summary; privacy/policy/ the full policy;
                      each with zh/), not-found/ (the Worker's 404 page). The dashboard's
                      sections link to each other by hash (#/feed) from views.js: moving
                      one, git grep its old address across apps/web/public
  admin/timelapse/    The dashboard's Timelapse section (#/timelapse): replays a recorded
                      day on the map and exports a video (replay.js, shared with the
                      API tests; Mediabunny encodes). index.html only forwards there
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
  project.yml         XcodeGen: the app, widgets, notification service, the watch app, tests; version, bundle ids, app group
  Sources/Shared/     Shared by the app and its extensions: Api.swift, Answer.swift (types), Account.swift,
                      JourneyText.swift, Spoken.swift (VoiceOver's sentences), OfflineDay.swift, SkyDraw.swift
  Sources/App/        Now/, Buses/, Map/, Settings/, Onboarding/, Model/ (AppModel), UI/ (Sky, theme),
                      System/ (Push.swift: APNs and Live Activities, TripSync.swift, Links.swift: terminus://)
  Sources/Widgets/    WidgetKit widgets and the Live Activity
  Sources/NotificationService/  Rewords a push before it's shown
  Sources/Watch/      The Apple Watch app (ADR 0016): App/ (Now, Nearby, setup, PhoneLink), Widgets/
                      (complications), Common/ (WatchPlan: the one fetch; Glance: the complications' words)
  Sources/App/System/WatchLink.swift  The phone's side of setting up the watch (Settings › Devices)
  Support/            zh-Hans strings (a table per part), assets
  Tests/, UITests/    Unit tests on the API's fixtures; XCUITests against the dev stub
  WatchTests/, WatchUITests/  The same for the watch app
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
