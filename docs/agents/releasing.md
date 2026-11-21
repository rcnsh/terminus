# Deploying and releasing

Read before a deploy, applying a migration, a version bump, a beta or a
release.

- **Deploying.** `main` is **not** auto-deployed.
  - Deploy from `apps/api` with `pnpm run deploy` (not `pnpm deploy`, which
    is a pnpm built-in). It first runs `scripts/deploy/predeploy.mjs`, which
    refuses unmerged files, conflict markers or uncommitted changes in
    `apps/api` and `apps/web/public` and runs `pnpm check`; then it applies
    the stable D1's pending migrations and runs `cf deploy`. A file counts as
    conflicted only with both `<<<<<<<` and `>>>>>>>` lines (Markdown's setext
    headings use `=======`), and predeploy runs before the migrations, so a
    refused deploy changes nothing. It needs
    Cloudflare credentials: `CLOUDFLARE_API_TOKEN`, or a browser login
    with `pnpm exec cf auth login`, which `cf` keeps on the machine.
    `pnpm exec cf auth whoami` says which is in use; a missing token in
    the shell doesn't mean a deploy can't run.
  - The beta is `pnpm run deploy:beta`, with its own D1, KV and R2; it
    applies the beta D1's migrations the same way, then runs
    `scripts/deploy/smoke.mjs https://beta.terminus.run --account`: a
    throwaway account asks for a trip and steps to the later bus. After a
    production deploy, run `node scripts/deploy/smoke.mjs https://terminus.run` from `apps/api`
    (no `--account`: pages and health only, no account made). A feed outage
    is a warning, not a failure, since the deploy can be fine while NUS is
    down; `--account` is skipped when no bus runs, and its anonymous account
    goes after 60 days unused.
  - Each deploy is labelled with its commit (`--message`), so which commit
    is live is the newest message in
    `pnpm exec cf workers deployments list --worker terminus --per-page 3`
    (`terminus-beta` for the beta). The Worker name goes in `--worker`, and
    the output is already JSON.
  - By hand, a migration is applied **before** deploying:
    `pnpm exec cf d1 migrations apply <db-id>` (ids are in
    `cloudflare.config.ts`; `test/deploy.test.js` checks the scripts match).
  - Migrations must be additive, since the old Worker runs on the new schema
    until the deploy lands: no renames, drops or `NOT NULL` without a default.
    Change a column in steps (expand, backfill, contract; see
    `docs/internals.md`), and never edit a migration already applied.
    `test/deploy.test.js` enforces this: an `ALTER TABLE` that drops,
    renames or adds `NOT NULL` without a default fails unless the file has a
    `-- contract:` line, and applied migrations are locked by hash in
    `test/fixtures/migrations.sha256` (append a new one's line once it's
    applied to both databases).
  - `wrangler` is only installed in `apps/api`, so run wrangler/R2 commands
    from there.
  - Server-side changes, the website included, are live for everyone once
    deployed. Android, Mac and iPhone changes need an app release.
