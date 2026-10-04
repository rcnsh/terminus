# On the Mac

What's left for when you're back at the Mac, split in two: what Claude can
do there for you, and what only you can do (your keys, accounts, devices
and decisions). Delete this file once it's done.

## Where things stand (4 October)

- **Deployed:** production and the beta both run all of `main`, up to
  `89b6b0f`. No migrations pending.
  - The calendar refreshes itself: both sites answer from the copy the
    cron fetched (`/health` says `calendar.source: fetched`).
  - The API docs say 2.1.0, and on a phone they scroll as a page, so
    their end and their menu's clear Chrome's toolbar (checked on a
    phone).
  - Search: the landing page's title and description match what
    students search for, shared links show a preview card, and
    `robots.txt` and `/sitemap.xml` are live. The beta asks not to be
    crawled or indexed. Google hasn't been told about the site yet (Y6).
  - The web app and account page ask for all their modules at once,
    and the account page shows sign-in before it loads Settings
    (checked on both sites, no errors).
  - The deploy accepted the 5 s CPU limit, so the plan allows it.
- **History rewritten:** every commit message is in Conventional Commits,
  pushed with all the tags (Y1, done). The old `ccr-*` and `imgbot`
  branches are deleted.
- **Not released:** the apps are at 2.1.0 (build 44) on `main`, Android
  and Mac together, and the API docs say the same. The last release is
  2.0.4. It stays 2.1.0, not 3.0: everything since 2.0.4 adds to what was
  there, and nothing in the public API changed or went away.
- **Live buses checked:** the record live buses workflow ran on production
  on 3 October at 8:50 pm Singapore time. It recorded 3 buses for 10
  minutes, and none switched sides or jumped (C3).

## The order

1. **Claude:** get `main`, then build and test everything (C1, C2).
2. **Claude:** install the apps (C4). **You:** try them (Y3).
3. **Claude:** retake the screenshots (C5) and dry-run the release (C6).
4. **You:** read the release notes and say go (Y4). **Claude:** releases
   (C7). **You:** approve it on GitHub (Y4).
5. **You:** Cloudflare, GitHub and Google Search Console (Y5, Y6) and the
   open decisions (Y7), any time.

## Part 1: for Claude on the Mac

Point Claude at this section. Each step says what to run and what to check.
Ask the owner before anything marked **ask first**.

### C1. Get `main`

The history was rewritten on 2 October (authors) and again on 3 October
(messages), so a clone from before then has the old history. A plain
`git pull` would merge the old history into the new, so reset instead.
Check `git status` first: anything uncommitted is lost by the reset.

```sh
git checkout main
git fetch origin --tags --force    # the tags moved with the rewrite
git reset --hard origin/main
pnpm install --frozen-lockfile
```

### C2. Build and test everything

What CI runs:

```sh
pnpm lint && pnpm check
(cd apps/api && pnpm exec cf deploy --dry-run)
(cd apps/android && ./gradlew :app:lintStableDebug :app:testStableDebugUnitTest :app:compileBetaDebugKotlin)
(cd apps/macos && swift build && swift test)
```

All of it should pass. CI was green on every commit, so a failure here
points at this Mac's setup (Java 21, Xcode, the Android SDK).

### C3. Check the live sites

Everything deployed so far is checked: `/health` on both sites says
`ok: true` and `calendar.source: fetched`, `/openapi.json` says `2.1.0`,
and the record live buses workflow found no bus switching sides or
jumping on production. After any later deploy (Y2):

- `curl -s https://terminus.rcn.sh/health` and the same for
  `https://beta.terminus.rcn.sh/health`: `ok` is true on both.
- Optional: the 3 October recording was on a Saturday evening with only 3
  buses. A weekday daytime run would check many more:
  `gh workflow run record-buses.yml -f site=https://terminus.rcn.sh`. Its
  summary should report no bus switching sides or jumping. It uses a
  throwaway account and needs no secrets.
- `calendar.through` in `/health` (now 23 August 2027) moves past then
  once NUSMods lists 2027/2028. Nothing to do until then.

