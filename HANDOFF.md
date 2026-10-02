# Handoff: 2 October 2026

For the next agent. Read `CLAUDE.md` first: it covers how the repo works and
the owner's conventions. This file covers what happened on 2 October, what's
deployed, what's half-done and what's next. Delete it once you've taken it in
and the in-progress work below has landed.

## The owner, and how they work

- **Identity.** Commit as the owner: `jacob <49075095+rcnsh@users.noreply.github.com>`,
  author and committer both, unsigned (`git config user.name jacob`,
  `git config user.email 49075095+rcnsh@users.noreply.github.com`,
  `git config commit.gpgsign false`). Don't add Co-Authored-By lines,
  session links or "Generated with" lines anywhere. These settings are in a
  clone's git config only, so set them at the start of every session.
- **Branches.** Push straight to `main`, with no PR unless asked. Watch CI on
  each push and fix anything red at once. A session's own working branch
  (`ccr-…`) is kept equal to `main`.
- **Where they are.** Away from their Mac until about 5 October. They have
  an **Android phone, no iPhone**, and a **Linux VPS** (Debian/Ubuntu x86_64)
  set up with `scripts/vps-setup.sh`. They deploy from the VPS:
  `git fetch origin && git reset --hard origin/main && pnpm install`, then in
  `apps/api`, `pnpm run deploy` (stable) and `pnpm run deploy:beta`. You
  can't deploy: cloud sessions have no Cloudflare token, and
  `terminus.rcn.sh` is blocked from the container.
- **Style.** They want plain, professional wording. They called out "Claude
  speak": colon-joined clauses, terminus talking about itself, jokey hints.
  The same goes for replies to them: short, concrete, no jargon.
- **Before big work,** they like to hear feasibility or a plan first. When
  they say "go", build it.

## History was rewritten

