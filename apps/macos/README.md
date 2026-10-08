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

The map window needs the built app (`./build.sh`): MapLibre keeps its cache
by the app's bundle id, which `swift run` doesn't have.

`TERMINUS_SNAPSHOT=<dir> swift run` renders every screen with sample data to
PNGs and quits, for checking layout without clicking around.

## Where things are

| | |
| --- | --- |
| `Sources/Terminus/Api.swift` | The API client and the answer types |
| `Sources/Terminus/AppModel.swift` | State, refresh timing and pairing |
| `Sources/Terminus/*View*.swift`, `Header`, `Tabs`, `Search`, `Footer` | The popover |
| `Sources/Terminus/MapWindow.swift`, `MapData.swift`, `MapFiles.swift` | The map window: MapLibre, live buses, the street map kept on disk |
| `Vendor/MapLibre.xcframework.zip` | MapLibre Native for macOS, built by [`scripts/vendor-maplibre-mac.sh`](../../scripts/vendor-maplibre-mac.sh) from a pinned tag and commit; its SHA-256 is in `MapLibre.xcframework.zip.sha256`, which CI checks |
| `Support/` | `Info.plist` and the app icon |

Releases are built, signed and packaged as a DMG on the owner's Mac by
[`scripts/release.sh`](../../scripts/release.sh) (via
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
it once the popover, Settings and Setup are all closed (or at quit). An update installs only if its DMG is signed
with the update key (`SUPublicEDKey` in `Support/Info.plist`) and the app with
the terminus certificate. `TERMINUS_APPCAST=<url>` points a build at a test feed. A release build only takes
this and `TERMINUS_API_BASE` when they point at this Mac (localhost or 127.0.0.1).

Everything is signed with the hardened runtime. The self-signed certificate
has no Team ID, so library validation would refuse even our own re-signed
frameworks: the app alone gets `com.apple.security.cs.disable-library-validation`
(`Support/Terminus.entitlements`), plus the location entitlement the runtime
needs. `SUVerifyUpdateBeforeExtraction` makes Sparkle check the DMG's
signature before opening it. Releases also sign the appcast, so a later
version can set `SURequireSignedFeed`.

`./build.sh` signs with that certificate too if it's in your keychain, and
ad-hoc otherwise. An ad-hoc build is a new identity every time, so macOS asks
before letting it read the device token.
