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
  screenshots in `apps/ios/build/shots`. Look at them.
- The mac and ios jobs are skipped when a run with exactly the same inputs
  has already passed (`swift-changes` in `ci.yml` hashes them). A file
  either job reads from outside its own app needs adding to that hash.
- **Android strings** need apostrophes escaped (`\'`).
