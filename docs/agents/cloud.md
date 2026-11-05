# Working from a Linux cloud session

What differs from the owner's Mac in a cloud container: no Android SDK or
Xcode, a proxy in front of the network, and no access to CI's logs and
artifacts host.

- In a Linux cloud container without the Android SDK or Xcode, you can't
  build those apps. Check pure-Kotlin logic another way if you can (for
  example `MapData.kt` with its JUnit test, using a standalone `kotlinc`
  plus `org.json` and JUnit jars), then let CI build the app. List
  what you couldn't run.
- Against the live sites (terminus.run, the beta), Chromium's own
  connections through the container's proxy fail at random
  (`ERR_TOO_MANY_RETRIES`) and its trust store may predate the proxy's
  certificate. Route the page's requests through Node instead
  (`context.route` with `fetch`, run with `NODE_USE_ENV_PROXY=1`), and use
  a temporary anonymous account (`POST /api/auth/anon`, then `DELETE /api/me`).
- The container has Chromium only (`/opt/pw-browsers/chromium`), no WebKit;
  don't run `playwright install`. For Safari, use a one-off workflow
  (Playwright WebKit on Linux, or an iOS Simulator on a macOS runner).
- **CI logs** can't be downloaded from the container (the log host is
  blocked). Read them with the GitHub tool `get_job_logs`
  (`return_content: true`); step results are in `gh api
  repos/rcnsh/terminus/actions/runs/<id>/jobs`.
- **Artifacts** can't be downloaded either; the owner opens them on GitHub.
  For evidence of a UI change in the apps, a one-off workflow can record an
  emulator (`adb shell screenrecord`) or render the Mac's snapshots
  (`TERMINUS_SNAPSHOT=<dir> swift run`, on `macos-latest`). Remove it once
  it's been watched.
