# Building and testing the apps

What CI runs for each app, and how to reproduce it. Android, Mac and
iPhone changes reach users only through a release
([releasing.md](releasing.md)).

- Android (CI): `./gradlew :app:ktfmtCheck :app:lintStableDebug :app:testStableDebugUnitTest :app:compileBetaDebugKotlin`,
  and beside it, a job each, `:app:assembleStableRelease` and `:app:assembleBetaRelease` (R8 and
  resource shrinking, unsigned without the keystore) in `apps/android`
  (Java 21).
- Android dependencies are locked and hash-checked. On a Dependabot Gradle
  PR, the `android deps` workflow writes the lockfiles and hashes and
  pushes them to its branch. After changing a version by hand, run
  `scripts/android-deps.sh` (or `scripts/android-deps.sh <pr>` for a PR
  the workflow didn't finish) and review the diff. Don't write hashes from
  a warm Gradle cache: CI's cold runners fetch files it leaves out.
- Mac (CI, macOS runner): `swift build && swift test`, then
  `swift build -c release --arch arm64` in `apps/macos`.
- iPhone (CI, macOS runner), in `apps/ios`: `python3 -I scripts/strings.py
  --check`, `scripts/fetch-maplibre.sh`, `xcodegen generate`, the unit tests
  (`-only-testing:TerminusTests`) on an iPhone simulator, then an unsigned
  Release build for `generic/platform=iOS`. The generated project, plists
  and entitlements aren't in git: `project.yml` is the source. CI doesn't
  run the UI tests: on a Mac, `apps/ios/scripts/ui-tests.sh [simulator]
  [suite]` starts a stub of its own, runs them against it and leaves
  screenshots in `apps/ios/build/shots`. Look at them. The whole UI
  suite takes about 35 minutes.
- Apple Watch (CI, in the ios job): the watch app (`TerminusWatch`) and
  its complications (`TerminusWatchWidgets`) are targets in
  `apps/ios/project.yml`, embedded in the iPhone app, so the Release build
  above builds them; the job also runs their unit tests
  (`-scheme "Terminus Watch" -only-testing:TerminusWatchTests`) on an
  Apple Watch simulator. What it shows and why: ADR 0016. They build
  `Sources/Shared` for watchOS (watchOS 11 and later), with their own code
  in `Sources/Watch` (`App`, `Widgets`, and `Common` for both) and their
  words in `Watch.strings`.
  - Simlock can't lease a watch simulator here (no paired runtime), and
    T3's device tools don't list one: make your own in Xcode's default set
    (`xcrun simctl create "Apple Watch Ultra 4 (49mm) (<branch>)"
    com.apple.CoreSimulator.SimDeviceType.Apple-Watch-Ultra-4-49mm
    com.apple.CoreSimulator.SimRuntime.watchOS-27-2`), drive it with
    `xcrun simctl` (`install`, `launch`, `io … screenshot`), and delete it
    after.
  - Run it against the dev stub with the same `TERMINUS_*` variables as
    the iPhone (`TERMINUS_API_BASE`, `TERMINUS_RESET=1`, `TERMINUS_TOKEN`,
    `TERMINUS_LANG`), as `SIMCTL_CHILD_TERMINUS_…` on `simctl launch`.
    In a debug build `TERMINUS_VIEW=nearby` (or `place:<key>:<label>`)
    opens on that view, `TERMINUS_SHOW=targets` on the list,
    `TERMINUS_SHOW=complications` on each complication family drawn in
    the app (a face can't be edited from a script), and
    `TERMINUS_SCROLL=foot` scrolls Now to its foot.
  - The UI test runs against a stub you start:
    `TEST_RUNNER_TERMINUS_STUB=http://127.0.0.1:$PORT xcodebuild test
    -scheme "Terminus Watch" -destination "id=<watch>"
    -only-testing:TerminusWatchUITests`. Its screenshots are attachments
    in the result bundle.
  - The hand-off from the phone: pair an iPhone simulator with the watch
    (`xcrun simctl pair <watch> <phone>`), install the iPhone app on the
    phone and `Terminus.app/Watch/TerminusWatch.app` on the watch, point
    both at the stub, open the watch app, then Settings › Devices › Set up
    your watch on the phone. The simulators drop `transferUserInfo`, so
    the code goes as the phone's application context and a message.
- The mac and ios jobs are skipped when a run with exactly the same inputs
  has already passed (`swift-changes` in `ci.yml` hashes them). A file
  either job reads from outside its own app needs adding to that hash.
- **Android strings** need apostrophes escaped (`\'`).
