# terminus for Android

Home-screen widgets and a small app, in Kotlin with Compose and Glance.
Android 12 or later.

- **Widgets:** a compact one that says when to leave, one with buttons for
  your favourites, and "Buses near you": the nearest stop's buses at any
  size (from 4×2 up, beside the stop across the road), with their arrival
  times and where each stops next. Times are clock times ("11:48"), worked
  out once per fetch, with a countdown the phone ticks for a bus in the next
  hour, so the widget only redraws when a bus is due or the times turn old.
  They refresh themselves through the day.
- **App:** Now · Nearby · Stops · Map · Settings along the bottom. Now has
  the same answer and the search; Nearby has the stops around you as their
  signs; Stops has what's coming at a stop and where a service's buses are
  along its line. Optional heads-up notifications before you need
  to leave, and a live notification.
- **Map:** the campus with every route in its colour (maplibre-compose), live
  buses for the service picked, and a sheet for each stop. The street map
  file is downloaded once to the phone and read from there; until it's
  there, routes and stops show on a plain map.
- **Pairing:** scan the QR code on the account page, or type the code. The app
  handles `https://terminus.run/pair` links.

## Run it

```bash
./gradlew :app:installStableDebug                                   # against terminus.run
./gradlew :app:installBetaDebug                                     # against beta.terminus.run
./gradlew :app:installStableDebug -PapiBase=http://localhost:8787   # against the dev stub (debug builds only)
adb reverse tcp:8787 tcp:8787                                       # so the phone can reach it
./gradlew :app:ktfmtFormat                                          # format the Kotlin (ktfmt; ktfmtCheck in CI)
./gradlew :app:ktfmtCheck :app:lintStableDebug :app:testStableDebugUnitTest :app:compileBetaDebugKotlin   # what CI runs, with the
./gradlew :app:assembleStableRelease :app:assembleBetaRelease       # release builds (R8)
```

There are two apps from the same code (product flavors). **stable** is
`sh.rcn.terminus`, on Google Play and the website. **beta** is
`sh.rcn.terminus.beta`, "terminus beta", with the icon inverted and BETA by
the name. It uses `beta.terminus.run` and its own accounts, and installs
beside the stable app.

Settings, About, Developer switches the server among the ones built in: the
site's two addresses and, in a debug build, the dev stub (through `adb
reverse`, or from the emulator). It's always there in debug and beta builds;
in a stable release, tap the version seven times. The stub keeps its own
sign-in, so a real account's token never goes to it.

### Dependencies are locked and checked

Every resolved version is pinned in `app/gradle.lockfile` (plus
`buildscript-gradle.lockfile` and `settings-gradle.lockfile` for the plugins),
and every downloaded file's SHA-256 is in `gradle/verification-metadata.xml`:
a build fails on an artefact whose bytes or version changed. Each group comes
only from the repository that publishes it (`settings.gradle.kts`), and the
wrapper checks Gradle's own download (`distributionSha256Sum`). After changing
a version in `gradle/libs.versions.toml`, write them again from the
repository's root. Dependabot edits only the build files, so on its PRs the
`android deps` workflow (`.github/workflows/android-deps.yml`) runs the same
script and pushes the result to the PR's branch; run it by hand for a PR the
workflow didn't finish:

```bash
scripts/android-deps.sh 42   # PR #42, in its own worktree under build/
scripts/android-deps.sh      # this checkout, after a hand edit
```

It writes the lockfiles and the hashes from an empty Gradle home, as a fresh
CI runner starts: Gradle only records what it downloads, and a warm cache
leaves out files a cold runner fetches, so CI then fails now and then. It
checks each new hash against the SHA-1 its repository publishes, stops on a
hash that changed for a version already listed, and adds the `-linux`,
`-osx` and `-windows` jars of `aapt2` (one per system; Gradle records only
this machine's). Then it builds as CI does from another empty home and
leaves the changes for you to review, printing the commands that commit and
push them.

A release build without the `TERMINUS_*` key properties comes out unsigned,
never signed with the debug key, so a build that missed the key can't pass
for a release. `-PapiBase` only changes debug builds, so a stray property in
`~/.gradle/gradle.properties` can never ship a release that talks to a
laptop. The beta's `versionName` comes from release-beta.sh (`-PbetaVersion`,
the next stable version's pre-release, numbered by commit).

The Play bundle keeps every language (`bundle.language.enableSplit = false`):
Chinese can be chosen in the app whatever the phone's language. The APKs are
split per CPU type (MapLibre's native code is about 4.5 MB a type) with native
code compressed (a third the size), and the split is off while building the
bundle, since AGP refuses a bundle with splits on, so release.sh builds them
in separate runs.

The unit tests read the same answer fixtures as the API's tests
(`fixtures/answers`).

Push (Firebase Cloud Messaging) needs the Firebase app's config at
`app/google-services.json`, downloaded from the terminus Firebase project.
Each flavor reads the entry for its own package, so the beta has push once
`sh.rcn.terminus.beta` is added to the project and the file downloaded again.
It's kept out of git; the build reads it into `BuildConfig.FIREBASE_*` and the
app sets Firebase up in code (no Google Services Gradle plugin). Without it the
app builds and works as on a phone without Play services: its own alarms and
refresh, no push. The dev stub pushes for real when
`.private/fcm-service-account.json` is present, and `GET /__stub/push` lists
the devices that registered.

## How it's built

When the widgets and alerts refresh, and how often the app asks: ADR
[0023-android-refresh-on-alarms](../../docs/adr/0023-android-refresh-on-alarms.md).
What else looks odd but is deliberate:

- **The activity is never recreated for dark mode or the language**
  (`onConfigurationChanged`), so Compose redraws with no blank screen.
  Android 12 has no per-app language: there `Lang.wrap` applies it in
  `attachBaseContext` and the activity restarts (`recreateOn12`).
- **Links.** The activity is exported, so a `terminus://to` link (a place
  looked up) is taken only from the app's own widgets; another app could
  otherwise add places with names of its choosing.