### C4. Install the apps

With the Android phone connected over USB and USB debugging on:

```sh
(cd apps/android && ./gradlew :app:installStableDebug)
(cd apps/macos && ./build.sh install)    # copies to /Applications and opens it
```

Then hand over to the owner for Y3.

### C5. Retake the out-of-date screenshots (ask first)

The README and the landing page use `apps/web/public/assets/shots/`. These
four show the old design:
- `app-light.webp` and `app-dark.webp`: the landing page's phone, with the
  old layout;
- `mac-light.webp` and `mac-dark.webp`: green route lines, from before the
  services' colours.

The web, map and widget shots are current.

- **Mac:** a debug build renders every state to PNGs:
  `TERMINUS_SNAPSHOT=<dir> swift run` in `apps/macos`. Pick the matching
  state, light and dark.
- **Android:** with the owner setting the phone up (light, then dark, on
  Now with a class card showing), `adb exec-out screencap -p > shot.png`.

Convert to WebP at the size and crop of the old files (`cwebp -q 85`), and
compare side by side before committing. Then run `.github/readme/render.sh`
(it needs `cwebp`): it redraws the README banners and the link preview
image (`apps/web/public/assets/og.png`), which show the landing page's
phone shot.

### C6. Dry-run the release

1. **The release workflow.** Dependabot moved its actions to new major
   versions (PR #4), and CI doesn't run it. Run it on `main` without a tag:
   `gh workflow run release.yml --ref main`. It builds, signs and packages
   the Mac app and publishes nothing. Read its log if it fails.
2. **The release script:** `scripts/release.sh --dry-run`. It tests,
   builds the signed split APKs (`terminus-2.1.0.apk` for arm64,
   `-armv7`, `-x86_64`) and uploads nothing. It needs the Android keystore
   settings in `~/.gradle/gradle.properties` (`TERMINUS_*`), which are on
   this Mac.

### C7. Release 2.1.0 (ask first: only after the owner says go in Y4)

`scripts/release.sh`: uploads the APKs to R2, tags `v2.1.0` and pushes the
tag. The tag starts `release.yml`, which waits for the owner's approval in
the `release` environment (Y4), then builds and signs the Mac DMG, writes
the Sparkle appcast and `latest.json`, and publishes the GitHub release.
Never create the tag or the release by hand. The workflow refuses a tag
that isn't on `main`.

### C8. When the owner decides (Y7)

- **Hardened runtime for the Mac app:**
  - sign with `--options runtime` in `apps/macos/build.sh` and
    `scripts/package-mac.sh`;
  - add an entitlements file with
    `com.apple.security.personal-information.location`;
  - the owner then checks that location, notifications and a Sparkle
    update still work.
- **Anything from the open decisions** list in Y7.
- **The `cf` CLI:** it's pinned at beta.5. Newer versions are refused
  until they're three days old (`minimumReleaseAge` in
  `pnpm-workspace.yaml`), so beta.11 is allowed from 5 October. When
  Dependabot's PR for it comes, check CI, and merge it if it's green (ask
  first).

## Part 2: only you

### Y1. Push the history rewrite (done, 3 October)

Pushed from the VPS, with all 35 tags, and the old `ccr-*` and `imgbot`
branches deleted. Any other clone made before 3 October needs C1's reset.

### Y2. Deploy from the VPS

Both sites run all of `main` (`89b6b0f`), so nothing waits for a deploy.
For the next one, from the VPS, in one line (beta first, then production):

```sh
git fetch origin --tags --force && git reset --hard origin/main && pnpm install --frozen-lockfile && (cd apps/api && pnpm run deploy:beta && pnpm run deploy)
```

Then ask Claude to check it (C3).

### Y3. Try the apps for real

CI built and tested everything, and Claude installs the apps (C4). These
checks need a real phone, a Mac and an iPhone.

**Android:**
- **Pairing:** pair with the account page's QR code. The dialog warns
  about codes from someone else.
