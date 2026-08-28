# nusbus-edge

A Cloudflare Worker that answers one question about the NUS internal shuttle
bus: **when is my bus, and should I run.**

It is not a bus tracker. Good NUS bus trackers already exist. The problem is
that answering a three-second question currently takes six taps — open the app,
find the stop, pick the correct side of the road, read a table, work out which
service actually goes where you are going.

```
GET /next  ->  { "label": "D2 · 4 min",
                 "detail": "Opp KR MRT · right here · COM3 ~6 min · quiet · or A1 9 min",
                 "alt":    "A1 · 9 min · Kent Ridge MRT",
                 "quality": "live", ... }
```

The server returns a pre-rendered string; clients render it without computing
anything. A Quick Settings tile, a push notification, this page and (later) an
MCP tool all consume the same `label` and `detail`. The moment a client starts
formatting for itself, four interfaces begin to drift apart and there are four
places to fix every bug.

---

## Step zero: is the FMS reachable from outside NUS?

**Nobody has verified this, and everything below depends on it.** There are
user reports that uNivUS requires NUS wifi. If the endpoints are IP-restricted
then no edge platform can reach them, and this needs a box on campus with the
Worker as a thin front — a different architecture.

From **mobile data, off campus**, with `.dev.vars` filled in:

```bash
set -a && . ./.dev.vars && set +a && curl -sv --max-time 15 "$NEXTBUS_FMS_BASE/ShuttleService?busstopname=COM3&serviceId=$NEXTBUS_FMS_SERVICE_ID" -H "X-HTD-API: $NEXTBUS_HTD_API" -H "X-APP-API: $NEXTBUS_APP_API" -H "Authorization: Bearer $TOKEN" | head -c 400
```

Evidence leans favourable: `hewliyang/nus-nextbus-web` ran these same endpoints
from Vercel, which is arbitrary cloud IPs. But it is unconfirmed. Do not deploy
on the assumption.

A second, free signal: once the GitHub secrets are set, run the
`scrape stop graph` workflow by hand. The runner is a US cloud IP. If it
succeeds, the endpoints are not NUS-network-restricted.

You can build and test everything before answering this — the suite runs with
no credentials at all.

## Quick start

```bash
npm install
npm test          # 30 tests, zero credentials, zero network
npm run typecheck
npm run dev       # wrangler dev; /next answers off the placeholder graph
```

`data/stops.json` ships as a clearly-labelled synthetic placeholder so the
tests and `wrangler dev` work before any credential exists. `npm run scrape`
replaces it with the real thing.

## Configuration

Copy `.dev.vars.example` to `.dev.vars` and fill it from a proxied uNivUS
capture. **Commit no captured values, ever.** `.dev.vars` is gitignored.

Auth is a **public / guest access-token flow** — the same one that lets uNivUS
show Bus Arrival without signing in. No NUSNET credentials are involved
anywhere, and nothing here should ever hold a personal NUS session or another
student's credentials.

| Variable | Purpose |
| --- | --- |
| `NEXTBUS_AUTH_BASE` | uNivUS auth host for the public token |
| `NEXTBUS_FMS_BASE` | ConnectX FMS data host |
| `NEXTBUS_APP_VERSION` | App version string sent with every request |
| `NEXTBUS_HTD_API` / `NEXTBUS_APP_API` | The two auth headers |
| `NEXTBUS_FMS_SERVICE_ID` | Required by `ShuttleService` |
| `NEXTBUS_FMS_TENANT_CODE` | Required by `BusStops`, `ServiceDescription`, `PickupPoint` |
| `NEXTBUS_REQUESTED_BY` / `NEXTBUS_SECURED_REQUEST` | Optional; the server does not require them |
| `VAPID_*` | Optional; push is off entirely without `VAPID_PUBLIC_KEY` |

Names match `hewliyang/nus-nextbus-web`'s `.env.example` so that repo's notes
stay applicable. uNivUS is a Flutter app, so capturing values means proxying it
with a CA cert; there is no request signing to defeat.

**Two values are guesses, not captures**, because the reference `.env.example`
does not document them. Confirm both against your own capture:

- `DEFAULT_AUTH_PATH` in [src/auth.ts](src/auth.ts) — the token endpoint path
- `shuttleServiceUrl()` in [src/fms.ts](src/fms.ts) — the query parameter names