- **Releasing.**
  - **Which version.** Whenever a release, a beta or a version bump comes
    up, work the version out this way and say why, rather than guessing or
    taking the next number. Compare against the last stable tag,
    `T=$(git describe --tags --abbrev=0 --exclude='*-beta*')`. App code
    means `apps/android/app/src/main`, `apps/macos/Sources`,
    `apps/macos/Support`, `apps/ios/Sources` and `apps/ios/Support`.
    1. **No release:** nothing in app code changed
       (`git diff --quiet $T HEAD -- <app code>`). Server and website
       changes only need `pnpm run deploy`; docs, tests, CI and scripts
       need nothing.
    2. **Major** (`x+1.0.0`): only for a break: an app no longer updated
       stops working, users must sign in or set up again, a feature is
       removed, or an endpoint in `/docs` changes incompatibly. Ask the
       owner first; this is rare.
    3. **Minor** (`x.y+1.0`): any `feat` commit touching app code
       (`git log --format=%s $T..HEAD -- <app code> | grep '^feat'`), or
       anything a user would notice as new. Goes through a beta first.
    4. **Patch** (`x.y.z+1`): everything else, that is fixes, wording and
       performance in the apps. May go straight to stable when small or
       urgent.
  - **Betas** are named after the stable version they become: a minor's
    betas are `x.y+1.0-beta.n`, never a patch's number. Cut one whenever
    there's something worth testing on real phones, as often as that is: a
    fix to a bug in the last beta goes out straight away rather than waiting
    for a quiet day. Batch what's ready rather than one per commit; quick
    iteration before that uses debug builds and the dev stub. After the
    first beta of a version, only fixes join it;
    new features wait for the next minor. A beta soaks for at least one
    full campus day before it becomes stable, and the stable release is the
    exact commit of the last beta. Anything newer means another beta first
    (a hotfix patch is the exception).
  - Before running either script, tell the owner the version, which rule
    picked it and the commits that decided it.
  - Bump Android `versionName`/`versionCode` (`apps/android/app/build.gradle.kts`),
    the Mac `CFBundleShortVersionString`/`CFBundleVersion`
    (`apps/macos/Support/Info.plist`), the iPhone's `MARKETING_VERSION`/
    `CURRENT_PROJECT_VERSION` (`apps/ios/project.yml`) and `API_VERSION` (`apps/api/src/openapi.ts`,
    the version on the API docs) together. A test fails if the versions
    differ, or if `versionCode`, `CFBundleVersion` and
    `CURRENT_PROJECT_VERSION` do. The release scripts don't build the
    iPhone app; it goes to the App Store by hand (below).
  - Push `main`, wait for CI to pass, deploy the Worker (`pnpm run deploy`),
    then run `scripts/release/release.sh --dry-run` and `scripts/release/release.sh` on the
    owner's Mac. It refuses a commit that isn't `origin/main` or whose CI
    hasn't passed, a live API older than this version (deploy first), a
    build number not above the live one, an APK not signed with the key in
    `assetlinks.json`, a Sparkle signature that doesn't verify with
    `SUPublicEDKey`, an ad-hoc signed Mac app, a Mac binary linking a
    library outside macOS (Homebrew's, say), notary credentials that don't
    work, or an `apiBase` Gradle property. Then it tests; builds the signed
    split APKs and the Mac DMG, signed with Developer ID and notarised by
    Apple (app and DMG, tickets stapled), with its Sparkle appcast; uploads the APKs and the DMG to R2; tags
    and pushes `v<version>` (the appcast links to the tag's page); uploads
    the appcast and `latest.json`; and publishes the GitHub release. Nothing
    waits for an approval. A dry run builds into `build/dry-run/`; a release
    that stops partway prints what's live and the commands that finish it.
  - Betas use `scripts/release/release-beta.sh <x.y.z-beta.n>`, on the same Mac,
    with the same checks: also from `origin/main` with CI passed. It deploys
    the beta Worker itself and uploads nothing until that deploy has
    finished (a beta keeps `API_VERSION`, so the live API's version can't
    tell the new Worker from the old).
  - Both start from the lockfiles: they delete `node_modules` and
    `apps/macos/.build`, then install with `--frozen-lockfile` and
    `--force-resolved-versions`. The Sparkle key only goes to a `sign_update`
    matching `SIGN_UPDATE_SHA256` in `scripts/release/release-lib.sh`; a Sparkle bump
    means updating `SPARKLE_VERSION` and that hash (check the new zip
    against the checksum in Sparkle's `Package.swift` first). The appcast
    itself is signed too, and nothing may edit it afterwards.
  - **How the scripts work.** Pinning and the clean install are ADR
    `0029-outside-code-pinned-by-our-own-hashes.md`; the rest:
    - `release.sh` takes `--dry-run` and nothing else, `release-beta.sh`
      one version and `--dry-run`: a mistyped flag (`--dryrun`) would
      otherwise publish, with no prompt. `release.sh` unsets `CHANNEL`,
      `BETA_VERSION` and `BETA_BUILD`, so a shell left from a beta can't
      make it one. A version is matched whole (`[[ =~ ]]`, never
      `echo | grep`, which passes a value with a newline in it), as it
      names a directory that's deleted, R2 keys and the tag. Android's
      version is read from `defaultConfig`'s literal lines only.
    - The working tree must be clean, untracked files included (SwiftPM
      and Gradle build whatever is on disk), and `HEAD` must be
      `origin/main`, so the tag and the notes match GitHub. CI must have
      passed on the commit, since the release runs only the API tests;
      the one exception is the weekly scrape's commit, pushed with
      `github.token`, which never starts CI: a commit with one parent, the
      bot as author and committer, and only `SCRAPE_DATA` changed in place
      (the same list as `scrape.yml`'s `DATA`, a test checks) counts as
      passed when the commit under it did.
    - The live site is read before building and again before uploading:
      `latest.json` for the version, the appcast for the build (Sparkle
      compares `CFBundleVersion`, Android `versionCode`, so a build not
      above the live one reaches nobody). With no answer a real release
      stops rather than pass for want of one. A beta's build number is the
      commit count, so it only rises along main. A beta keeps
      `API_VERSION` and the Worker exposes no commit id, so its live check
      can't tell the new Worker from the old: the finished
      `pnpm run deploy:beta` (which applies the beta D1's migrations first)
      is what says it's up. A stable version can go out on the beta too,
      so beta installs move onto it.
    - Android builds twice: ABI splits are off for the bundle, and AGP
      refuses a bundle in a run that also splits. The APKs are
      `terminus-<v>.apk` (arm64, the name older apps and links know),
      `-armv7` and `-x86_64`. The `.aab` is for Play Console and goes
      nowhere else. `apksigner` prints `Signer #1 certificate SHA-256
      digest:` in build-tools 36 and `V2 Signer: certificate SHA-256
      digest:` (a line per scheme) in 37; both are read.
    - The Mac app is signed by the Developer ID certificate's SHA-1, and
      its designated requirement names the team, not the certificate, so
      a renewed certificate keeps it: macOS ties the app's location
      permission and login item to it, and a release under another would
      lose them on every Mac. `package-mac.sh` (`SIGN_IDENTITY`,
      `SIGN_KEYCHAIN`, `PUBLISH=true`, `NOTARY_PROFILE`, `CHANNEL=beta`
      with `BETA_VERSION`/`BETA_BUILD`, `RELEASES`) refuses to publish an
      ad-hoc signed app, checks `codesign --deep --strict`, the hardened
      runtime on everything that runs, and that every binary links only
      `/System`, `/usr/lib` and `@rpath`/`@executable_path`/`@loader_path`.
      `notarytool` exits 0 when it rejects an upload, so the status is read
      from its answer; on a locked screen it says the keychain profile is
      missing, so that's checked first. `hdiutil create` runs once, with no
      retry: its "Resource busy" is a fault of GitHub's macOS runners that
      doesn't show on the owner's Mac, so a failure is real and stops with
      hdiutil's error and `hdiutil info` (what's attached). Stapling changes the
      DMG, so the Sparkle signature is made after it, and checked with
      `verify-sparkle.swift <public key> <signature> <file>` against the
      app's `SUPublicEDKey`, as an installed app checks it. The appcast
      escapes every value: one that breaks stops every Mac updating.
    - Uploads go files first (the APKs and the DMG, which nothing links to
      yet), then the appcast, then `latest.json`, stopping at the first
      failure, so `/download/*` never points at a file that isn't there.
      For stable the tag is pushed before the feeds, as the appcast links
      to its page. They use `wrangler r2 object put` from `apps/api`, not
      `cf r2 objects put`, which percent-encodes the key's slashes.
    - `github-release.sh <version> [--notes]` (`CHANNEL=beta` for a beta)
      lists the commits since the previous release past its betas
      (`--exclude='*-*'`); only the very first release may have no previous
      tag, or a failed lookup would publish the wrong notes.
      `release-notes.py` drops the Conventional Commits prefix, the version
      bump and image-bot commits, and keeps each subject's first sentence
      ("e.g." and "i.e." end none).
    - Shell under `set -euo pipefail`: no `| head` or `| grep -q` on a
      pipe that may still be writing (the early close fails it); `if !
      cmd` rather than `cmd && …` (set -e doesn't stop for a failure left
      of `&&`); a check that may `die` isn't run inside `$(…)`, where it
      would only leave the subshell.
  - Agents don't create GitHub releases or tags by hand; the scripts do.
  - **The iPhone app** goes to App Store Connect (app 6825759345, team
    `BUKSCHP3SV`) from the owner's Mac, by hand, after the stable release,
    from the same clean worktree. The listing is in `apps/ios/store/`.
    - Xcode must be signed in to the team's Apple Account, and the team
      needs a registered device (the Mac counts): automatic signing makes a
      development profile before it archives, and fails with "no devices"
      without one.
    - In `apps/ios`: `scripts/fetch-maplibre.sh && xcodegen generate`, then
      `xcodebuild -project terminus.xcodeproj -scheme Terminus
      -configuration Release -destination generic/platform=iOS
      -archivePath build/appstore/terminus.xcarchive
      -derivedDataPath build/dd-release DEVELOPMENT_TEAM=BUKSCHP3SV
      -allowProvisioningUpdates archive`.
    - Check the archive's entitlements (`codesign -d --entitlements -` on
      `Terminus.app`, each `PlugIns/*.appex`, `Watch/TerminusWatch.app` and
      its `PlugIns/TerminusWatchWidgets.appex`): the app group in all five,
      and push, Time Sensitive and `applinks:terminus.run` in the app.
    - A new target's App ID gets its capability from automatic signing but
      not its app group: archiving fails with "doesn't match the
      entitlements file's value for the com.apple.security.application-groups
      entitlement" until `group.sh.rcn.terminus` is ticked under the App ID's
      App Groups in the developer portal (or the target's Signing &
      Capabilities in Xcode). Then delete its cached profile in
      `~/Library/Developer/Xcode/UserData/Provisioning Profiles` and archive
      again. Never archive with `CODE_SIGNING_ALLOWED=NO`: the export then
      signs the app without any of them, and widgets and push break.
    - Upload: `xcodebuild -exportArchive -archivePath
      build/appstore/terminus.xcarchive -exportPath build/appstore/upload
      -exportOptionsPlist store/ExportOptions.plist
      -allowProvisioningUpdates`. A warning that MapLibre has no dSYM is
      expected.
    - When Apple has processed it (an email, minutes to an hour), pick the
      build on the version's page in App Store Connect and add it for
      review. Release is manual: the owner presses Release after approval.
      Push needs the stable Worker's `APNS_*` secrets (set; the key is
      `~/.terminus/AuthKey_9NH85A3927.p8`).
- **Signing keys.** The Android keystore (`~/.gradle/gradle.properties`
  `TERMINUS_*`), the Mac's Developer ID Application certificate (in the
  login keychain, from `~/.terminus/developer-id.p12`), the notary
  credentials (the keychain's `terminus-notary` profile, an app-specific
  password), the Sparkle key
  (`~/.terminus/sparkle-ed25519.key`) and the APNs key
  (`~/.terminus/AuthKey_*.p8`) live off-repo, only on the owner's Mac.
  The iPhone's distribution certificate is Apple's cloud-managed one, used
  through Xcode's sign-in.