- **Widgets:** tap a widget's place button; it opens that place.
- **Signing out:** the app keeps its language.
- **Map:**
  - Tap a service. Its buses keep moving along their roads between
    updates, on their own side of two-way roads. A bus never cuts across
    the road and never goes backwards.
  - Tap near a stop (not right on its dot), or on its name: it opens.
  - Tap a bus. Its card shows its number plate next to "D2 bus", and
    "Crowding: low" (or medium, high) in the daytime.
- **Wording:** read through Settings and the notifications; the wording
  was rewritten.
- **Tabs:** Now, Map and Settings fade through, and come back where you
  left them (scroll position, the map's view).
- **Settings:**
  - It's a list of groups. Each opens a page that slides in, and the back
    gesture pulls it away as you swipe. The notification switches are
    under Notifications now, not on Now.
  - Appearance: Light and Dark apply at once, the map and status bar
    included. Follow this phone goes back to the system's setting, and
    should switch when the system does.
  - Language and time › Time format: 12-hour and 24-hour change the card,
    the widgets and the notifications at once; Automatic follows the
    phone. A new account's setup asks "Show times as".
- **Opening:** the last plan shows straight away while it refreshes. The
  map keeps its place after the app is closed and reopened.
- **Nearby:** tap a stop; the map moves to it as its sheet opens.
- **During a trip** on Android 12–15: the live notification shows (it
  crashed before the fix).
- **Not going offline:** on the leave-by notification, tap Not going with
  the phone offline. The notification stays and nothing is skipped.
- **The card:** one quiet "Or go now" line, not a second plan.
- **Notification channels:** Android's own notification settings for
  terminus list a "New semester" channel. The reminder itself can't be
  tried until January.

**Mac:**
- **Tabs:** switch tabs; the new one fills straight away, not after a
  minute or two.
- **Wording:** setup and pairing were reworded.
- **Settings window:** Settings… in the menu opens a sidebar of groups,
  with a back arrow.
  - Appearance switches light and dark for the popover and every window.
  - Open at login, updates and language moved from the menu to here.
- **Badges** on light colours (A2, K) have dark text.
- **Time format:** Settings › Language and time › Time format, and "Show
  times as" in setup. The popover, the menu bar and notifications follow
  it.

**iPhone** (the web app on the Home Screen, iOS 18.2 or later):
- **Tabs:** Now, Map and Settings fade through, and the bar along the
  bottom stays put. Settings opens inside the app, with no page load.
- **Settings:**
  - It's a list of groups; a swipe from the left edge goes back from a
    group's page.
  - "Notify me when to leave" is under Notifications.
  - Appearance: Light and Dark apply at once, the map included.
- **Map:** the map shows streets, on both sites.
- **Offline:** open the app once, then turn on airplane mode and open it
  again. It starts and shows the kept plan.
- **Live buses:** they move continuously and stay on their own side of
  the road.
- **The Preact rebuild:** the website was rebuilt with Preact and should
  look and work as before. Run through it once:
  - sign in;
  - first-time setup with a new account;
  - every Settings page;
  - Now and Nearby;
  - the map's stops and buses;
  - Save as place, which should show in Settings straight away;
  - the landing page, the status page and the dashboard.

### Y4. Release 2.1.0

1. **Read the notes.** `RELEASE_NOTES.md` has the 2.1.0 notes: the map, the
   new Settings, Appearance, the 12- or 24-hour setting and the rest. Read
   them over and change anything you want said differently.
2. **Say go.** When the apps (Y3) and Claude's dry run (C6) look right,
   tell Claude to release (C7).
3. **Approve it.** The release workflow then waits for you: GitHub →
   Actions → the release run → Review deployments → approve `release`.
   It publishes the GitHub release, the DMG and the Sparkle update.
4. **Check the update.** Afterwards, the Android app's update button and
   the Mac's Check for updates… should both offer 2.1.0.

The release can also run from the VPS, once the Android keystore and
`~/.gradle/gradle.properties` are copied there (see `scripts/vps-setup.sh`).

### Y5. Cloudflare dashboard

Cloudflare has no spending cap, so set these once:

- **A billing alert:** Notifications → Add → Usage Based Billing (if it's
  listed for your account). Workers requests, say at 8 million a month,
  under the 10 million the plan includes.
- **A rate-limit rule** in front of the Worker. It also stops floods the
  Worker never sees (and isn't billed for).
  - Where: Security → WAF → Rate limiting rules → Create.
  - The rule: if the path starts with `/map/` or `/download/`, count per
    IP, 600 requests in 10 seconds, then block for 10 seconds. That's far
    above what a lecture hall opening the map on one Wi-Fi address asks
    for.
  - The free plan includes one rule.
- **Web Analytics:** after Y2, open a page and check that Analytics & Logs
  → Web Analytics shows visits within a few minutes. It counts browser
  page loads only, not the apps or the API; those are in Analytics Engine.
- **Requests:** for the first weeks of 2.1.0, keep an eye on Workers &
  Pages → terminus → Metrics → Requests.

### Y6. GitHub, Google and your own Claude setup

- **Security alerts:** GitHub → Settings → Code security: turn on
  Dependabot alerts and security updates. `.github/dependabot.yml`
  already handles routine updates.
- **Your own Claude setup:**
  - CLAUDE.md tells agents to work on a branch and commit as whoever they
    work for.
  - Your own "push straight to `main`, as me" lives outside the repo:
    `CLAUDE.local.md` (gitignored) on the Mac, or `~/.claude/CLAUDE.md`.
  - The cloud environment already has your git identity (set on 3
    October). Add a line there saying to push to `main` too.
- **Google Search Console:** add `terminus.rcn.sh` at
  https://search.google.com/search-console, verifying with the DNS TXT
  record it gives you (in Cloudflare, under rcn.sh's DNS). Then submit
  `https://terminus.rcn.sh/sitemap.xml` and use URL inspection → Request
  indexing on the home page. It shows within days whether Google has the
  site, and which searches find it.
- **Getting found:** links from elsewhere count most. Post it on r/nus and
  in hall, faculty and module Telegram groups, ask the student press, and
  list it on Google Play once it's ready (the listing ranks in Google too).
- **The street map** can be refreshed any time, from your phone: GitHub →
  Actions → **map tiles** → Run workflow (stable, beta or both). It also
  runs by itself on 1 January and 1 July.

### Y7. Decisions

Each of these needs your choice; Claude then does it (C8).

- **Hardened runtime for the Mac app:** more protection for the app, at
  the cost of a round of re-testing location, notifications and updates.

**Server load and cost:**
- Sign-in and new accounts are still limited per IP (`RL_MAIL`,
  `RL_ANON`); the map and answers are limited per account now. Turnstile
  on an app's first start would stop scripted sign-ups.
- Fonts could be served from our own domain, and the Chinese strings
  loaded only when Chinese is chosen. Offline, the pages fall back to the
  system fonts, because the service worker doesn't keep the web fonts.

**The API's answers:**
- A `?to=` that matches nothing isn't answered clearly.
- `youreHome` is labelled `live`, and `headwayS` is never filled in.

**The same on every app:**
- Should Today's heading and Nearby's wording come from the server, rather
  than each app writing its own?
- Chips are in a different order on different apps.
- Android-only features (ride progress, Go later, chips that stay put, the
  opposite stop): should the web and the Mac have them? The Mac also has
  no Not going button, and leaves some settings to the account page.
- Wording differs between apps: favourite or place, "Add a device", what
  the report link is called.

**The Mac:**
- The menu bar shows estimates without "~".
- A long popover has no maximum height.
- Some Settings errors aren't shown. Two quick saves can overwrite each
  other, and a save sends the whole profile.
- Signing out has no confirmation.

**Android:**
- Answers could be cached by the HTTP client.
- The live trip asks for GPS more often than it needs.
- The street map is downloaded on metered connections too.

**The web:** where the search button goes when the chips don't fit on one
line.
