# Campus map: plan

A Map tab on Android and in the web app: a street map of campus with the
bus routes on it, where tapping a stop shows what's coming and what you can
do from there. Decided 2 October 2026 and built the same day: all three
phases are done (PR #7). Phase 0's findings are below.

## What it is

- **A bottom tab bar** on Android and in the web app: **Now · Map ·
  Settings.**
  - **Now** is today's screen as it is: the answer card, the chips (Next,
    your places, Nearby) and the Today list.
  - **Map** is the new map.
  - **Settings** is the settings screen on Android and the account page on
    the web.
  - On a wide desktop window the web bar can sit at the top.
- **The map:**
  - a real street map, kept quiet so the routes and stops stand out;
  - light or dark with the phone or browser;
  - bus routes drawn along their real roads in each service's colour;
  - stop names once zoomed in;
  - a dot for you, only when location is already allowed (the map never
    asks for it);
  - **a row of service pills along the top** (A1 · A2 · D1 · D2 · K · P ·
    R1 · R2), like the chips on Now. Tapping one shows that service's line
    and its **live buses**, and fades the other lines; tapping another
    switches to it; tapping it again turns it off. One at a time. The buses
    move every few seconds while a pill is on.
  - Tapping a live bus shows a small card: the service, how full it is and
    its next stop. No plate number.
- **Service colours,** as on the buses: A1 red, A2 yellow, D1 pink, D2
  purple, K light blue, P grey, R1 orange, R2 green. The API gives them, so
  every app uses the same ones.
  - It opens on your nearest stop when location is allowed, otherwise on
    the whole campus.
- **Tapping a stop** opens a sheet with:
  - live arrivals with minutes and crowding, refreshing while open (offline,
    it says so);
  - the services that stop there, with their lines highlighted on the map;
  - **Go there:** Now, with the answer card for that stop, as search does;
  - walking directions to the stop;
  - **Save as place:** adds it to the chips and the widget.
- **Offline:** the campus map and the stop and route data stay on the
  device after the first view.
- **Libraries:** MapLibre. maplibre-compose on Android (native Kotlin and
  Compose; it also runs on iOS), MapLibre GL JS on the web. Same map style on
  both.
- **Map data:** a PMTiles file of the area from the OpenStreetMap-based
  Protomaps build, in the existing R2 bucket, served by the Worker from our
  own domain. No third party sees map views, and there's no API key.
- **Android download size:** split APKs by CPU type, so a sideloaded install
  grows by only its own share of MapLibre.

## Phases

### Phase 0: confirm the risky parts first

1. maplibre-compose and MapLibre Native:
   - current versions and whether they're maintained;
   - fit with Compose BOM 2026.09, Kotlin 2.4 and Android 12+;
   - APK size per CPU type.
2. Road shapes for the routes:
   - **Plan A:** the NUS feed, if it has a route-shape endpoint (checked
     with a one-off workflow, since the keys only exist in GitHub Actions).
   - **Plan B:** route stop to stop along OpenStreetMap roads when the
     scrape runs.
3. The map file:
   - cut the area out of the Protomaps build;
   - size, and how far to zoom;
   - serving it in pieces from R2 through the Worker (HTTP range requests).
4. Label fonts and map icons for MapLibre, self-hosted.

### Phase 1: data and API (PR 1)

- Route shapes in the repo's data, made by the scrape and sanity-checked by
  `check_scraped.py`.
- `/campus` gains:
  - route lines as GeoJSON;
  - each stop's services;
  - the services' new colours.
- `/buses?svc=` gives a service's live buses: position, heading, crowding
  and next stop (worked out from the route line), cached 5 s per service (10 s at first; 5 s since 2 October, with the maps gliding the whole way between updates).
- `/map/*` serves:
  - the PMTiles file from R2, by range and long-cached;
  - light and dark styles in the app's colours;
  - label fonts and icons.
- `scripts/map-tiles.sh` builds and uploads the map file. The "map tiles"
  workflow runs it: by hand once after this merges, then by itself on
  1 January and 1 July.
- The site's security policy gains only what MapLibre needs to run. All map
  requests stay on our own domain.

### Phase 2: web app (PR 2)

- Bottom bar in `/app/`: Now and Map within the page, Settings opens
  `/account/`.
- The Map tab with MapLibre GL JS (served from our own domain,
  `scripts/vendor-map.sh`) and the stop sheet.
- Offline: the service worker keeps the style, fonts and the campus area's
  tiles.
- Screenshots in a headless browser: light, dark, English, Chinese, online
  and offline.

### Phase 3: Android (PR 3)

- Material 3 bottom navigation; the settings screen becomes the Settings
  tab.
- The Map tab with maplibre-compose (OpenGL runtime), the same pills, live
  buses, bus card and stop sheet as the web.
- Your dot from the app's own location helper, only with permission
  already granted.
- Offline: MapLibre doesn't cache PMTiles it streams, so the app downloads
  the campus map file once (checked weekly) and reads it from storage
  (`pmtiles://file://`); `/campus` and the style are kept beside it.
- All new strings in English and Chinese.
- Split APKs by CPU type:
  - Gradle builds one APK per CPU type: arm64, 32-bit ARM, x86_64 (the
    types MapLibre ships);
  - `release.sh`, `release-beta.sh` and `github-release.sh` upload each;
  - `latest.json` lists them in `androidAbis`, and `android` stays the
    arm64 one, so older apps and links keep working;
  - `/download/android` serves arm64, `?abi=` the others;
  - the in-app update button asks for its own CPU type.
  - Play Store installs are unaffected.

