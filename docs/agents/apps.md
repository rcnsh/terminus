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
  The script (about 15 minutes; `<pr>` works in a worktree of its own)
  writes the lockfiles and `verification-metadata.xml` in one run from an
  empty Gradle home, running every task CI runs (resolving every
  configuration fetches POMs no CI task asks for, and R8 files nothing
  else does); checks each new hash against its repository and adds the
  aapt2 jars for the other systems (`scripts/android_deps.py`), stopping
  on a changed hash for a version already listed; then runs CI's tasks
  again from another empty home with verification on. The empty home also
  keeps `~/.gradle/gradle.properties` (the signing keys) out of the build.
  It leaves the changes uncommitted and prints the commands that push them.
  How the workflow keeps Gradle away from its push token: ADR
  `0028-ci-jobs-split-by-what-they-hold.md`.
  - `kotlin-stdlib-common` is excluded from every configuration: it's an
    empty module since Kotlin 1.9.20, and Gradle keeps it in the graph
    only while the lock pins `kotlin-stdlib`, so writing the locks drops it
    and the next build refuses the lock it just wrote. `resolveAll`
    resolves every configuration (lenient, for their files' hashes), which
    the build tasks alone leave out.
  - `settings.gradle.kts` asks each group of the repository that publishes
    it (Google's Maven for Android, Google and androidx; Maven Central for
    the rest, the Kotlin plugin markers included; never the Gradle Plugin
    Portal), and lists them twice, since `pluginManagement` runs first:
    keep the two alike. ktfmt runs from its Maven Central jar for that
    reason, not through its plugin. The root `build.gradle.kts` applies
    the Kotlin Android plugin `apply false` only to pin the Kotlin version
    AGP's built-in Kotlin support uses, and pins a few of the plugins' and
    lint's dependencies above AGP's for advisories (issue #171).
  - The unit tests declare the files they read at run time (`fixtures/`,
    the strings, the Kotlin sources' text) as inputs, so a change to one
    reruns them rather than taking a cached pass.
- Mac (CI, macOS runner): `swift build && swift test`, then
  `swift build -c release --arch arm64` in `apps/macos`.
  `NearbyAccessibilityTests` reads the app's own accessibility tree, so
  it runs only where the test runner is trusted for accessibility (System
  Settings, Privacy & Security, Accessibility) and is skipped in CI.
  `MapWindowTests` drives a real `MLNMapView` from the vendored MapLibre.
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
    `TERMINUS_SCROLL=ground` scrolls Now to its steps, `foot` to its foot.
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
- iPhone scripts, in `apps/ios` (with no simulator given, each takes the
  booted one):
  - `scripts/run.sh [udid] [server]` builds into `build/dd` and runs the
    app on a simulator against the dev stub (`http://localhost:8787`), or
    `default` for the build's own server.
  - `scripts/ui-tests.sh [udid] [suite]` starts a stub on `PORT` (8799
    unless set), logging to `build/stub.log`, where the sign-in tests read
    their codes (`TERMINUS_STUB_LOG`), stops it by its PID after, and
    prints each test's result from `build/ui-tests.xcresult`. Each suite
    sets the stub's clock and hours itself (`/__stub/reset`, `/__stub/at`,
    `/__stub/freeze`, `/__stub/class?in=N`); `UITestSupport.swift` has the
    helpers.
  - `scripts/fetch-maplibre.sh` puts MapLibre's published iOS build (the
    release the Mac's is built from) in `Vendor/`, after checking the zip
    against the SHA-256 MapLibre publishes for SwiftPM.
  - `scripts/sideload.sh [--ipa]` (`TEAM=`, `DEVICE=` when there are
    several): `SIDELOAD.md`.
  - `swift Support/make-icon.swift [beta]` draws the app icon from
    `apps/web/public/assets/mark.svg`, opaque as the App Store wants, with
    a BETA band for the beta as the Mac's has.
  - `scripts/strings.py` reads every `L("…")` and
    `LocalizedStringResource("…")`; an `L(` whose phrase isn't a literal
    fails the check, since its Chinese could be missing unseen, so code
    words a countdown with literal phrases rather than building one. A
    phrase has one Chinese across all tables, and Chinese that takes the
    blanks in another order numbers them (`%2$@ … %1$@`).
- In `project.yml`, each target's `Support` source is the parent folder,
  so XcodeGen makes each strings table a localised variant group; the
  watch takes every table but the phone's `InfoPlist.strings`, and
  `NearbyCells.swift` from the app. `Sources/Widgets/LiveIntents.swift`
  is in the app target too (see internals.md, the iPhone app). The tests
  read `fixtures/` where it is (`FIXTURES`). watchOS 11 is the oldest the
  watch app supports.
- The mac and ios jobs are skipped when a run with exactly the same inputs
  has already passed (`swift-changes` in `ci.yml` hashes them). A file
  either job reads from outside its own app needs adding to that hash.
  Gradle's build cache does this for the Android jobs; `swift-changes`
  runs on Linux, so a skipped job never starts a macOS runner.
- Why the CI steps are there: the Android release builds are the only
  place R8 and resource shrinking run, so a missing keep rule shows there
  rather than in a released app; a job per flavour, since they share no
  compiled code. The mac job's swift-format check covers every Swift file,
  the iPhone's too; it checks `MapLibre.xcframework.zip` against its
  SHA-256 and that the framework links only macOS's own libraries, and
  builds Release too, since the debug build can pass where it fails. The
  iPhone unit tests are signed ad hoc: an unsigned app has no
  entitlements, so the simulator gives it no keychain. Its last step stops
  the simulator and Xcode's helpers, which otherwise hold the job open for
  about 40 minutes after it's done.
- **Android strings** need apostrophes escaped (`\'`).
