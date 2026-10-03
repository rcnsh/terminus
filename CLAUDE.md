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
| Mac menu bar app | `apps/macos` | SwiftUI, Sparkle updates |

Live at https://terminus.rcn.sh (API docs at `/docs`); beta at
https://beta.terminus.rcn.sh. It's an independent student project, not
affiliated with NUS.

## The rules that matter most

1. **The server renders the answer; clients don't compute it.** `/me/next`
   returns a ready-made card (labels, times, which bus). Clients only count
   down the clock. Never move logic into a client: four clients would then
   drift apart.
2. **Don't add load on NUS.** Arrivals are cached 15 s per stop
   (`TTL.arrivalsMs`), live buses 5 s per service (`TTL.busesMs`), all in
   `src/config.ts`. Never lower these, poll in bulk, or scan for endpoints.
   Upstream failures back off (`failMemoS`, `breakerS`).
3. **`normalize()` / `normalizeBuses()` in `src/fms.ts` are the only code that
   touches the raw feed shape.** The feed is undocumented and changes, so
   they're tolerant and everything downstream assumes clean types. When the
   feed shifts, edit only there.
4. **Secrets never go in git or in output.** NUS feed keys live in
   `apps/api/.dev.vars` locally and as Worker secrets in production. Both are
   gitignored, along with `dev/` (captured traffic), `.private/`, keystores,
   `*.p12`/`*.pem`/`*.key` and `apps/android/app/google-services.json`.
   Never print secret values, and never use NUSNET credentials: the feed uses
   a public guest token.
5. **Every user-facing string is in English and Simplified Chinese.** Tests
   fail without the Chinese. See "English and Chinese" below.
6. **No model identifiers** (Claude model names and IDs) in commits, code,
   comments or docs.

## Commands

```bash
pnpm install                          # Node 24, pnpm from packageManager
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
- Android (CI): `./gradlew :app:lintStableDebug :app:testStableDebugUnitTest :app:compileBetaDebugKotlin`
  in `apps/android` (Java 21).
- Mac (CI, macOS runner): `swift build && swift test` in `apps/macos`.
- In a Linux cloud container without the Android SDK or Xcode, you can't
  build those apps. Check pure-Kotlin logic another way if you can (for
  example `MapData.kt` with its JUnit test, using a standalone `kotlinc`
  plus `org.json` and JUnit jars), then let CI build the app. Say plainly
  what you couldn't run.

### The dev stub

`apps/api/scripts/dev-stub.mjs` runs the real Worker under Node with:
- a fake NUS feed. Arrivals are made up; three buses per service drive round
  each route line, moving every 18 s like the real feed.
- an in-memory D1;
- the test account `you@u.nus.edu`. Sign-in codes and links print to the
  stub's stdout.

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
  src/resolve.ts      Stop + bus choice: haversine, directional pairing, scoring
  src/format.ts       Labels/details and the degrade ladder (live → scheduled)
  src/fms.ts          NUS feed client + normalisation (see rule 3); edge caching
  src/auth.ts         Guest token mint, KV memo, app-version breaker
  src/appversion.ts   Tracks the uNivUS app version the feed demands
  src/buses.ts        /buses: live buses placed on their route line (see below)
  src/campus.ts       /campus: stops, route lines, colours, destination search
  src/map.ts          /map/*: PMTiles street map, style, fonts, sprites from R2
  src/accounts.ts     Sign-in codes/links, sessions, anonymous accounts, pairing (D1)
  src/applogin.ts     App sign-in approved from the email (RFC 8628-like)
  src/trip.ts, tripdo.ts  Per-user Durable Object with today's trip signals
  src/detect.ts, outcomes.ts, ridetimes.ts  Ride detection, measured ride times
  src/monitor.ts      15-minute cron: feed health, incidents, housekeeping
  src/openapi.ts      OpenAPI 3.1 spec + docs page (a test fails if routes drift from it)
  src/http.ts         JSON helpers, CORS, security headers (CSP lives here)
  src/i18n.ts         Server strings, m(), ERRORS_ZH
  src/config.ts       TTLs and tuning constants (WALK, RIDE, ...)
  data/               Bundled JSON: stops.json (graph), shapes.json (route lines),
                      calendar.json, walks.json, venues/rooms/landmarks/residences
  migrations/         D1 schema, numbered NNNN_name.sql
  scripts/            dev-stub.mjs; scrapers (scrape_stops.py, route_shapes.py,
                      fetch_calendar.py, walk_routes.py, check_scraped.py);
                      probe_buses.py (feed update-rate probe); record_buses.mjs (checks /buses on a live site)
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
                      (ranking, tested) + search-box.js; dom.js has t, api, clock
  app/                Installed web app: app.js (Now, tabs), map.js (campus map), offline.js
  admin/, status/, pair/, privacy/
  assets/             ui.js (Preact, hooks, htm, stores), site.css (shared colours/type),
                      i18n.js, zh.js (Chinese), theme.js, landing.js, shots/
  vendor/             Preact + htm (scripts/vendor-preact.sh), MapLibre GL + PMTiles
                      (scripts/vendor-map.sh): never hand-edited, not linted
  sw.js               Service worker: offline app shell and map
apps/android/app/src/main/java/sh/rcn/terminus/
  Api.kt              API client and answer types
  MapData.kt          Map data, GeoJSON, RoutePath + Glides (bus animation); JVM-tested
  MapFiles.kt         Street map file kept for offline
  ui/                 Screens (MainScreen, MapScreen, Settings, Onboarding, ...)
  widget/             Glance widgets and their refresh schedule
  LeaveAlerts.kt, LiveService.kt, Push.kt   Notifications and FCM
apps/macos/
  Sources/Terminus/   Api.swift, AppModel.swift (state/refresh/pairing), views, Updater.swift
  Support/            Info.plist (version, SUPublicEDKey), zh-Hans strings
scripts/              release.sh, release-beta.sh, github-release.sh, package-mac.sh,
                      publish-mac.sh, appcast.py, release-notes.py, map-tiles.sh,
                      vendor-map.sh, vendor-preact.sh, vps-setup.sh
.github/workflows/    ci.yml, release.yml (tag-driven), scrape.yml (weekly data),
                      map-tiles.yml, probe-buses.yml (manual feed probe),
                      record-buses.yml (manual: no bus switches sides after a deploy)
```

