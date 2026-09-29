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

The build is ad-hoc signed, not notarised, so macOS asks once on first open.
