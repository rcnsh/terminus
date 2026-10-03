# Back at the Mac

What's left after the security audit (PR #2), the campus map, the
redesign (tab motion, Settings as a list of groups, the theme choice) and
the second audit's fixes (2 October), for when you're back at the Mac.
Delete this file once it's done.

Already done, from the VPS: production and the beta are migrated and
deployed, and both have their street map on R2. The redesign, the second
audit's fixes and the website's move to Preact aren't deployed to production
yet (the beta has all but the Preact move). From the VPS, `git fetch origin && git reset --hard origin/main &&
pnpm install`, then in `apps/api`, `pnpm run deploy` and `pnpm run deploy:beta`.

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
- Map: tap a service. Its buses drive along their roads (a 15-second glide
  each time the feed moves them), on their own side of two-way roads.
- Map: tap near a stop, not right on its dot, or on its name: it opens.
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

On the iPhone (the web app on the Home Screen, iOS 18.2 or later):

- Now, Map and Settings fade through, with the bar along the bottom staying
  put. Settings opens inside the app, with no page load.
- Settings is a list of groups; a swipe from the left edge goes back from a
  group's page. "Notify me when to leave" is under Notifications.
- Settings › Appearance: Light and Dark apply at once, the map included.
- The map, and the beta's at beta.terminus.rcn.sh/app/#map, shows streets.
- Open the app once, then turn on airplane mode and open it again: it
  starts and shows the kept plan (it stayed on "Checking…" before the fix).
- The website is now built with Preact (3 October). It should look and work
  as before. Worth a run through on the beta first (`pnpm run deploy:beta`):
  sign in, first-time setup with a new account, every Settings page, Now,
  Nearby, the map's stops and buses, and Save as place showing in Settings
  straight away. Then the landing page, status page and dashboard.

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

- Rate limits are per IP (`RL_PUBLIC`, `RL_MAIL`, `RL_ANON`); on campus
  Wi-Fi many students share one. Per account would be fairer; Turnstile on
  an app's first start would stop scripted sign-ups.
- `/me/day` plans the whole day again on every 30-second poll; it could be
  kept per user for a short while.
- The morning's trip arming makes up to 2,000 Durable Object calls in one
  cron run; it should go in batches.
- Map tiles, fonts and `/campus` could be cached at the edge, or `/campus`
  given an ETag (or a `?part=map` that leaves out what the map doesn't use).
- Fonts could be served from our own domain, and the Chinese strings loaded
  only when Chinese is chosen.
- The service worker waits as long as the network takes before using its
  kept copy; a few seconds' timeout would help on a bad connection.

The API's answers:

- `/me/next` passes on a bus id hashed without a salt, so a plate could be
  worked out from it.
- A `?to=` that matches nothing isn't answered clearly.
- `youreHome` is labelled `live`; `headwayS` is never filled in.
- Some routes aren't in the OpenAPI spec.

The same on every app:

- Should the web count down every second, as Android and the Mac do?
- Should Today's heading and Nearby's wording come from the server, rather
  than each app writing its own?
- "Not going" or "Not going today": the button says both in places.
- Chips are in a different order on different apps.
- Walk minutes on some cards ignore the walking pace you set.
- Android-only features (ride progress, Go later, chips that stay put, the
  opposite stop) on the web and the Mac? The Mac has no Not going button
  and leaves some settings to the account page.
- Wording differs: favourite or place, "Add a device", how a packed bus is
  described, what the report link is called.

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

## 7. Cloudflare dashboard: turn off Web Analytics

Cloudflare adds its Web Analytics script to every page of both sites
(found on 3 October). The site's CSP blocks it, so nothing is sent, but
every page logs a blocked-script error, and the privacy page promises no
trackers. In the dashboard: Analytics & Logs → Web Analytics → the site →
turn off automatic setup. Leave the CSP as it is.

Also small, for later: offline, the pages fall back to the system fonts,
because the service worker doesn't keep the web fonts.

## From your phone, any time

- GitHub → Settings → Code security: turn on Dependabot alerts and security
  updates. (`.github/dependabot.yml` already handles routine updates.)
- Refresh the street map: GitHub → Actions → **map tiles** → Run workflow
  (stable, beta or both). It also runs by itself on 1 January and 1 July.
