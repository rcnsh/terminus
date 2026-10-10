# Architecture

A map of the code. The reasoning behind each rule, endpoint by endpoint, is
in [apps/api/docs/internals.md](apps/api/docs/internals.md). The story of
building it is [Building terminus](https://rcn.sh/blog/building-terminus).

```
NUS shuttle feed ─┐                                      ┌─ Android app + widgets
LTA DataMall ─────┤                                      │
NUSMods ──────────┼──► Cloudflare Worker (apps/api) ─────┼─ Mac menu bar app
NUS calendar, ────┤    D1 · KV · R2 · edge cache ·       │
public holidays   │    Durable Objects · cron            └─ website + web app (apps/web)
OpenStreetMap ────┘
```

## The rule

The Worker does all the thinking. Every client asks `/api/me/next` and gets a
finished card: when to leave, which bus, from where, when you arrive, all
worded in English or Chinese. Clients draw it and count down the clock. They
don't compute or format answers, so the four clients can't drift apart, and a
bug is fixed in one place.

## The Worker

`apps/api`, TypeScript, one Worker per site (stable and beta) from
[`cloudflare.config.ts`](apps/api/cloudflare.config.ts). It serves the API,
the website from `apps/web/public`, the app downloads and the map files.

A request goes through `src/index.ts` (the router), which hands off to:

| Path | What |
| --- | --- |
| `src/me.ts`, `src/accounts.ts`, `src/applogin.ts` | Accounts: emailed codes and links, device tokens, pairing |
| `src/access.ts` | Who may call the keyed routes (API key or session) |
| `src/next.ts` | `/api/me/next`: today's plan and the trip's phase |
| `src/profile.ts`, `src/day.ts` | The saved setup, the planner (`planFor`), and today's timeline |
| `src/answer.ts`, `src/resolve.ts`, `src/transfer.ts` | Stops near you, the stop on the right side of the road, scoring, one change of bus |
| `src/walk.ts` | Walking times along campus paths |
| `src/card.ts`, `src/format.ts`, `src/i18n.ts` | Everything a client shows, worded once |
| `src/fms.ts` | The NUS feed client; the only code that reads the raw format |
| `src/lta.ts`, `src/public.ts` | Public buses from LTA DataMall, for accounts that turn them on |
| `src/buses.ts`, `src/campus.ts`, `src/map.ts` | The campus map: live buses on their line, stops and routes, the street map from R2 |
| `src/trip.ts`, `src/tripdo.ts`, `src/plan.ts` | The trip engine, one Durable Object per user per day |
| `src/push.ts`, `src/webpush.ts` | FCM to Android, Web Push to the web app |
| `src/monitor.ts`, `src/calendarsync.ts` | The 15-minute cron: feed health, calendar refresh, housekeeping |
| `src/openapi.ts` | The OpenAPI spec behind [`/docs`](https://terminus.run/docs); a test fails if it and the routes drift |
| `src/config.ts` | Cache TTLs and tuning constants |
| `src/types.ts` | `Env`: every binding and secret |

## Data sources

- **NUS shuttle feed.** No public API: the Worker uses the uNivUS app's
  guest-token flow (no NUSNET credentials), through `src/auth.ts` and
  `src/fms.ts`. `src/appversion.ts` follows the app version string the feed
  demands, and KV `config:appVersion` can override it without a deploy.
- **LTA DataMall.** Public bus arrivals, only with `LTA_ACCOUNT_KEY`.
- **NUSMods.** The timetable, imported from a share link (`src/nusmods.ts`).
- **Bundled data** in `apps/api/data`: stops and route order
  (`stops.json`), route lines (`shapes.json`, from OpenStreetMap), public
  buses, walking paths, venues and residences, and the academic calendar.
  The `scrape` workflow refreshes it weekly; a data change ships with a
  deploy. Hand-kept files: `service-hours.json`, `opposites.json`,
  `nus-days.json`.
- **Calendar.** Bundled, and also fetched weekly by the cron into KV
  (`src/calendarsync.ts`), so it doesn't run out between deploys.

## Caching and load on NUS

- Arrivals are cached 15 s per stop and live buses 5 s per service, in the
  edge cache (`src/edgecache.ts`, `TTL` in `src/config.ts`), so every request
  in a data centre shares one upstream call.
- `src/feedgate.ts` (the `FeedGate` Durable Object) holds each key to one
  upstream call per window across all data centres.
- On a failure the last answer is served, marked stale, for up to 5 minutes;
  a 429, 5xx, rejected key or timeout trips a breaker.
- The only scheduled poller is the timelapse recorder
  (`src/timelapsedo.ts`, one Durable Object per Singapore day), every 30 s
  inside service hours, through the same cache. It's on for the stable site
  only (`TIMELAPSE_ENABLED`).

## Storage

| | Holds |
| --- | --- |
| D1 (`DB`) | Users, sessions (devices included), profiles, API keys, trip outcomes, crowding, feedback. Schema in `migrations/`, additive only |
| KV | Guest token and device id, calendar copy, feed state, runtime switches (`config:*`), sign-in codes |
| R2 (`DOWNLOADS`) | App builds, `latest.json`, the Sparkle appcast, the PMTiles street map, fonts and icons, timelapse days |
| Durable Objects | `Trip` (per user, today only, deleted at midnight), `TimelapseRecorder`, `FeedGate` |
| Analytics Engine (`AE`) | Usage and error counts for the operator dashboard; see [analytics.md](apps/api/docs/analytics.md) |

## Clients

The Android and Mac apps send `x-terminus-client: <platform>/<version>` and authenticate
with a device token (`Authorization: Bearer`): anonymous on first launch,
then by an email approval or a pairing code. The website and web app use a
session cookie. Each client refetches at the card's `nextChangeAt`, and Android and
the web app also get a push when a trip's phase changes.

| | Code | Notes |
| --- | --- | --- |
| Website and web app | `apps/web/public` | HTML plus Preact with htm, no build step. Third-party code vendored in `vendor/`. `sw.js` keeps the app and map offline |
| Android | `apps/android` | Kotlin, Compose, Glance widgets, maplibre-compose. Stable and beta flavours. `Api.kt` is the client |
| Mac | `apps/macos` | SwiftUI menu bar app, MapLibre Native for the map window, Sparkle updates. `Api.swift` is the client |

The API's golden answers in `apps/api/test/fixtures/answers` are parsed by
the Android and Mac unit tests too, so a change to the answer's shape fails
every client's tests at once.

## Decisions worth knowing

- **One Worker, no separate frontend host.** The website is the Worker's
  static assets. Scripts, styles and images skip the Worker
  (`runWorkerFirst`), so a page costs one Worker request.
- **No build step for the web.** Modules load as written, so the service
  worker caches exact files and the API tests import the same modules.
- **Quality is explicit.** Every time is `live`, `scheduled`, `stale` or
  similar. A guess is never shown as live.
- **Two addresses.** `terminus.run` is the public name; `terminus.rcn.sh`
  stays because installed apps call it and NUS Wi-Fi blocks the new domain
  for now (`movingOff` in the config).
- **Stable and beta are separate.** Their own D1, KV, R2, rate limits and
  dataset; `test/deploy.test.js` checks they share nothing.
- **English and Simplified Chinese everywhere,** enforced by tests and
  Android lint.
