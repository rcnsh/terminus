# Campus map: plan

A Map tab on Android and in the web app: a street map of campus with the
bus routes on it, where tapping a stop shows what's coming and what you can
do from there. Decided 2 October 2026; Phase 0 findings are added below as
they come in.

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
    asks for it).
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
  - each stop's services.
- `/map/*` serves:
  - the PMTiles file from R2, by range and long-cached;
  - light and dark styles in the app's colours;
  - label fonts and icons.
- `scripts/map-tiles.sh` builds and uploads the map file. It is run once
  from the Mac (it needs the Cloudflare login), then a couple of times a
  year.
- The site's security policy gains only what MapLibre needs to run. All map
  requests stay on our own domain.

### Phase 2: web app (PR 2)

- Bottom bar in `/app/`: Now and Map within the page, Settings opens
  `/account/`.
- The Map tab with MapLibre GL JS (from cdnjs, already allowed) and the
  stop sheet.
- Offline: the service worker keeps the style, fonts and the campus area's
  tiles.
- Screenshots in a headless browser: light, dark, English, Chinese, online
  and offline.

### Phase 3: Android (PR 3)

- Material 3 bottom navigation; the settings screen becomes the Settings
  tab.
- The Map tab with maplibre-compose and the stop sheet as a modal bottom
  sheet.
- The location dot through MapLibre's location component, only with
  permission already granted.
- An offline region for the campus area.
- All new strings in English and Chinese.
- Split APKs by CPU type:
  - Gradle builds one APK per CPU type;
  - `release.sh` and `github-release.sh` upload each;
  - `latest.json` lists them;
  - `/download/android` serves the arm64 build, which suits nearly every
    phone, with links to the others;
  - the in-app update check picks the build that matches the phone.
  - Play Store installs are unaffected.

## Needs the owner

- Looking at the Android map on a real phone (CI builds and tests it, but
  can't look at it).
- Running `scripts/map-tiles.sh` once from the Mac to put the map file on
  R2.

## Phase 0 findings

(Filled in as Phase 0 runs.)
