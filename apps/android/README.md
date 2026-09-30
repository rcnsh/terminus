# terminus for Android

Home-screen widgets and a small app, in Kotlin with Compose and Glance.
Android 12 or later.

- **Widgets:** a compact one that says when to leave, and one with buttons for
  your saved places. They refresh themselves through the day.
- **App:** the same answer, nearby stops and search. Optional heads-up
  notifications before you need to leave, and a live notification.
- **Pairing:** scan the QR code on the account page, or type the code. The app
  handles `https://terminus.rcn.sh/pair` links.

## Run it

```bash
./gradlew :app:installDebug                                   # against terminus.rcn.sh
./gradlew :app:installDebug -PapiBase=http://localhost:8787   # against the dev stub
adb reverse tcp:8787 tcp:8787                                 # so the phone can reach it
./gradlew :app:lintDebug :app:testDebugUnitTest               # what CI runs
```

The unit tests read the same answer fixtures as the API's tests
(`apps/api/test/fixtures/answers`).

Push (Firebase Cloud Messaging) needs the Firebase app's config at
`app/google-services.json`, downloaded from the terminus Firebase project.
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
| `ui/` | The app's screens |
| `widget/` | The widgets and their refresh schedule |
| `LeaveAlerts.kt`, `LiveService.kt` | Heads-up and live notifications |

Release builds are signed with a key kept outside the repo; see
[`scripts/release.sh`](../../scripts/release.sh).