Deploy:

```bash
npx wrangler kv namespace create NUSBUS_KV      # paste the id into wrangler.toml
for k in NEXTBUS_AUTH_BASE NEXTBUS_FMS_BASE NEXTBUS_APP_VERSION NEXTBUS_HTD_API NEXTBUS_APP_API NEXTBUS_FMS_SERVICE_ID NEXTBUS_FMS_TENANT_CODE; do npx wrangler secret put "$k"; done
npx wrangler deploy
```

## Endpoints

| Route | |
| --- | --- |
| `GET /next?lat&lon` | The answer. Destination comes from the time-of-day prior. |
| `GET /trip?to=<key>&lat&lon` | The answer for a named trip (or a bare stop code). |
| `GET /health` | Graph age and which config is present. Never values. |
| `POST /subscribe` | `{ endpoint }` for Web Push. Stores the endpoint only. |
| `GET /vapid` | Public key, or 501 when push is unconfigured. |
| `GET /`, `/manifest.webmanifest`, `/sw.js`, `/icon.svg` | The one-answer PWA. |

**Both `/next` and `/trip` work with no coordinates at all**, falling back to
the trip's configured origin. That is what lets the morning push work with zero
location permissions — a service worker has no `navigator.geolocation`.

## Personalisation

[`src/config.ts`](src/config.ts) is the entire personalisation surface: three
named recurring trips, time-of-day priors mapping hour ranges to a trip key,
and the cache TTLs. Everything else is machinery.

The premise is three recurring trips, not a general routing problem. Hardcoding
them is what removes the tap. There is deliberately **no stop picker in any
UI** — that would reintroduce the exact tap this exists to delete.

## How it works

**Direction is resolved by route order, not by distance.** This is the most
important algorithm here. NUS stops come in directional pairs metres apart,
`X` and `Opp X`. That gap is inside GPS error near dense buildings, so picking
the nearer stop is wrong roughly half the time — and it is the specific wrong
answer that makes you miss a bus you can see. Instead
[`resolve.ts`](src/resolve.ts) checks whether the destination is genuinely
downstream of each candidate in the scraped route sequence, and scores walking
and riding in the same unit (seconds) so the trade-off is legible. On a loop
route both sides technically reach the destination; the wrong side loses on hop
count rather than on a special case.

**Fetch-on-demand with a 15-second edge cache; no poll loop.** Workers has no
long-lived process and Cron Triggers bottom out at one-minute granularity. The
cache entry is keyed on the **resolved stop code**, not the request URL —
`getLastKnownLocation` jitters the coordinates on every call and the tile
appends a cache-buster, so a URL-keyed cache would never hit.

**KV holds only the auth token and push subscriptions.** Never the arrivals —
KV writes are rate-limited and propagation is eventual, which is wrong for
15-second data.

**The stop graph is static and bundled.** Stop locations, route order and
operating hours change a few times a year. A weekly GitHub Action scrapes them
into `data/stops.json`.

**Failure degrades in public.** `quality` walks `live → scheduled → stale →
ended`. A stale answer keeps its **original** `asOf` timestamp. A three-minute-
old answer honestly labelled beats a spinner, and beats an empty tile that
reads as "no buses".

**Push instead of geofencing.** Background location on Android is
permission-heavy and gets killed by OEM battery managers. The cron sends a
payload-free push; the service worker wakes and calls the API itself, so times
are fresh at display time. `crons = ["40 0 * * 1-5"]` is 08:40 SGT on weekdays
— SGT is UTC+8 with no DST, so Cloudflare's UTC-only cron is exact rather than
a seasonal approximation.

## What the feed actually looks like

`test/fixtures/` holds real captured responses and `test/fixtures/README.md`
records what they establish. Three findings changed the code:

**The list key is `timings` under an `etas` envelope, not `shuttles`.**
`normalize()` returned an empty array on real data until a fixture proved it.

**Crowding is a headcount, not a bucket.** `arrivalTime_capacity` /
`arrivalTime_ridership` against 88-seat buses, so `88/88` is a genuine "you
are not getting on this one" rather than a vague "high". Some vehicles report
neither field, and an absent field is not an empty bus.

