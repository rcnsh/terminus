# terminus for Android

Home-screen widgets and a small app, in Kotlin with Compose and Glance.
Android 12 or later.

- **Widgets:** a compact one that says when to leave, and one with buttons for
  your saved places. They refresh themselves through the day.
- **App:** Now · Buses · Map · Settings along the bottom. Now has the same
  answer, nearby stops and search; Buses has what's coming at a stop and
  where a service's buses are along its line. Optional heads-up notifications before you need
  to leave, and a live notification.
- **Map:** the campus with every route in its colour (maplibre-compose), live
  buses for the service picked, and a sheet for each stop. The street map
  file is downloaded once to the phone and read from there; until it's
  there, routes and stops show on a plain map.
- **Pairing:** scan the QR code on the account page, or type the code. The app
  handles `https://terminus.rcn.sh/pair` links.

## Run it

```bash
./gradlew :app:installStableDebug                                   # against terminus.rcn.sh
./gradlew :app:installBetaDebug                                     # against beta.terminus.rcn.sh
./gradlew :app:installStableDebug -PapiBase=http://localhost:8787   # against the dev stub (debug builds only)
adb reverse tcp:8787 tcp:8787                                       # so the phone can reach it
./gradlew :app:lintStableDebug :app:testStableDebugUnitTest :app:compileBetaDebugKotlin   # what CI runs, with the
./gradlew :app:assembleStableRelease :app:assembleBetaRelease       # release builds (R8)
```

There are two apps from the same code (product flavors). **stable** is
`sh.rcn.terminus`, on Google Play and the website. **beta** is
`sh.rcn.terminus.beta`, "terminus beta", with the icon inverted and BETA by
the name. It uses `beta.terminus.rcn.sh` and its own accounts, and installs
beside the stable app.

### Dependencies are locked and checked

Every resolved version is pinned in `app/gradle.lockfile` (plus
`buildscript-gradle.lockfile` and `settings-gradle.lockfile` for the plugins),
and every downloaded file's SHA-256 is in `gradle/verification-metadata.xml`:
a build fails on an artefact whose bytes or version changed. Each group comes
only from the repository that publishes it (`settings.gradle.kts`), and the
wrapper checks Gradle's own download (`distributionSha256Sum`). After changing
a version in `gradle/libs.versions.toml` (or merging a Dependabot PR), write
both again and review the diff:

```bash
./gradlew :app:resolveAll buildEnvironment --write-locks
./gradlew :app:resolveAll buildEnvironment :app:lintStableDebug --write-verification-metadata sha256
```

Gradle only records what the machine it runs on downloads, and `aapt2` comes
as one jar per system: after an Android Gradle Plugin bump, add the `-linux`
(CI) and `-windows` jars' SHA-256 by hand, checked against the `.sha1` Google
Maven publishes beside each, or CI fails verification.

A release build without the `TERMINUS_*` key properties comes out unsigned,
never signed with the debug key.

The unit tests read the same answer fixtures as the API's tests
(`apps/api/test/fixtures/answers`).

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

## Where things are

| | |
| --- | --- |
| `Api.kt` | The API client and the answer types |
| `MapData.kt`, `MapFiles.kt`, `ui/MapScreen.kt` | The map: its data, what it keeps for offline, and the screen |
| `ui/` | The app's screens |
| `widget/` | The widgets and their refresh schedule |
| `LeaveAlerts.kt`, `LiveService.kt` | Heads-up and live notifications |

Release builds are signed with a key kept outside the repo; see
[`scripts/release.sh`](../../scripts/release.sh). They come as one APK per
CPU type (arm64, 32-bit ARM, x86_64): `terminus-<v>.apk` is the arm64 one,
which the website serves by default; the app's update button asks for its
own type (`/download/android?abi=`). Play builds from the bundle and splits
by itself.
