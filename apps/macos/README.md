# terminus for Mac

A menu bar app in SwiftUI. It shows when to leave in the menu bar; click it for
the bus, your saved places, nearby stops and search. macOS 14 or later on Apple
silicon.

## Run it

```bash
swift run                                            # against terminus.rcn.sh
TERMINUS_API_BASE=http://localhost:8787 swift run    # against the dev stub
swift test                                           # tests on the API's answer fixtures
./build.sh                                           # build/terminus.app
./build.sh install                                   # also copy to /Applications and open it
CHANNEL=beta ./build.sh                              # build/terminus beta.app, for beta.terminus.rcn.sh
```

`TERMINUS_SNAPSHOT=<dir> swift run` renders every screen with sample data to
PNGs and quits, for checking layout without clicking around.

## Where things are

| | |
| --- | --- |
| `Sources/Terminus/Api.swift` | The API client and the answer types |
| `Sources/Terminus/AppModel.swift` | State, refresh timing and pairing |
| `Sources/Terminus/*View*.swift`, `Header`, `Tabs`, `Search`, `Footer` | The popover |
| `Support/` | `Info.plist` and the app icon |

Releases are built, signed and packaged as a DMG by
[`.github/workflows/release.yml`](../../.github/workflows/release.yml) (via
[`scripts/package-mac.sh`](../../scripts/package-mac.sh)) with the terminus
self-signed certificate, so every version has the same code identity and macOS
keeps its location permission and login item across updates. It isn't
notarised, which needs a paid Apple Developer account, so macOS asks once on
first open. Without an Apple Team ID the keychain would still ask for the
device token after every update, since it knows each version only by its code
hash, so the token is kept in a file only you can read instead
(`~/Library/Application Support/terminus/device-token`; see `TokenStore`).

Installed copies update themselves with [Sparkle](https://sparkle-project.org)
(`Sources/Terminus/Updater.swift`): every 6 hours they check
`/download/appcast.xml`, download a new version in the background and install
it when the popover is closed. An update installs only if its DMG is signed
with the update key (`SUPublicEDKey` in `Support/Info.plist`) and the app with
the terminus certificate. `TERMINUS_APPCAST=<url>` points a build at a test feed. A release build only takes
this and `TERMINUS_API_BASE` when they point at this Mac (localhost or 127.0.0.1).

`./build.sh` signs with that certificate too if it's in your keychain, and
ad-hoc otherwise. An ad-hoc build is a new identity every time, so macOS asks
before letting it read the device token.