**A terminus reports the same service under two berth codes.** COM3 is the
D1/D2 terminus and returns both `COM3-D2-S` (a run starting there) and
`COM3-D2-E` (a run ending there); mid-route stops like `UHALL-OPP` and `UHC`
carry a bare code. This is a second direction problem underneath the
`X` / `X-OPP` one, and it is the dangerous kind, because both berths belong to
the same physical stop — choosing the right stop does not save you. Nothing
orders the two: when no bus is waiting to depart, the terminating arrival is
the sooner of the two, so taking the earliest ETA hands you a bus that ends
its run as you board. `resolveBerths()` takes `-S` whenever the stop offers
it. Where several berths exist and no suffix separates them, the answer caps
`confidence` at 0.5 and says "direction unconfirmed" rather than guessing.

Also: `arrivalTime_ts` looks like an absolute arrival time and would be better
than relative minutes across a cache TTL, but real rows carry timestamps
minutes in the past alongside a positive `arrivalTime`. It is not used.

## Data flow, confirmed

Extracted from `libapp.so` in the APK (Flutter keeps Dart string literals in
the AOT snapshot) and verified live. There are THREE stages, not two:

```
1. POST myizaac2.nus.edu.sg/univus-public/mobile/get-access-token
     headers X-HTD-API, X-APP-API ; body {deviceid, ipaddr, version}
     -> a 24h PUBLIC-domain JWT (+ userid)

2. POST myizaac2.nus.edu.sg/univus/mobile/buswidget/get-init-data
     body {token, userid, domain, deviceid, ipaddr, version}
     -> data.tokens.nextbus_token, nextbus_token2  (the FMS credentials)
     -> also data.bus_stops (favourites) and bus-stop-color

3. GET  fms.connectx.com.sg/apiy/NUSETA/ShuttleService?busstopname=...
     authenticated with the nextbus_token(s) from stage 2
```

So `NEXTBUS_FMS_BASE = https://fms.connectx.com.sg/apiy/NUSETA`, and the FMS
credentials are NOT static env values -- they are minted per session at stage
2 and expire. This changes the design: `auth.ts` currently models only stage 1.
It needs a second hop (or `fms.ts` needs to fetch and cache the nextbus_token),
which is why `NEXTBUS_FMS_SERVICE_ID` / `NEXTBUS_FMS_TENANT_CODE` in the
template are likely dead -- the token, not a static id, is what authenticates.

**Stage 3 uses no auth headers.** Read from `hewliyang/nus-nextbus-web`'s
server client: ConnectX takes the FMS token as a `token` QUERY PARAMETER (it is
`nextbus_token2`, not `nextbus_token`), alongside `ServiceID` and `TenantCode`
query params; the only header is `accept: application/json`. Error 4 was my
Bearer-header guess, not a real rejection.

Its error convention, also adopted here: `{result:false, error:1|2|3}` at HTTP
200 means the token expired -> refetch and retry once. `error:4` is a bad
ServiceID/TenantCode -- a config fault, NOT auth -- so it must never trigger a
refetch loop.

**Resolved.** `ServiceID` and `TenantCode` are both the literal `NUS`, sent as
query params. A live end-to-end call returns real arrivals.

The raw ConnectX `ShuttleService` response is richer than the proxy fixtures:
each service carries an `_etas` array (full upcoming list, not just first +
next) with `eta` (minutes), `eta_s` (seconds -- preferred, more precise),
`plate`, `ts` (absolute arrival), and `px` (per-arrival crowd). `normalize()`
consumes all of it. Real fixture: `test/fixtures/connectx-ShuttleService-COM3.json`.

Nothing about the FMS surface is unknown any more. The remaining work is
operational, not investigative: fill in the trips you actually take, decide
whether to deploy, and use it.

## Auth, confirmed

```
POST https://myizaac2.nus.edu.sg/univus-public/mobile/get-access-token
X-HTD-API: <captured>
X-APP-API: <captured>

{"deviceid": "<16 hex>", "ipaddr": "127.0.0.1", "version": "univus_android_2.59.1_139"}
```

returns `{"code":"00000","data":{"token","userid","domain","username"}}`. The
token is a 24-hour RS256 JWT with `domain: PUBLIC` and `iss: HTD`; its `jti` is
the device id you sent and its `aud` is the issued `userid`. No NUSNET
credentials are involved at any point.