- **Updates.** At most once a day the app asks the website for a newer
  version, but not when Play installed it (`installedFromPlay`): Play
  updates it itself, and gets a release only after review, so the site's
  version would be announced early.
- **Theme** (`ui/Brand.kt`). `surfaceVariant` differs from every container
  colour: Material picks a card's text colour by matching its background in
  the scheme, and a tie with `surfaceVariant` turns every card's text grey.
  The theme's content sits in a `Surface`, without which a `Text` with no
  colour is black in the dark. Every colour over the sky (`SkyInk`), the
  late red and warning amber too, reads at 4.5:1 over any hour's sky (large
  words 3:1).
- **The map** (`ui/MapScreen.kt`) is a TextureView, not a SurfaceView, so
  it fades with the tab. The pan limits (`PanLimit`) are worked out for the
  zoom the map is at, so they're loosened while the code moves the camera
  (`MapCover.loosened`): from further out, on a window wider than a phone,
  they'd hold the centre away from campus. A bus is an icon, not a circle,
  so a bus at a stop can sit beside the dot, turning with the road. Only
  `BusLayers` reads the frame clock, so a sliding bus redraws three layers
  and not the map. A screen reader can't reach the stops or buses, so the
  map says so and offers the same as a list on the Stops tab.
- **Back** between a page and the one under it is Android's own
  cross-activity animation (AOSP's `DefaultCrossActivityBackAnimation`),
  drawn by `PageStack` (`ui/Peel.kt`) rather than by a transition, so the
  swipe and the release each keep their own curve.
- **Scroll across layouts.** Stops and Settings share each page's
  `ScrollState` by key between the one-pane and two-pane layouts
  (`PaneScrolls`): the other layout draws the page in the same frame the
  first lets it go, before saved state would be handed over.
- **Pull to refresh** (`ui/BusPull.kt`) runs its loop as a job, not an
  effect keyed on a flag: the loop ending and a touch starting it again
  inside one frame leave the flag as it was, and a pull would stay at
  "Checking…" for good.
- **Location.** After two refusals Android stops showing its dialog. The
  app tells that from a dialog closed with Back by whether Android would
  have explained itself before the ask and whether the dialog paused the
  app (`Onboarding.kt`, `LocationAsk.kt`), and then sends you to the app's
  settings page.
- **Signing out** cancels every request for the account together (one
  `SupervisorJob` per view model), and `Store.saveAnswer` drops a reply
  asked for with a token that's gone, so nothing of the old account lands
  after.

Glance, which draws the widgets, has limits the layouts work round:

- A `Row` or `Column` holds at most 10 children, so gaps are padding
  rather than Spacers, long lists sit in nested Columns, and a row has at
  most 8 buttons (`WidgetModes.MAX_BUTTONS`) or pager dots.
- It can't measure text: how many buttons fit a row is estimated at
  7.2 dp a character, 28 dp of padding each and 6 dp between
  (`WidgetModes.fitting`), as a button cut in half is worse than one
  fewer. It can't colour part of a line either, so the headline is three
  Texts in a row.
- A weighted `Text` beside the clock's RemoteViews gets no width, so it
  sits in a `Box`. The home screen's sizes come a fraction short of whole
  dp, so a layout counts a dp to spare (`NearbyFit.of`).
- `SizeMode.Exact` composes once per size, so what's read is shared
  between sizes (`Latest`). A running Glance session only sees a new answer
  through its state, so `redrawWidgets()` bumps `VERSION`.
- A widget's pictures share a memory budget: the sky is drawn at most
  2.5 px per dp. Its words' colours are fixed per theme rather than
  following the phone's, since the sky is a picture drawn for one theme
  and the words must change with it at the same redraw.
- Each button's PendingIntent has a URI of its own per widget and mode,
  or they'd share one.

## Where things are

| | |
| --- | --- |
| `Api.kt` | The API client and the answer types |
| `MapData.kt`, `MapFiles.kt`, `ui/MapScreen.kt` | The map: its data, what it keeps for offline, and the screen |
| `ui/` | The app's screens |
| `widget/` | The widgets and their refresh schedule |
| `LeaveAlerts.kt`, `LiveService.kt` | Heads-up and live notifications |

Release builds are signed with a key kept outside the repo; see
[`scripts/release/release.sh`](../../scripts/release/release.sh). They come as one APK per
CPU type (arm64, 32-bit ARM, x86_64): `terminus-<v>.apk` is the arm64 one,
which the website serves by default; the app's update button asks for its
own type (`/download/android?abi=`). Play builds from the bundle and splits
by itself.
