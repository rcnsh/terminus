# CLAUDE.md

terminus answers one question for NUS students: **which shuttle bus do I
catch, from which stop, and when do I leave (or is walking faster)?** It
reads the user's NUSMods timetable, NUS's live shuttle feed, the NUS
calendar and campus walking paths, and has a campus map with live buses.
Live at https://terminus.run (API docs at `/docs`), beta at
https://beta.terminus.run. An independent student project, not affiliated
with NUS.

Name new code and copy with the words in [GLOSSARY.md](GLOSSARY.md) (stop,
service, trip, plan, estimate, …). The deeper why is in
[docs/internals.md](docs/internals.md); decisions that look odd but are
deliberate are in [docs/adr/](docs/adr/).

One Cloudflare Worker (`apps/api`) does **all** the thinking; the clients
are thin:

| Client | Path | Stack |
| --- | --- | --- |
| API + website host | `apps/api` | TypeScript on Cloudflare Workers (D1, KV, R2, Durable Objects, Analytics Engine, Email) |
| Website + web app | `apps/web/public` | Preact + htm (vendored), CSS, **no build step**, served by the Worker |
| Android app + widgets | `apps/android` | Kotlin, Jetpack Compose, Glance, maplibre-compose |
| Mac menu bar app | `apps/macos` | SwiftUI, Sparkle updates, MapLibre Native (map window) |
| iPhone app + widgets | `apps/ios` | SwiftUI (iOS 17+), WidgetKit, ActivityKit, MapLibre Native; XcodeGen. Not released yet |

## Read first, when it applies

Each of these is required reading for its case, before the first edit:

- **Feeds:** anything that calls NUS or LTA, or runs on a cron, alarm or
  Durable Object wake (`src/feeds/`, `src/map/timelapse*`,
  `src/ops/monitor.ts`, `src/push/tripdo.ts`):
  [docs/agents/feeds.md](docs/agents/feeds.md), rule 2 in full.
- **Mechanics:** how answers, the stop graph, live buses, public buses, the
  timelapse and the street map work: [docs/agents/core.md](docs/agents/core.md).
- **Arrival-time model:** the shadow model that predicts arrivals against
  NUS's times (`src/ops/etamodel.ts`, `etashadow.ts`, `eta.ts`):
  [docs/eta-model.md](docs/eta-model.md), with results in
  [eta-backtest.md](docs/eta-backtest.md).
- **Where:** which file owns something: [docs/agents/repo-map.md](docs/agents/repo-map.md).
- **Addresses:** terminus.run and terminus.rcn.sh, redirects, emailed
  links, the apps' server list or developer menu:
  [docs/agents/addresses.md](docs/agents/addresses.md).
- **Screenshots:** checking a web UI change, or running any client against
  a fake feed: [docs/agents/dev-stub.md](docs/agents/dev-stub.md).
- **Apps:** building or testing Android, Mac or iPhone, and their CI:
  [docs/agents/apps.md](docs/agents/apps.md).
- **Cloud:** working from a Linux container:
  [docs/agents/cloud.md](docs/agents/cloud.md).
- **Shipping:** a deploy, a migration, a version bump, a beta or a release:
  [docs/agents/releasing.md](docs/agents/releasing.md).

## The rules that matter most

Code and docs cite these by number.

1. **The server computes the answer.** `/api/me/next` returns a ready-made
   card (labels, times, which bus); clients only count down the clock. Put
   every decision in the Worker, so the four clients stay identical
   (ADR 0001).
2. **Don't add unnecessary load on NUS.** Every feed call goes through the
   edge cache and the feed gate (`src/feeds/feedgate.ts`): arrivals once
   per stop per 15 s, live buses once per service per 5 s, LTA once per
   stop per 15 s (`TTL` in `src/config.ts`). Failures back off through
   `failMemoS` and the breaker. These limits only ever rise: never lower
   them, poll in bulk, or scan for endpoints. The timelapse recorder is the
   one scheduled poller (ADR 0004): don't add another poller or widen this
   one. The crons' few calls stay as small as they are. Exact limits:
   [docs/agents/feeds.md](docs/agents/feeds.md).
3. **`src/feeds/fms.ts` is the only file that touches the raw feed shape.**
   The feed is undocumented and changes, so its readers (`normalize()`,
   `normalizeBuses()` and their helpers) are tolerant and everything
   downstream assumes clean types. When the feed shifts, edit only there.
   `src/feeds/lta.ts` is the same for DataMall's shape.
