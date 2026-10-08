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

```bash
pnpm install
pnpm test                                 # API tests: no network, no keys
pnpm lint                                 # oxlint: API, website and scripts; warnings fail CI
node apps/api/scripts/dev-stub.mjs        # local API with fake buses
```

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

Please include tests for API changes, and screenshots for UI changes.
