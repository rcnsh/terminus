# Contributing

Thanks for helping. A few ground rules first, because this project talks to
NUS's bus feed on everyone's behalf:

- **Never commit keys or captured traffic.** `.dev.vars` and `dev/` are
  gitignored. The NUS feed keys are not part of this repository.
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
- **Website** (`apps/web/public`): static HTML, CSS and JS served by the Worker.
- **Android** (`apps/android`): Kotlin, Compose and Glance. Point a debug build
  at the dev server with `./gradlew installStableDebug -PapiBase=http://localhost:8787`
  and `adb reverse tcp:8787 tcp:8787`.
- **Mac** (`apps/macos`): SwiftUI menu bar app. `./build.sh` builds it;
  `TERMINUS_API_BASE=http://localhost:8787` points it at the dev server, and
  `TERMINUS_SNAPSHOT=<dir>` on a debug build renders every state to PNGs.

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