4. **Secrets stay in `.dev.vars` and Worker secrets.** NUS feed keys, the
   LTA DataMall key and the push keys (FCM, Web Push, and APNs's
   `APNS_KEY`, off until it's set) live in `apps/api/.dev.vars` locally and
   as Worker secrets in production. Never put a secret value in git or in output, and never use
   NUSNET credentials: the feed uses a public guest token. `.gitignore`
   covers the secret files, `dev/` (captured traffic) and `.private/`.
5. **Every user-facing string is in English and Simplified Chinese.** Tests
   fail without the Chinese. See "English and Chinese" below.

## Conventions the code can't tell you

- Every API route is under `/api`; a new route goes there too (ADR 0007).
  Pages, `/download/*`, `/map/*`, `/auth/verify` and `/auth/approve` stay
  at the root. A call to an old root path gets 426 from an app, 308 from
  anything else (`movedApi` in `src/site/site.ts`).
- Every `terminus.rcn.sh` and `rcn.sh` left in the repo is deliberate
  (older apps still call it). Leave them as they are.
- Migrations only add (ADR 0008): the old Worker runs on the new schema
  until the deploy lands. Change a column in steps (expand, backfill,
  contract) and leave applied migrations untouched; `test/deploy.test.js`
  enforces both. Details in [releasing.md](docs/agents/releasing.md).
- `main` isn't auto-deployed. Server and website changes go live with a
  deploy; app changes need a release.

## Commands

```bash
pnpm install                          # Node 24 as in CI (22.18 or later works), pnpm from packageManager
pnpm test                             # API and website tests: Node's runner, no network, no keys
pnpm check                            # tests + tsc --noEmit (what CI's api job runs)
pnpm lint                             # oxlint over API, tests, scripts, website JS; warnings fail
pnpm format                           # oxfmt: JS, TS, JSON (pnpm format:check in CI)
node apps/api/scripts/dev/dev-stub.mjs # local Worker on :8787 with a fake feed and fake buses
```

- Your last step, after your **last** edit, is `pnpm lint` **and**
  `pnpm check`. Inside a single-quoted string, write `does not` or `’`.
- CI also runs `pnpm exec cf deploy --dry-run` in `apps/api` (modules
  workerd won't load) and `node --check` on every file in
  `apps/web/public`.
- Formatting is Oxfmt (`pnpm format`), swift-format (`pnpm format:swift`)
  and ktfmt (`pnpm format:kotlin`) at 140 columns, `pnpm format:all` for
  the three, and CI fails on unformatted code. The Lefthook pre-commit hook
  formats and re-stages staged JS/TS/JSON and Swift; run `pnpm format`
  before committing anyway, and `pnpm format:kotlin` for Kotlin, which the
  hook skips. No formatter touches HTML, CSS, htm templates or
  `cloudflare.config.ts`; keep their layout as written when you edit them:
  the Worker fills pages by their exact markup, the website translates page
  text keyed by it, tests read CSS rule by rule, and release-beta.sh and a
  test read the config as text.

## English and Chinese

- **API:** use `m()` from `src/i18n.ts`. Errors stay English in the code
  (`json({ error: '...' })`) and get an entry in `ERRORS_ZH`. The Chinese
  goldens in `fixtures/answers/zh` are checked word for word.
- **Website:** every word goes through `t('English {0}', value)`, in
  templates too (`${t('Go there')}`). The Chinese, keyed by the English,
  goes in `apps/web/public/assets/zh.js`; `web-i18n.test.js` checks it and
  catches English written straight into an `html` template. A sentence
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
  between Chinese and Latin letters or digits. When you change a word,
  change it everywhere.

## Tests

- `pnpm test` runs the API's (`apps/api/test`) and the website's
  (`apps/web/test`) tests, plain `node --test` importing the TypeScript
  sources directly. Node strips the types, so the TS must be erasable: no
  enums, namespaces or parameter properties, and type-only imports use
  `import type` (`verbatimModuleSyntax`).
- **Goldens.** `golden.test.js` pins whole answers to `fixtures/answers/`.
  After an intended change, run `UPDATE_GOLDEN=1 pnpm test` and review the
  fixture diff. The website, Android, Mac and iPhone tests read the same
  fixtures and assert values from them ("Leave by ~09:36"), so a changed
  golden means changing those tests too (`rg -l '<value>' apps`). Goldens
  and tests of how a guess is used run with one headway for every shuttle
  (`test/_headways.mjs`), so measuring headways again leaves them alone.
- Account tests run the real migration SQL against `node:sqlite`.
- Add tests for API changes, and check each new test fails without your
  fix. Prefer tests on real data, such as the real `shapes.json` lines,
  over synthetic ones.
- Changing an endpoint's shape means updating the spec
  (`src/openapi/paths.ts` and `components.ts`: schema, example,
  description) and `docs/internals.md`.

## Code style

- Match the surrounding code. Comments explain **why**, in plain English,
  in the present tense, at the density of the file around them, and point
  to internals.md rather than repeating it. A comment says what the name
  and the next line don't. History ("used to", "since
  3.2", dates) belongs in git log. The exception is evidence about the
  outside feeds (NUS, LTA, NUSMods): what was observed and when stays,
  because nothing else records it.
- **User-facing copy** is short, plain and concrete, in British spelling
  (colour, metres), with no jargon. It names what the user sees ("the map", "your stop"),
  not internals.
- **The interface explains itself.** Someone glancing at the screen for
  the first time should know what each thing is and what each control
  will do, from how it looks and where it sits alone: not from a tooltip,
  a hover, an accessibility label or having used it before. A control
  that could be read two ways is a bug, even when it works.
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
  `/assets/ui.js`, loaded as written (ADR 0009). What several components
  share (the profile, what the card is for) lives in a `store()` read with
  `useStore()`, not copied into each. MapLibre is driven directly, inside the Map tab's effects.
  - `/app/` and `/account/` list their starting modules as
    `<link rel="modulepreload">`; `web-sw.test.js` fails when an import
    changes and the list doesn't. Load what isn't needed at first with
    `import()` (the map, Settings).
  - The service worker fetches the app's files from the network first, so
    an edit reaches users with nothing else to do. When `SHELL_FILES` in
    `apps/web/public/sw.js` changes, bump `SHELL` too, so the old copy is
    dropped.
  - External code goes in `vendor/` only through its script
    (`scripts/vendor/`), which pins each tarball's integrity;
    `vendor/SHA256SUMS` records every vendored file and `vendor.test.js`
    fails when one changes without its script.
  - The CSP is in `src/http.ts`; a new origin needs adding there. Workers
    come from `'self'` only; blob: workers are allowed on `/admin/`
    alone (Mediabunny), via `cspFor()`.
- **Kotlin:** keep logic that can be tested on the JVM out of composables
  (see `MapData.kt`).

## Git and GitHub

- **Identity.** Commit as the person you're working for, with the git
  identity their own setup already gives you. Never set `user.name` or
  `user.email`, in any config, to someone else's, the owner's included:
  every contributor's agent reads this file, so a name here would sign
  their work as someone else.
  If no identity is set, ask the person whose session it is. Commit
  messages and PR descriptions carry no `Co-Authored-By`, session links or
  "Generated with" lines.
- **Branches.** Work on a branch and open a pull request against `main`;
  without write access, from a fork. If you were given a working branch,
  use it. Only the owner pushes to `main`. The owner's own setup (their
  identity, pushing straight to `main`) lives outside the repo, in
  `CLAUDE.local.md` or `~/.claude/CLAUDE.md` on their machines and in their
  cloud environment's settings; follow it when it's there.
- **Commit messages** follow [Conventional Commits](https://www.conventionalcommits.org):
  `type(scope): summary`, the whole line under 100 characters.
  - Types: `feat`, `fix`, `docs`, `refactor`, `perf`, `test`, `build`,
    `ci`, `chore`, `revert`.
  - Scopes: `api`, `web`, `android`, `mac`, `widget`, `map`, `calendar`,
    `i18n`, `data`, `scripts`, `release`, `deps`. Leave it out when a
    change spans several.
  - The summary is short plain English, lower case after the colon, saying
    what a user or developer would notice: `fix(map): stops easier to tap
    on a phone`.
  - A version bump is `chore(release): terminus <version>`.
  - The body is wrapped at about 72 characters and says what changed and
    why.
- **Merging.** PRs are squash-merged (merge commits are off), so the PR
  title becomes the commit on `main` with ` (#n)` added: it follows the
  commit rules and stays under 94 characters. Branch commits can be rough,
  and merging `main` into the branch is fine; both are squashed away. Use rebase-and-merge
  only for a PR whose commits each build and stand alone. GitHub deletes
  the branch on merge; locally, `git branch -D <branch>` (a squashed
  branch never looks merged, so `-d` refuses) and `git fetch --prune`.
- **After pushing,** watch CI on the commit and fix anything red straight
  away. Pushed history stays as it is unless you're asked to rewrite it.
