# On the Mac

What's left for when you're back at the Mac, split in two: what Claude can
do there for you, and what only you can do (your keys, accounts, devices
and decisions). Delete this file once it's done.

## Where things stand (3 October)

- **Deployed:** production and the beta are deployed up to the bill guards
  (`17dc7d9`), with no migrations pending.
- **Not deployed yet:** the calendar refreshing itself (`d85239b`), and
  whatever lands after it.
- **Not released:** the apps are at 2.1.0 (build 44) on `main`, Android
  and Mac together. The last release is 2.0.4.
- **History rewrite waiting:** every commit message has been rewritten to
  Conventional Commits, but GitHub refused the force-push from the cloud
  session. It's waiting in `terminus-rewritten.bundle`, which Claude sent
  you in chat. Step Y1 below pushes it.

## The order

1. **You:** push the history rewrite, or decide not to (Y1).
2. **Claude:** get `main`, then build and test everything (C1, C2).
3. **You:** deploy from the VPS (Y2). **Claude:** check it worked (C3).
4. **Claude:** install the apps (C4). **You:** try them (Y3).
5. **Claude:** retake the screenshots (C5) and dry-run the release (C6).
6. **You:** read the release notes and say go (Y4). **Claude:** releases
   (C7). **You:** approve it on GitHub (Y4).
7. **You:** Cloudflare and GitHub settings (Y5, Y6) and the open decisions
   (Y7), any time.

## Part 1: for Claude on the Mac

Point Claude at this section. Each step says what to run and what to check.
Ask the owner before anything marked **ask first**.

### C1. Get `main`

The history was rewritten on 2 October (authors), and, once Y1 is done,
again on 3 October (messages). A plain `git pull` would merge the old
history into the new, so reset instead. Check `git status` first: anything
uncommitted is lost by the reset.

```sh
git checkout main
git fetch origin --tags --force    # the tags moved with the rewrite
git reset --hard origin/main
pnpm install --frozen-lockfile
```

If `git log -1 --format=%s` starts with `feat`, `fix`, `chore` or similar,
the rewrite is on GitHub. If not, Y1 hasn't happened: carry on, and tell
the owner.

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

### C3. After the owner deploys (Y2)

- `curl -s https://terminus.rcn.sh/health`:
  - `ok` is true;
  - `calendar.source` is `fetched` once the cron has run (within 15
    minutes of the deploy);
  - `calendar.through` goes past August 2027 once NUSMods lists 2027/2028.
- Do the same for `https://beta.terminus.rcn.sh/health`.
- Run the **record live buses** workflow on production while buses run
  (weekdays, daytime): `gh workflow run record-buses.yml -f
  site=https://terminus.rcn.sh`. Its summary should report no bus
  switching sides or jumping. It uses a throwaway account and needs no
  secrets.

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
compare side by side before committing.

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

### Y1. Push the history rewrite

Every commit's message is in Conventional Commits now (`feat(map): …`,
`fix(api): …`, `chore(release): terminus 2.0.4`):
- the files, authors and dates are unchanged;
- every tag points at its rewritten commit;
- long one-line subjects became a short subject with the original text
  as the body.

GitHub refused the force-push from the cloud session, so it has to come
from you. The bundle holds all 5 branches and 35 tags.

1. If `main` has branch protection against force-pushes, turn it off
   (GitHub → Settings → Branches).
2. Push the bundle:
   ```sh
   git clone --mirror terminus-rewritten.bundle terminus-rewritten.git
   cd terminus-rewritten.git
   git push --force https://github.com/rcnsh/terminus 'refs/heads/*:refs/heads/*' 'refs/tags/*:refs/tags/*'
   ```
3. Turn the protection back on.

Do it before anything else lands on `main`: a push in between (Dependabot,
the Monday scrape, a cloud session) would be overwritten. If something has
landed since 3 October, ask Claude to put it on top of the rewritten
history first.

If you'd rather not rewrite, delete the bundle. The commit that switches
to the convention from now on (CLAUDE.md, CONTRIBUTING.md, the scrape
workflow, Dependabot, `release-notes.py`) is only in the bundle, so ask
Claude to make it on the current `main` instead.

### Y2. Deploy from the VPS

No migrations. From the VPS, in one line (beta first, then production):

```sh
git fetch origin --tags --force && git reset --hard origin/main && pnpm install --frozen-lockfile && (cd apps/api && pnpm run deploy:beta && pnpm run deploy)
```

The deploy sets a CPU limit of 5 s per request (`limits.cpuMs` in
`apps/api/cloudflare.config.ts`). That needs the Workers Paid plan: if the
deploy refuses it, remove those three lines and deploy again. Then tell
Claude to check it (C3).

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

### Y6. GitHub and your own Claude setup

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