Three things that will bite you:

- **The response has no `expires_in`.** The lifetime is only in the JWT `exp`
  claim, so `auth.ts` decodes the token to find it.
- **`userid` is reissued on every mint**, even for an unchanged device id, so
  it travels with the token in a `Session` rather than sitting in config.
- **A rejection is HTTP 200.** `{"code":"10000","msg":"Invalid API KEY"}` comes
  back with a 200 status line, so anything checking `res.ok` sails straight
  past it.

The two API keys are the only secrets in the project. Everything else in
`.dev.vars.example` is either a public URL or a version string.

## Analytics

Every answer writes one decision row, plus one row per timed arrival, to a
Workers Analytics Engine dataset. Two purposes: checking whether the direction
algorithm is actually right, which nothing else measures, and collecting the
inter-stop travel times phase 2 needs — `plate` is the join key. Queries and
the schema contract are in [docs/analytics.md](docs/analytics.md).

Logging is a no-op without the binding and swallows its own errors. An answer
that failed because logging failed would be an absurd way to miss a bus.

## Known weaknesses

- `RIDE.secondsPerHop` is a **guessed constant** and the ranking inherits its
  error. It separates a 2-hop ride from a 14-hop ride, which is the case that
  matters; it does not reliably separate 4 hops from 5. `stop.confidence`
  reports which situation you are in — below ~0.6, the answer is a coin flip
  dressed up as a number. Roadmap step 2 replaces it with measured data.
- `quality: 'scheduled'` has no timetable behind it. It means "inside operating
  hours, feed gave nothing, here is a headway estimate". It is the weakest rung
  of the ladder and it is labelled as such.
- The `-S` / `-E` rule rests on one captured stop. If any NUS route uses a
  different berth convention, `resolveBerths()` will fall through to the
  ambiguous branch and cap confidence, which is the safe direction to fail —
  but it wants a second terminus in the fixtures to confirm.
- The fixtures come from `bus.hewliyang.com`'s proxy, not the FMS directly.
  The rows are passthrough; the envelope is his. Replace them with raw
  `ShuttleService` bodies once you have the capture.
- The web page is a fallback. The tile is the product.

## Client

[docs/android-tile.md](docs/android-tile.md) — the Quick Settings tile, with
working Kotlin, plus a five-minute way to test the whole idea with HTTP Request
Shortcuts before writing an APK.

## Layout

```
src/index.ts      Router, scheduled handler
src/resolve.ts    Haversine, directional pairing, downstream reachability, scoring
src/format.ts     label/detail strings, the degrade ladder
src/fms.ts        ShuttleService client + defensive response normalisation
src/auth.ts       Public token, lazy refresh, KV + in-memory memo
src/config.ts     THE PERSONALISATION SURFACE
src/page.ts       One-answer PWA fallback page
src/push.ts       VAPID JWT via Web Crypto, payload-free push
src/pwa.ts        Manifest, service worker, icon
```

`normalize()` in `fms.ts` is the only function that touches the raw FMS shape.
It is undocumented and has changed before, so it is tolerant and everything
downstream assumes a clean `Arrival[]`. When the feed shifts, exactly one
function needs editing.

## Prior art

- **NextBus NUS** — third-party iOS app, actively maintained, moved to the
  uNivUS API after the NUS NextBus retirement on 29 May 2026. Already does
  direction routing sorted by travel time, per-leg ETA, fuzzy venue search,
  calendar matching. iOS-only, which is why it does not solve this problem.
- **NavUS** — older; Dijkstra over a venue graph plus a Telegram bot.
- **[hewliyang/nus-nextbus-web](https://github.com/hewliyang/nus-nextbus-web)**
  — unmaintained SvelteKit PWA, now at `bus.hewliyang.com`. The single most
  useful reference, because its public `.env.example` documents the exact auth
  surface.

## Acceptable use

This reads a public, unauthenticated endpoint the uNivUS app itself uses,
at roughly one request per stop per 15 seconds. Use it in line with the
[NUS IT Acceptable Use Policy](https://nusit.nus.edu.sg/its/resources/acceptable-use-policy/).
Do not commit captured credentials, do not use NUSNET credentials with it, and
do not raise the request rate.
