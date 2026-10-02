# Back at the Mac: after the security audit (PR #2)

What's left now that the audit fixes are on `main`. Nothing is live until
step 3: `main` isn't deployed automatically. Delete this file once it's done.

## 1. Get main

```sh
cd ~/path/to/terminus
git checkout main
git pull
pnpm install
pnpm test          # optional: the API tests, as CI runs them
```

## 2. Sign in to Cloudflare (skip if already signed in)

```sh
cd apps/api
pnpm exec cf auth login        # opens the browser
```

## 3. Production: migration first, then deploy

The order matters. Until migration 0009 has run, the new code can't check the
emailed sign-in code (the emailed link still works).

```sh
pnpm exec cf d1 migrations apply 27067356-8691-458f-bc69-fa5ca5bbc374
pnpm run deploy                # `pnpm run deploy`, not `pnpm deploy` (pnpm's own command)
```

Check it:

- `https://terminus.rcn.sh/pair?code=ABC234` shows the "Pair a device" page,
  not `{"error":"sign in first"}`.
- Sign in on the website with the emailed **code** once: that's the path
  the migration is for.

## 4. Beta (only if you use it)

```sh
pnpm exec cf d1 migrations apply d7f309ef-6e3a-457f-a106-154fa797b933
pnpm run deploy:beta
```

## 5. Try the apps

CI built and tested both; these are for using them for real.

Android (phone connected over USB):

```sh
cd ../android
./gradlew :app:installStableDebug
```

- Pair with the account page's QR code: the dialog warns about codes from
  someone else.
- Tap a widget's place button: it opens that place.
- Sign out: the app keeps its language.

Mac:

```sh
cd ../macos
swift test
./build.sh install             # copies to /Applications and opens it
```

- Switch tabs: the new one fills straight away, not after a minute or two.

## 6. Release (when you want the app changes out)

Bump the versions together first (Android versionName/versionCode, Mac
CFBundleShortVersionString/CFBundleVersion), commit to `main`, then:

```sh
scripts/release.sh --dry-run   # tests and the APK, uploads nothing
scripts/release.sh             # uploads the APK and pushes the tag
```

The release workflow now refuses a tag that isn't on `main`, so release from
`main`.

## 7. Undecided: hardened runtime for the Mac app

Sign with `--options runtime` (in `apps/macos/build.sh` and
`scripts/package-mac.sh`) plus an entitlements file with
`com.apple.security.personal-information.location`, then check location,
notifications and a Sparkle update still work. Ask Claude to make the change
when you want it.

## From your phone, any time

- GitHub → Settings → Code security: turn on Dependabot alerts and security
  updates. (`.github/dependabot.yml` already handles routine updates.)
