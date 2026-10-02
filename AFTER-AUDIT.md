# Back at the Mac

What's left after the security audit (PR #2), the campus map and the
redesign (tab motion, Settings as a list of groups, the theme choice), for
when you're back at the Mac. Delete this file once it's done.

Already done, from the VPS: production and the beta are migrated and
deployed, and both have their street map on R2. The redesign isn't deployed
yet: from the VPS, `git fetch origin && git reset --hard origin/main &&
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

On the iPhone (the web app on the Home Screen, iOS 18.2 or later):

- Now, Map and Settings fade through, with the bar along the bottom staying
  put. Settings opens inside the app, with no page load.
- Settings is a list of groups; a swipe from the left edge goes back from a
  group's page. "Notify me when to leave" is under Notifications.
- Settings › Appearance: Light and Dark apply at once, the map included.
- The map, and the beta's at beta.terminus.rcn.sh/app/#map, shows streets.

## 3. Release 2.1.0

Bump the versions together (Android versionName/versionCode in
`apps/android/app/build.gradle.kts`, Mac CFBundleShortVersionString/
CFBundleVersion in `apps/macos/Support/Info.plist`) to 2.1.0 and commit to
`main`. `RELEASE_NOTES.md` has the 2.1.0 notes for the map and the audit,
but not yet the redesign (tab motion, the new Settings, Appearance, the
notification switches moving to Settings): add those first, or ask Claude
to.

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

## From your phone, any time

- GitHub → Settings → Code security: turn on Dependabot alerts and security
  updates. (`.github/dependabot.yml` already handles routine updates.)
- Refresh the street map: GitHub → Actions → **map tiles** → Run workflow
  (stable, beta or both). It also runs by itself on 1 January and 1 July.