## Needs the owner

- Looking at the Android map on a real phone (CI builds and tests it, but
  can't look at it).
- Running the "map tiles" workflow once (Actions tab, Run workflow) after
  Phase 1 is merged and deployed, to put the map file on R2.

## Phase 0 findings

### 0.1 Libraries

- **maplibre-compose** has moved to `org.maplibre.compose:maplibre-compose` (0.19.0, released 1 October 2026).
  - Maintained in the MapLibre organisation, and very active.
  - Built with Kotlin 2.4.20 and Compose 1.12. Needs Android minSdk 24 (the app is 31).
  - Runs on Android, iOS, desktop and web.
  - Android needs a render runtime alongside it: `maplibre-compose-runtime-vulkan-android` (or the OpenGL one).
  - Offline packs (a bounding box and zoom range, downloaded and then used automatically) work on Android and iOS, but not in the browser.
  - The location dot never asks for permission itself.
- **MapLibre Native Android** 13.6.1 is what maplibre-compose uses. Its native code per CPU type:

  | | arm64 | armv7 | x86 | x86_64 |
  |---|---|---|---|---|
  | uncompressed | 12.8 MB | 9.5 MB | 13.2 MB | 13.4 MB |
  | compressed | ~4.5 MB | ~3.9 MB | ~4.6 MB | ~4.6 MB |

  The build tools store native code uncompressed by default, so a universal APK would grow by about 49 MB. A per-CPU arm64 APK grows by about 13 MB, or about 4.5 MB with `packaging.jniLibs.useLegacyPackaging = true`; that's the plan.
- **Web:** `maplibre-gl` 6.11.2 and `pmtiles` 4.5.0 on npm. cdnjs is unreachable from the build container, so the web app will serve MapLibre from our own domain (copied from npm), not cdnjs. That keeps the site's security policy same-site and lets the service worker cache it for offline use.

### 0.2 Route shapes

- **Plan A is out.** The bus proxy has no route-shape endpoint: `check-point`, `checkpoint`, `route`, `routes`, `polyline`, `service-description` and the like all return 404.
- The proxy does have `active-bus`: the live position, heading and crowding of each bus on a route. That's what the map's live buses use.
- **Plan B:** route each service stop to stop along OpenStreetMap's drivable roads, respecting one-way streets and choosing the correct side of the road at each stop. Probed with a one-off workflow, since Overpass (OpenStreetMap's query service) can't be reached from the build container.
- **Plan B works.** Every service was routed with no leg that detours oddly (more than 2.5× the straight line and 400 m longer), and every stop is within 45 m of its road:

  | | A1 | A2 | D1 | D2 | K | P | R1 | R2 |
  |---|---|---|---|---|---|---|---|---|
  | by road | 4.6 km | 5.5 km | 4.8 km | 7.4 km | 6.5 km | 18.4 km | 3.8 km | 3.8 km |
  | × straight lines | 1.21 | 1.25 | 1.28 | 1.24 | 1.18 | 1.37 | 1.19 | 1.24 |
  | furthest stop from road | 34 m | 34 m | 45 m | 45 m | 18 m | 26 m | 26 m | 26 m |

  All eight together come to 82 KB of GeoJSON before simplifying; simplified, a few tens of KB.
- **OpenStreetMap already has all eight services** as route relations ("NUS Svc A1" … "NUS Svc R2", network "NUS ISB"), hand-mapped and of unknown age. Routing our own from the stop order the feed gives keeps the lines matching the stops; the relations are a cross-check if a line ever looks wrong.
- **Drawn without the street map** (it can't be downloaded into the build container), the lines follow the stops' order around campus with no stray loops. The first look over the map is in Phase 2's screenshots.

### 0.3 The map file

- The Worker serves R2 files today without range support. R2's `get(key, { range: request.headers })` handles it, so serving `206` partial responses is a small addition.
- The Protomaps build server can't be reached from the build container; the file is cut in the one-off workflow.
- **Cut from the 1 October 2026 build** (OpenStreetMap as of that morning) with `pmtiles extract`, which reads only the parts it needs (about 4 MB fetched):

  | area | zoom | size |
  |---|---|---|
  | campus and Botanic Gardens (103.755–103.830 E, 1.280–1.332 N) | 0–15 | **4.3 MB** (74 tiles) |
  | all of Singapore | 0–15 | 27 MB |

- **Decision:** the campus file, at every zoom up to 15. MapLibre draws past 15 from the same tiles (overzoom), so streets stay sharp when zoomed in close. 4.3 MB fits easily on R2, in the web app's offline cache and in Android's offline region.
- Outside the box the map is blank. P (to the Botanic Gardens) is inside it.

### 0.4 Fonts and icons

- `protomaps/basemaps-assets` has Noto Sans in Regular, Medium and Italic, split into 256 small character-range files (about 6 MB per weight), plus light and dark icon sets. MapLibre fetches only the ranges a label uses.
- Chinese labels need no font files: MapLibre draws CJK characters with the device's fonts (`localIdeographFontFamily`).
- Fonts and icons go on R2 with the map file.
- `@protomaps/basemaps` 5.7.2 generates the map style, including a `lang` option.
