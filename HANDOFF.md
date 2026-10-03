# Handoff: where terminus stands (3 October 2026)

For the next agent picking this up. Read `CLAUDE.md` first: it holds the
rules, the commands and the repo map. This file says what was done
recently, what's left, and where to look. Delete it once it's out of date.

## Start here

1. `CLAUDE.md`: the rules. The server writes every answer, NUS's feed is
   never loaded harder, every string is in English and Chinese, and no
   secrets or model names go anywhere.
2. `ON-MACOS.md`: the owner's to-do list for their Mac session, in two
   parts: what Claude can do there, and what only the owner can do.
   - It covers trying the apps, retaking screenshots and releasing 2.1.0.
   - It also lists the decisions still open (Y7) and the Cloudflare
     dashboard settings (Y5).
   - It's the best list of what's left.
3. `RELEASE_NOTES.md`: the 2.1.0 notes, as users will read them.
4. `apps/api/docs/internals.md`: how everything works, in depth.
5. History: `git log --oneline -60`. Every commit says what changed and
   why, so `git show <sha>` is the fastest way to see how a feature was
   built. The last release tag is `v2.0.4`; everything since it ships as
   2.1.0.

## State

- **Versions.** `main` is at 2.1.0 (Android `versionCode` 44, Mac build
  44). It is not released yet. The release waits for the owner, who needs
  their Mac and signing keys (`ON-MACOS.md` C6, C7 and Y4). Agents never tag or
  release by hand.
- **Deployed.** Both sites (terminus.rcn.sh and the beta) run `ee278ff`,
  everything on `main` as of 3 October evening, with no migration pending.
  - `/health` on both says `ok: true` and `calendar.source: fetched`: the
    calendar is answered from the copy the cron fetched (`d85239b`).
  - Check what's live with `curl -s https://terminus.rcn.sh/health`, and
    `curl -s https://terminus.rcn.sh/sw.js | head -20` for the website's
    `SHELL` version.
  - Live buses on production haven't been recorded since the deploy
    (`ON-MACOS.md` C3); it needs buses running.
- **The owner deploys from a VPS:**
  `git fetch origin --tags --force && git reset --hard origin/main && pnpm install --frozen-lockfile && (cd apps/api && pnpm run deploy:beta && pnpm run deploy)`
- **History.** Every commit message was rewritten to Conventional Commits
  on 3 October, tags included. A clone from before then needs
  `git fetch origin --tags --force && git reset --hard origin/main`.
- **CI** was green on every commit up to `ee278ff`: api, lint, web,
  android and mac.

## What was done recently, newest first

Use `git show` on each for the details.

- **ee278ff** Dependabot's oxlint bump (PR #10), merged.
- **b3d4dc4 ON-MACOS.md.** The owner's Mac to-do list (it was
  AFTER-AUDIT.md), in two parts: what Claude can do there, and what only
  the owner can do.
- **8f4e556 Conventional Commits.** The whole history's messages were
  rewritten to `type(scope): summary`; CLAUDE.md and CONTRIBUTING.md
  describe it, and the scrape workflow, Dependabot and
  `release-notes.py` follow it.
- **d85239b The calendar keeps itself up to date.** The cron fetches
  NUSMods' semester dates and data.gov.sg's holidays weekly into KV
  (`src/calendarsync.ts`), so the calendar doesn't run out when nobody
  deploys. `/health` says which copy answers.

- **17dc7d9 Guards against a big Cloudflare bill.**
  - **Static files skip the Worker.** `/assets/*` and `/vendor/*` are
    served free (`runWorkerFirst` in `apps/api/cloudflare.config.ts`).
    Their headers are in `apps/web/public/_headers`, and a test checks
    them against `withSecurityHeaders`.
  - **Map reads limited per IP.** `RL_MAP` limits R2 reads to 300 a minute
    per IP; pieces already in the edge cache don't count.
  - **CPU cap.** `limits.cpuMs` is 5000. This needs Workers Paid; if a
    deploy refuses it, remove it.
  - **Clients wait out a 429.** Every client honours `Retry-After`: web
    `send()` in `account/dom.js`, Android `Quiet` in `Api.kt`, Mac
    `Quiet` in `Api.swift`.
