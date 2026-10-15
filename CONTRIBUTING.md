# Contributing

Thanks for helping. A few ground rules first, because this project talks to
NUS's bus feed on everyone's behalf:

- **Never commit keys or captured traffic.** `.dev.vars` and `dev/` are
  gitignored. The NUS feed keys and the LTA DataMall key are not part of
  this repository.
- **Don't add load on NUS.** Arrivals are cached for 15 seconds per stop; keep it
  that way. No bulk polling, no scanning for endpoints.
- **No NUSNET credentials,** ever. The feed uses a public guest token.

## Working on it

Node 22.18 or later and pnpm. For the apps: a JDK (CI uses 21) and the
Android SDK, or Swift 6 on a Mac.

```bash
pnpm install
pnpm test                                 # API tests: no network, no keys
pnpm check                                # the tests, then tsc --noEmit
pnpm lint                                 # oxlint: API, website and scripts; warnings fail CI
node apps/api/scripts/dev-stub.mjs        # local API with fake buses
```

What CI runs ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)), so
you can run it first:

```bash
pnpm check && (cd apps/api && pnpm exec cf deploy --dry-run)
pnpm lint
for f in $(find apps/web/public -name '*.js'); do node --check "$f" || exit 1; done
(cd apps/android && ./gradlew :app:lintStableDebug :app:testStableDebugUnitTest :app:compileBetaDebugKotlin)
(cd apps/macos && swift build && swift test)
```

`cf deploy --dry-run` only bundles; it sends nothing.

- **Golden answers.** `apps/api/test/golden.test.js` pins whole answers. After
  an intended change, `UPDATE_GOLDEN=1 pnpm test` and review the fixture
  diff. The Android and Mac tests read the same fixtures.
- **Endpoints.** A changed route or response shape updates
  `apps/api/src/openapi.ts` and `apps/api/docs/internals.md`.
- **Migrations** in `apps/api/migrations` are additive only (no renames,
  drops or `NOT NULL` without a default), and an applied one is never edited.
  `test/deploy.test.js` checks this.

- **API** (`apps/api`): TypeScript on Cloudflare Workers. Tests run on Node's
  built-in runner; D1 is emulated with `node:sqlite`.
- **Website** (`apps/web/public`): HTML pages and Preact components (htm
  templates, no build step) served by the Worker. Third-party code is in
  `vendor/`, refreshed only with `scripts/vendor-preact.sh`,
  `scripts/vendor-map.sh` and `scripts/vendor-mediabunny.sh`; lint skips it.
- **Android** (`apps/android`): Kotlin, Compose and Glance. Point a debug build
  at the dev server with `./gradlew installStableDebug -PapiBase=http://localhost:8787`
  and `adb reverse tcp:8787 tcp:8787`.
- **Mac** (`apps/macos`): SwiftUI menu bar app. `./build.sh` builds it;
  `TERMINUS_API_BASE=http://localhost:8787` points it at the dev server, and
  `TERMINUS_SNAPSHOT=<dir>` on a debug build renders every state to PNGs.
  MapLibre Native, for the map window, is refreshed only with
  `scripts/vendor-maplibre-mac.sh`.

## Sending a change

Work on a branch (from a fork if you don't have write access) and open a
pull request against `main`. Commit under your own name. Commit messages
follow [Conventional Commits](https://www.conventionalcommits.org), for
example `fix(map): stops easier to tap on a phone`; CLAUDE.md lists the
types and scopes. If an agent such as Claude Code writes your commits, it
follows [CLAUDE.md](CLAUDE.md), which tells it to use your git identity and
never anyone else's.

## English and Chinese

Everything a user reads is in English and Simplified Chinese. Every new
string needs both; each platform's tests fail on one without its Chinese:

- **API:** `apps/api/src/i18n.ts`, read with `m()`. Errors stay English in
  the code (`json({ error: '...' })`) and get an entry in `ERRORS_ZH`. Answers
  are checked word for word by the Chinese goldens in `test/fixtures/answers/zh`.
- **Android:** `res/values/strings.xml` and `res/values-zh/strings.xml`;
  `L.s(R.string.x)` outside Compose. Lint fails on a missing translation.
- **Website:** `t('English {0}', value)` in scripts; page text needs nothing
  in the HTML. The Chinese, keyed by the English, is in `assets/zh.js`.
- **Mac:** `L("English %@", value)`; the Chinese is in
  `Support/zh-Hans.lproj/Localizable.strings`.

Place and service names (KR MRT, COM3, D2) stay English in both.

## Before you open a PR

- CI passes: the commands above.
- Tests for API changes, checked to fail without the fix.
- Screenshots for UI changes, light and dark where it differs.
- Both languages for any new text.
- No version bumps or releases; I cut those with `scripts/release.sh`.
- Keep a PR to one change. Deploys happen after merge, by hand.
