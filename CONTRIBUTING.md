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
npm install
npm test                                  # API tests: no network, no keys
node apps/api/scripts/dev-stub.mjs        # local API with fake buses
```

- **API** (`apps/api`): TypeScript on Cloudflare Workers. Tests run on Node's
  built-in runner; D1 is emulated with `node:sqlite`.
- **Website** (`apps/web/public`): static HTML, CSS and JS served by the Worker.
- **Android** (`apps/android`): Kotlin, Compose and Glance. Point a debug build
  at the dev server with `./gradlew installDebug -PapiBase=http://localhost:8787`
  and `adb reverse tcp:8787 tcp:8787`.
- **Mac** (`apps/macos`): SwiftUI menu bar app. `./build.sh` builds it;
  `TERMINUS_API_BASE=http://localhost:8787` points it at the dev server, and
  `TERMINUS_SNAPSHOT=<dir>` on a debug build renders every state to PNGs.

Please include tests for API changes, and screenshots for UI changes.