- **aacf961 Edge caching.**
  - **Map pieces.** `edgePart()` in `apps/api/src/map.ts` keeps every
    PMTiles piece, font and icon in `caches.default`, keyed by the file's
    ETag and byte range.
  - **`/campus`.** Built once per isolate, with an ETag, so revalidation
    gets a 304.
  - **Shared test fake.** `makeBucket()` in `test/_stubs.mjs` is a fake
    R2, shared by the tests and the dev stub.
- **598ba46 Feed-shape check.** `arrivalsProblem()` and `busesProblem()` in
  `src/fms.ts` treat a feed whose rows change shape as an outage, so users
  see the "live times are down" notice instead of wrong guesses.
  - Bus times hours away are deliberately not checked: real ConnectX
    times near midnight are about 7 hours away.
- **26658b6 CLAUDE.md identity.** Agents commit as whoever they work for,
  never as the owner. The owner's own setup (push to main as themselves)
  lives outside the repo: `CLAUDE.local.md` (gitignored), or the cloud
  environment's settings.
- **264160b A 12- or 24-hour setting.**
  - **Server.** Profile `clock` (`auto|12|24`) and `card.h12`; `hour12()`
    is in `src/next.ts`.
  - **Clients.** Settings › Language and time on all three, plus "Show
    times as" in setup.
  - **Widgets** on Android follow it too.
- **9015e73 Crowding words.** Crowding reads "low, medium, high", and
  "often busy" replaces "packed". The glossary is at the top of
  `src/i18n.ts`.
- **f0a0ff5 Semester reminder.** One push reminds people to import a new
  semester's timetable, unless they already have.
  - It is sent from the cron (`src/monitor.ts`).
  - Android handles it in `TermReminder` in `Push.kt`.
- **940ce90 Calmer card.** The class card shows one plan, plus one quiet
  "Or go now" line.
- **Earlier** (see `git log` past `940ce90`, and `docs/map-plan.md`):
  - the campus map with live buses (`src/buses.ts`, web `app/map.js`,
    Android `MapData.kt`/`MapScreen.kt`);
  - the redesign: tabs and Settings as a list of groups;
  - the website moved to Preact;
  - two security audits.

## What's left

- **The owner's Mac session** (`ON-MACOS.md`):
  - try the Android and Mac apps;
  - retake the app screenshots: `assets/shots/app-*.webp` and
    `mac-*.webp`;
  - dry-run the release workflow;
  - run `scripts/release.sh`.

  Agents can help with the scripts, but the signing keys are on the
  owner's machines.
- **Dashboard settings for the owner** (`ON-MACOS.md` Y5): a billing
  alert and a WAF rate-limit rule.
- **Open decisions** (`ON-MACOS.md` Y7). Ask the owner before starting
  any of them:
  - Turnstile on an app's first start, against scripted sign-ups;
  - which wording should move to the server, and why the apps differ;
  - Mac polish;
  - Android caching.
- **Hardened runtime** for the Mac app (`ON-MACOS.md` Y7) is undecided.
- **The semester reminder** can't be tried for real until January.

## Working in this repo

- **Checks.** Run `pnpm lint` and `pnpm check` after your last edit.
  CI's api job also runs `pnpm exec cf deploy --dry-run` in `apps/api`.
- **No Android SDK or Xcode in the container.** Android and Mac changes
  are only built by CI, so say plainly what you couldn't run.
- **UI checks** use the dev stub (`node apps/api/scripts/dev-stub.mjs`)
  with Playwright and `/opt/pw-browsers/chromium`. See `CLAUDE.md` for its
  quirks.
  - A real street map can go in the gitignored `dev/map/campus.pmtiles`.
  - Block service workers in Playwright (`serviceWorkers: 'block'`), or
    they serve stale files.
- **Golden answers.** After an intended answer change, run
  `UPDATE_GOLDEN=1 pnpm test` and review the diff. The Android and Mac
  tests read the same fixtures.
- **Service worker version.** When web app files change, bump `SHELL` in
  `apps/web/public/sw.js`, so installed web apps pick up the change.
- **The owner's habits:**
  - push straight to `main`, no PR, when they say so;
  - watch CI after each push;
  - British spelling and plain words;
  - no Co-Authored-By or "Generated with" lines.