On 2 October all of that day's commits on `main` were rewritten (filter-branch)
so the owner is author and committer, without the Claude lines. Hashes from
before then (in old PRs #2–#8, or anyone's notes) no longer exist on `main`.
PRs #2–#8 are merged and closed; their descriptions had the session link
removed. To see what changed that day:

```sh
git log --since=2026-10-01T18:00Z --format='%h %s' main
```

## What was done on 2 October (oldest first)

Read the commits (`git show <hash>`) for detail; the subjects are accurate.

1. **Security audit (PR #2):** API hardening (atomic sign-in code tries in
   migration `0009_code_tries.sql`, mail limits per inbox, cross-site POST
   refusal, web push limited to push services, 180-day web session cap),
   client fixes, pinned CI actions, Dependabot. Then oxlint in CI (PR #5).
2. **Offline fallback (PR #6):** every app falls back to the kept `/me/day`
   plan when the answer is stale and the network is down
   (`app/offline.js`, `OfflineDay.kt`, `OfflineDay.swift`, tested against
   `test/fixtures/offline-day.json`).
3. **Campus map (PRs #7, #8):** `/campus`, `/buses`, `/map/*`, route shapes
   (`scripts/route_shapes.py` → `data/shapes.json`), the web Map tab
   (`apps/web/public/app/map.js`), the Android Map tab (`MapScreen.kt`,
   `MapData.kt`, `MapFiles.kt`), split APKs per CPU type. The plan and
   findings are in `docs/map-plan.md`.
4. **Map tiles:** `scripts/map-tiles.sh` and the **map tiles** workflow put
   the PMTiles file, fonts and icons on R2. Later fixed to upload per site:
   `CHANNEL=stable|beta|both` (the beta reads `terminus-beta-downloads`).
   Both buckets have the map now.
5. **VPS:** `scripts/vps-setup.sh` (non-interactive apt, Node 24, pnpm,
   Android SDK, swap), and `release.sh` uses plistlib instead of PlistBuddy
   so it runs on Linux.
6. **Live buses, after several rounds** (see `src/buses.ts` and its header):
   - A first version snapped each update to the nearest line, which put
     buses on the wrong side of two-way roads and merged them. It was
     reverted.
   - Final version: each bus's last place on its line is tracked per isolate
     (`lastPlace`, 120 s). The next match prefers the heading, then a place
     reachable since (−50 m to +100 m + 20 m/s × age), then the nearest.
   - Within 50 m of its line a bus is drawn on the line, and `/buses` returns
     `along` (metres along the line).
   - Clients poll every 5 s (`TTL.busesMs`). Each bus glides along its line
     for 15 s, only when its position changes: web `moveTo` in `map.js`,
     Android `Glides` in `MapData.kt`.
7. **Feed probe:** `apps/api/scripts/probe_buses.py` and the **probe live-bus
   feed** workflow. It measured that NUS moves a bus about **every 15–20 s**.
   Its report is a check-run annotation, which you can read with
   `gh api repos/rcnsh/terminus/check-runs/<job id>/annotations` (see
   "Gotchas" for why).
8. **Stops easier to tap:** the web uses a nearest-within-24 px pick on touch
   (`onClick` in `map.js`); Android uses `hitPadding = 24.dp` with
   `CampusMap.nearest()`. Stop names are tappable too.
9. **Docs:** `CLAUDE.md` written; every doc audited against the code and
   fixed.
10. **Wording:** about 110 strings rewritten across the web (`zh.js` keys),
    Android (`strings.xml`), Mac (`Localizable.strings`) and the server
    (`i18n.ts`), each with new Chinese. Commit `64160d5` has the list.
11. **Web cross-page fade (`b309eeb`):**
    - Cross-document view transitions, in `assets/tabbar.css`.
    - The account page shows the app's bottom bar when opened from the app
      (`account/in-app.js`, `?in=app`).
    - Now ↔ Map uses `document.startViewTransition`.
    - **The owner says it did nothing visible.** It's probably too subtle (a
      180 ms crossfade), and may not have been deployed. It's superseded by
      the redesign below.
12. `AFTER-AUDIT.md` was rewritten as the owner's "back at the Mac" checklist.

## Deployed state (as far as known)

- **Production and beta:** migration 0009 applied, Workers deployed,
  street maps on R2. The owner confirmed it after deploying from the VPS.
- **Unknown:** whether the latest commits are deployed (the wording rewrite
  and the web fade, possibly the stop taps). Ask before assuming.
- **Apps:** Android and Mac are still **2.0.4**. 2.1.0 (the map and
  everything above) isn't released. `RELEASE_NOTES.md` has its notes. The
  release needs the Android keystore, which is on the Mac.

## In progress: the cross-app redesign

The owner approved a four-step plan. Push after each step and show evidence
(videos or screenshots) before moving on.

### Step 1: Android tab motion (half done, NOT on main)

The work is saved as one commit on branch **`ccr-6bfb8175-pou0tm`**,
"WIP: Android tabs fade through…". It has **not been compiled**: there's no
Android SDK in the cloud container, and CI only builds `main` and PRs.

To pick it up:

```sh
git fetch origin ccr-6bfb8175-pou0tm
git show origin/ccr-6bfb8175-pou0tm --stat
git cherry-pick origin/ccr-6bfb8175-pou0tm     # onto main
```

Then push to `main` and watch the **android** CI job. If it's red, fix and
push. It holds the only compile check.

What the commit does:

- **`ui/MainActivity.kt` `Tabs()`:**
  - The `when (tab)` content is wrapped in
    `AnimatedContent(targetState = tab, transitionSpec = { fadeThrough() })`
    (Material fade through: out in 90 ms, in over 210 ms after a 90 ms delay,
    scale 0.92 → 1).
  - Each tab sits inside `rememberSaveableStateHolder().SaveableStateProvider(t.name)`,
    so scroll position and the map camera survive switching tabs.
  - The imports in that file were re-sorted alphabetically.
- **`ui/MapScreen.kt`:**
  - The map uses `uiOptions = MapUiOptions { renderMode = AndroidRenderMode.Texture }`,
    so it fades with the tab (a SurfaceView ignores alpha).
  - The first-view camera fit is guarded by `rememberSaveable framed`, and the
    pill's fit-to-line by `framedLine`, so coming back to the Map tab doesn't
    re-frame.
- **Not done, deliberately:** the plan said "keep the map alive in the
  background". Hiding a live GL map while it's still polling is risky, so the
  map is rebuilt on each visit but returns to the saved camera. Say so to the
  owner, or do the keep-alive properly: compose it once, hide it, and pause
  polling and glides while it's hidden.
- **API reference:** the maplibre-compose 0.19.0 source is on GitHub
  (`maplibre/maplibre-compose`, tag `v0.19.0`). `AndroidRenderMode` and
  `MapUiOptions(from) { … }` are in `lib/maplibre-compose/src/androidMain|commonMain/.../map/`.
- **Still to do for step 1:** a one-off workflow that runs the debug app on
  an Android emulator and **records video** (`adb shell screenrecord`) of
  switching tabs, uploaded as an artifact, for the owner to watch on their
  phone.
  - An earlier one-off emulator screenshot workflow existed. See commits
    `5fed1b6`, `18ebd1f`, `297c9f0`, `9832f62`, `2c521e1`, and `082a9d2`,
    which removed it. Reuse its setup: emulator action, debug flavour, the
    stub API.
  - Remove the workflow once it has served.
  - Artifacts can't be downloaded in a cloud session (see "Gotchas"), but
    the owner can open them on GitHub.

### Step 2: web, Settings inside the app

- Settings becomes a third view in `/app/`, with no page load.
- The account page's code (`apps/web/public/account/app.js`, ~930 lines, plus
  `account/index.html`) becomes a component that can draw into a container.
- `/account/` keeps working standalone for desktop, email sign-in links and
  onboarding, using the same component.
- Replace the view-transition fade from `b309eeb` with plain CSS/Web
  Animations fade-through, matching Android, so it works in every browser.
- Keep `account/in-app.js` only if it's still needed.
- **Testing:**
  - Playwright + Chromium against the dev stub, with video recording
    (`recordVideo`).
  - Because the owner has no iPhone, add a one-off **macOS-runner workflow**
    that boots an **iOS Simulator**, opens Mobile Safari on the dev stub
    (runner localhost) and records with `xcrun simctl io booted recordVideo`.
  - Also a Playwright **WebKit** run with an iPhone device profile, on CI,
    since WebKit isn't installed in the container.

### Step 3: Settings redesign on all three apps

A grouped list instead of one long page of cards, each row with a one-line
summary, opening a sub-page that slides in:

- **Your trips:** your day, home stop, walking pace, trip history.
- **Timetable:** import, your classes.
- **Favourites**
- **Notifications:** alerts, live notification, boarding detection (Android).
- **Devices**
- **Language**
- **Account:** email, sign out, delete account; API keys on the web.

Back works per platform: Android predictive back, browser history and swipe
on the web, a back arrow on the Mac. The Mac also gets a settings layout like
a standard macOS one, and a sliding highlight with a crossfade between its
popover tabs (`Tabs.swift`). Reuse the existing strings so the Chinese
carries over.

- Android: `ui/Settings.kt` (461 lines).
- Web: the account component from step 2.
- Mac: `Sources/Terminus/`; check it with `TERMINUS_SNAPSHOT` renders on CI.

### Step 4: polish

Already-seen content draws instantly while it refreshes, headers stay
consistent across tabs, and reduced motion turns slides into a fade.

## Other open items

- **`cf` CLI bump:** beta.5 is pinned. `pnpm-workspace.yaml` has
  `minimumReleaseAge: 4320` (three days), so newer versions are refused until
  they're old enough; beta.11 is allowed from 5 Oct 06:58 UTC. The owner
  said not to bother; Dependabot will open a PR.
- **2.1.0 release:** the steps are in `AFTER-AUDIT.md`. Bump Android 2.0.4 →
  2.1.0 (and versionCode) and the Mac Info.plist together. First do a test
  run of the release workflow (`workflow_dispatch`), since Dependabot moved
  its actions to new majors. If the redesign steps land first, they ship in
  2.1.0.
- **Mac hardened runtime:** undecided, and in `AFTER-AUDIT.md`.

## Gotchas found on 2 October

- **CI logs can't be downloaded** from a cloud session: the log blob host is
  blocked. Use `gh api repos/rcnsh/terminus/actions/runs/<id>/jobs` for step
  results, and check-run annotations for output (`::notice::` in a workflow,
  then `gh api …/check-runs/<job id>/annotations`). Reproduce failures
  locally where you can.
- **`pnpm lint` and `pnpm check` after the last edit.** A `'` inside a
  single-quoted string in `src/openapi.ts` broke the build once.
- **Android strings** need apostrophes escaped (`\'`). The web's Chinese is
  keyed by the exact English in `assets/zh.js`; change both together, or
  `web-i18n.test.js` fails.
- **Dev stub:** `node apps/api/scripts/dev-stub.mjs` on :8787. Sign in by
  POST `/auth/login`, then take the verify link from the stub's stdout and
  click its button. Live buses move every 18 s, like the real feed. Polling
  pages never reach "network idle" in Playwright, so wait for a URL or
  element instead.
- **Playwright:** Chromium is at `/opt/pw-browsers/chromium`; there's no
  WebKit. Don't run `playwright install`.
- **Kotlin unit checks without the SDK:** a standalone `kotlinc`
  (JetBrains GitHub release) plus `org.json` and `junit`/`hamcrest` jars from
  Maven Central can compile `MapData.kt` with `MapDataTest.kt`. Stub
  `BoardRow`, and leave out the `MapFiles` tests, which need Android.
  Anything Compose needs CI.
- **The beta** has its own D1, KV, R2 bucket and Analytics dataset
  (`cloudflare.config.ts`).

## Prompt for the next agent

> You're continuing work on terminus (github.com/rcnsh/terminus). Read
> `CLAUDE.md`, then `HANDOFF.md` at the repo root: it says what happened on
> 2 October, what's deployed, and the redesign in progress. Set the git
> identity it gives before committing. Start with step 1: cherry-pick the WIP
> commit from branch `ccr-6bfb8175-pou0tm` onto `main`, push, and get the
> Android CI job green. Then add the one-off emulator workflow that records a
> video of switching tabs, and tell me where to watch it. Ask me before
> moving on to step 2.
