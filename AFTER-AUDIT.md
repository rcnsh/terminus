# Back at the Mac

What's left after the security audit (PR #2), the campus map, the
redesign (tab motion, Settings as a list of groups, the theme choice) and
the second audit's fixes (2 October), for when you're back at the Mac.
Delete this file once it's done.

Already done, from the VPS: production and the beta are migrated, and both
have their street map on R2. As of 3 October, both are deployed up to
a548ce3: everything on `main`, the website and the API included (the
calmer card, the semester reminder, "Crowding: low/medium/high", the 12- or
24-hour setting, the feed-shape check). No migrations. Since then, not yet
deployed: 130c1ef (the map and /campus kept at the edge) and 4eb2b03 (the
bill guards: website files skip the Worker, a CPU limit, a limit on the
map's R2 reads). The Android and Mac parts ship with 2.1.0.

To deploy again from the VPS, in one line:

```sh
git fetch origin && git reset --hard origin/main && pnpm install --frozen-lockfile && (cd apps/api && pnpm run deploy:beta && pnpm run deploy)
```

## 1. Get main

`main`'s history was rewritten on 2 October (commits authored as you), so a
plain `git pull` would try to merge the old history into the new. Check for
local changes you want to keep first:

```sh
cd ~/path/to/terminus
git status                         # anything here is lost by the reset below
git checkout main
git fetch origin
git reset --hard origin/main
pnpm install
pnpm test && pnpm lint             # optional: as CI runs them
```

## 2. Try the apps

CI built and tested both; these are for using them for real.

Android (phone connected over USB):

```sh
cd apps/android
./gradlew :app:installStableDebug
```

- Pair with the account page's QR code: the dialog warns about codes from
  someone else.
- Tap a widget's place button: it opens that place.
- Sign out: the app keeps its language.
- Map: tap a service. Its buses keep moving along their roads between
  updates, on their own side of two-way roads. A bus never cuts across the
  road, and never goes backwards.
- Map: tap near a stop, not right on its dot, or on its name: it opens.
- Map: tap a bus. Its card shows its number plate next to "D2 bus".
- Read through Settings and the notifications: the wording was rewritten.
- Switch tabs: Now, Map and Settings fade through, and come back where you
  left them (scroll position, the map's view).
- Settings is a list of groups. Each opens a page that slides in; the back
  gesture pulls it away as you swipe. The notification switches are under
  Notifications now, not on Now.
- Settings › Appearance: Light and Dark apply at once, the map and status bar
  included. Follow this phone goes back to the system's setting.
- Open the app: the last plan shows straight away while it refreshes.
- Nearby: tap a stop. The map moves to it as its sheet opens.
- During a trip on Android 12–15: the live notification shows (it crashed
  before the fix).
- On the leave-by notification, tap Not going with the phone offline: the
  notification stays and nothing is skipped.
- The card: one quiet "Or go now" line, not a second plan.
- Map: a bus's card says "Crowding: low" (or medium, high) when the feed
  has it, which is in the daytime.
- Settings › Language and time › Time format: 12-hour and 24-hour change
  the card, the widgets and the notifications at once; Automatic follows
  the phone. A new account's setup asks "Show times as".
- Settings › Notifications in Android's own settings lists a "New semester"
  channel. The reminder itself can't be tried until January.

Mac:

```sh
cd apps/macos
swift test
./build.sh install                 # copies to /Applications and opens it
```

- Switch tabs: the new one fills straight away, not after a minute or two.
- Setup and pairing: the wording was rewritten.
- Settings… in the menu opens a Settings window: a sidebar of groups, and a
  back arrow. Appearance switches light and dark for the popover and every
  window. Open at login, updates and language moved from the menu to here.
- Badges on light colours (A2, K) have dark text.
- Settings › Language and time › Time format, and "Show times as" in setup:
  the popover, the menu bar and notifications follow it.

On the iPhone (the web app on the Home Screen, iOS 18.2 or later):

- Now, Map and Settings fade through, with the bar along the bottom staying
  put. Settings opens inside the app, with no page load.
- Settings is a list of groups; a swipe from the left edge goes back from a
  group's page. "Notify me when to leave" is under Notifications.
- Settings › Appearance: Light and Dark apply at once, the map included.
- The map, and the beta's at beta.terminus.rcn.sh/app/#map, shows streets.
- Open the app once, then turn on airplane mode and open it again: it
  starts and shows the kept plan (it stayed on "Checking…" before the fix).
- The website is now built with Preact (3 October), live on both sites. It
  should look and work as before. Worth a run through:
  sign in, first-time setup with a new account, every Settings page, Now,
  Nearby, the map's stops and buses, and Save as place showing in Settings
  straight away. Then the landing page, status page and dashboard.

Then retake the README's app shots, which are out of date (the web and map
ones are new): `apps/web/public/assets/shots/app-light.webp` and
`app-dark.webp` (the landing page's phone, with the old layout) and
`mac-light.webp` / `mac-dark.webp` (green lines, before the colours).

## 3. Release 2.1.0

The versions are bumped to 2.1.0 (build 44) on `main`, Android and Mac
together. `RELEASE_NOTES.md` has the 2.1.0 notes: the map, the new Settings,
Appearance and the rest. Read them over before releasing.

First, check the release workflow, whose actions Dependabot moved to new
major versions (PR #4) and CI doesn't run: GitHub → Actions → release → Run
workflow, on `main`. It builds, signs and packages the Mac app and publishes
nothing. Then:

```sh
scripts/release.sh --dry-run       # tests and the APKs, uploads nothing
scripts/release.sh                 # uploads the APKs and pushes the tag
```

Android comes as three APKs, one per CPU type: `terminus-2.1.0.apk` (arm64,
what the website serves), `-armv7` and `-x86_64`; the scripts build, upload
and attach all three. The workflow refuses a tag that isn't on `main`.

This can also run on the VPS once the Android keystore and
`~/.gradle/gradle.properties` are copied over (see `scripts/vps-setup.sh`).

## 4. Undecided: hardened runtime for the Mac app

Sign with `--options runtime` (in `apps/macos/build.sh` and
`scripts/package-mac.sh`) plus an entitlements file with
`com.apple.security.personal-information.location`, then check location,
notifications and a Sparkle update still work. Ask Claude to make the change
when you want it.

## 5. Not urgent: the `cf` CLI

`cf` is pinned at beta.5. `pnpm-workspace.yaml` has `minimumReleaseAge:
4320` (three days), so newer versions are refused until they're that old;
beta.11 is allowed from 5 October, 06:58 UTC. Nothing to do: Dependabot
will open a PR, and CI checks it.

## 6. Decide: what the second audit left open

The second audit (2 October) fixed what was clearly wrong and left these,
which each need a choice. Ask Claude to do any of them.

Server load and cost:

- Sign-in and new accounts are still limited per IP (`RL_MAIL`,
  `RL_ANON`); the map and answers are per account now. Turnstile on an
  app's first start would stop scripted sign-ups.
- Fonts could be served from our own domain, and the Chinese strings loaded
  only when Chinese is chosen.

The API's answers:

- A `?to=` that matches nothing isn't answered clearly.
- `youreHome` is labelled `live`; `headwayS` is never filled in.

The same on every app:

- Should Today's heading and Nearby's wording come from the server, rather
  than each app writing its own?
- Chips are in a different order on different apps.
- Android-only features (ride progress, Go later, chips that stay put, the
  opposite stop) on the web and the Mac? The Mac has no Not going button
  and leaves some settings to the account page.
- Wording differs: favourite or place, "Add a device", what the report
  link is called.

The Mac:

- The menu bar shows estimates without "~".
- A long popover has no maximum height.
- Some Settings errors aren't shown; two quick saves can overwrite each
  other, and a save sends the whole profile.
- Signing out has no confirmation.

Android:

- Answers could be cached by the HTTP client; the live trip asks for GPS
  more often than it needs; the street map is kept on metered connections
  too.
- Not checked on a phone: whether Follow this phone switches with the
  system's dark mode, and whether the map keeps its place across restarts.

The web: where the search button goes when the chips don't fit on one line.

## 7. Cloudflare Web Analytics: check it reports

Cloudflare adds its Web Analytics script to every page of both sites. The
CSP now allows it (the script from static.cloudflareinsights.com, reports
to cloudflareinsights.com), and the privacy page says the website uses it.
After deploying, open a page and check Analytics & Logs → Web Analytics
shows visits within a few minutes. It counts browser page loads only, not
the apps or the API; those are in Analytics Engine.

Also small, for later: offline, the pages fall back to the system fonts,
because the service worker doesn't keep the web fonts.

## 8. Cloudflare: two settings against a big bill

Cloudflare has no spending cap, so set these once, in the dashboard:

- **A billing alert.** Notifications → Add → Usage Based Billing (if it's
  listed for your account): Workers requests, say at 8 million a month,
  under the 10 million the plan includes.
- **A rate-limit rule** in front of the Worker, which also stops floods the
  Worker never sees (and isn't billed for): Security → WAF → Rate limiting
  rules → Create. If the path starts with `/map/` or `/download/`, count per
  IP, 600 requests in 10 seconds, then block for 10 seconds. That's far
  above what a lecture hall opening the map on one Wi-Fi address asks for.
  The free plan includes one rule.

The deploy now sets a CPU limit of 5 s per request (`limits.cpuMs` in
`apps/api/cloudflare.config.ts`). That needs the Workers Paid plan: if a
deploy refuses it, remove those three lines.

Then keep an eye on Workers & Pages → terminus → Metrics → Requests for the
first weeks of 2.1.0.

## 9. Optional: your own Claude setup

CLAUDE.md now tells agents to work on a branch and commit as whoever they
work for, so a contributor's agent never signs as you. Your own "push
straight to main, as me" lives outside the repo: in `CLAUDE.local.md`
(gitignored) on the Mac, or `~/.claude/CLAUDE.md`, and in the cloud
environment's settings (the git identity variables you set on 3 October).

## From your phone, any time

- GitHub → Settings → Code security: turn on Dependabot alerts and security
  updates. (`.github/dependabot.yml` already handles routine updates.)
- Refresh the street map: GitHub → Actions → **map tiles** → Run workflow
  (stable, beta or both). It also runs by itself on 1 January and 1 July.