## How the core works (short version)

- **Data graph.** `data/stops.json` (stops, route order, operating hours) is
  scraped weekly by `scrape.yml` → `scripts/scrape_stops.py`, along with
  `shapes.json` (route lines from OpenStreetMap via Overpass) and
  `calendar.json`. The workflow runs the tests and `check_scraped.py`, then
  commits to main as `github-actions[bot]`. The data is bundled into the
  Worker, so a data change needs a deploy. The calendar is the exception:
  the cron also fetches it weekly into KV (`src/calendarsync.ts`), so it
  doesn't run out when nobody deploys.
- **Answering.** `resolve.ts` picks candidate stops near the user, pairs each
  stop with its twin across the road, checks the bus goes downstream to the
  destination, and scores the options by arrival time. Rides use a per-hop
  guess until measured ride times exist (`RIDE` in config). Walking is
  recommended only when it beats the bus by `WALK.beatsBusByS`.
- **Quality ladder.** Each answer says how sure it is: `live`, `scheduled` (a
  headway guess inside operating hours, labelled as such), and so on. Never
  dress up a guess as live.
- **Feed etiquette.** The feed answers through a 15 s edge cache per stop.
  On failure it serves a stale answer if one exists (up to `staleMaxS`), and
  a failed stop isn't asked again for `failMemoS`. A version or key
  rejection trips a breaker. The uNivUS version string must track the Play
  Store; KV `config:appVersion` overrides the secret.
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
  - Within 50 m of its line, a bus is drawn **on** the line, with
    `along` = metres along it, never moving back. A short jump off the line
    (under 30 s) holds it at its last place.
  - The feed only refreshes every 15–20 s (its own time stamp; no faster
    source exists), so each bus is shown where it's estimated to be now
    (`motion`): on from its reading at 0.8 × the feed's speed, at most 25 s,
    never past its next stop, never back. `speed` and `until` let clients
    keep it moving between answers.
  - Clients poll every 5 s and keep each bus moving along its line, catching
    up with each answer over 5 s (web `map.js` `moveTo`; Android `Glides`).
    Between two places on the line they move along it or jump, never
    straight across.
  - `test/fixtures/bus-trace.jsonl` is a real feed trace (the probe
    workflow with `trace`); `buses.test.js` replays it.
  - Each bus comes with its number plate (`plate`, shown on its card on
    the map); `id` is a hash, stable while it runs.
- **Map.** `/campus` returns stops and route lines. The street map is a
  PMTiles extract on R2, in each site's own downloads bucket
  (`terminus-downloads`, `terminus-beta-downloads`), uploaded by the
  `map tiles` workflow or `scripts/map-tiles.sh` (`CHANNEL=stable|beta|both`). The style is Protomaps basemaps without
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
  between Chinese and Latin letters or digits. Change a word everywhere or
  nowhere.

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
    is a pnpm built-in). It runs `cf deploy` and needs `CLOUDFLARE_API_TOKEN`.
  - The beta is `pnpm run deploy:beta`, with its own D1, KV and R2.
  - When a migration is involved, apply it **before** deploying:
    `pnpm exec cf d1 migrations apply <db-id>` (ids are in
    `cloudflare.config.ts`).
  - `wrangler` is only installed in `apps/api`, so run wrangler/R2 commands
    from there.
  - Server-side changes, the website included, are live for everyone once
    deployed. Android and Mac changes need an app release.
- **Releasing.**
  - Bump Android `versionName`/`versionCode` (`apps/android/app/build.gradle.kts`),
    the Mac `CFBundleShortVersionString`/`CFBundleVersion`
    (`apps/macos/Support/Info.plist`) and `API_VERSION` (`apps/api/src/openapi.ts`,
    the version on the API docs) together. A test fails if they differ.
  - Run `scripts/release.sh --dry-run`, then `scripts/release.sh`. It tests,
    builds the signed split APKs, uploads to R2 and tags `v<version>`.
  - Pushing the tag runs `release.yml`. That workflow builds and signs the
    Mac DMG, writes the Sparkle appcast and `latest.json`, and publishes the
    GitHub release. It needs reviewer approval in the `release` environment.
  - Betas use `scripts/release-beta.sh <x.y.z-beta.n>`.
  - Agents don't create GitHub releases or tags by hand; the scripts and
    workflow do.
- **Signing keys.** The Android keystore (`~/.gradle/gradle.properties`
  `TERMINUS_*`), the Mac certificate and the Sparkle key live off-repo on the
  owner's machines. Releases can also run from a Linux VPS set up by
  `scripts/vps-setup.sh`.

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
  MapLibre is driven directly, inside the Map tab's effects. Every word goes
  through `t()` (see below). External code only goes in `vendor/`, via its
  script. The CSP is in `src/http.ts`; new origins need adding there.
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
