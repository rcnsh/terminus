# Contributing

Thanks for helping. A few ground rules first, because this project talks to
NUS's bus feed on everyone's behalf:

- **Never commit keys or captured traffic.** `.dev.vars` and `dev/` are
  gitignored. The NUS feed keys and the LTA DataMall key are not part of
  this repository.
- **Don't add load on NUS.** Every feed call goes through the edge cache and
  the feed gate, and those limits only ever rise. No new pollers, no bulk
  polling, no scanning for endpoints.
- **No NUSNET credentials,** ever. The feed uses a public guest token.

## Working on it

Setup, the dev stub and pointing an app at it are in the
[README's Quickstart](../README.md#quickstart) and
[Clients](../README.md#clients). The project's conventions (golden answers,
endpoint specs, additive-only migrations, and English and Chinese for every
string a user reads) are in [CLAUDE.md](../CLAUDE.md), written for agents
and people alike.

What CI runs ([`workflows/ci.yml`](workflows/ci.yml)), so you can run it
first:

```bash
pnpm check && (cd apps/api && pnpm exec cf deploy --dry-run)
pnpm lint && pnpm format:check
for f in $(find apps/web/public -name '*.js'); do node --check "$f" || exit 1; done
(cd apps/android && ./gradlew :app:ktfmtCheck :app:lintStableDebug :app:testStableDebugUnitTest :app:compileBetaDebugKotlin)
(cd apps/android && ./gradlew :app:assembleStableRelease :app:assembleBetaRelease)
scripts/format-swift.sh --check && (cd apps/macos && swift build && swift test && swift build -c release --arch arm64)
```

`cf deploy --dry-run` only bundles; it sends nothing. `pnpm install` sets up
a pre-commit hook that formats your staged JS, TS, JSON and Swift. It skips
Kotlin, so run `pnpm format:all` before you push: CI fails on unformatted
code.

## Sending a change

Work on a branch (from a fork if you don't have write access) and open a
pull request against `main`. Commit under your own name. Commit messages
follow [Conventional Commits](https://www.conventionalcommits.org), for
example `fix(map): stops easier to tap on a phone`; CLAUDE.md lists the
types and scopes. PRs are squash-merged, so the PR title becomes the
commit on `main`: give it the same form. If an agent such as Claude Code
writes your commits, it follows [CLAUDE.md](../CLAUDE.md), which tells it to
use your git identity and never anyone else's.

## Before you open a PR

- CI passes: the commands above.
- Tests for API changes, checked to fail without the fix.
- Screenshots for UI changes, light and dark where it differs.
- Both languages for any new text.
- No version bumps or releases; I cut those with `scripts/release/release.sh`.
- Keep a PR to one change. Deploys happen after merge, by hand.
