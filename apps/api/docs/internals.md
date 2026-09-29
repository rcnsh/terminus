# terminus API: how it works

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
anything. A Quick Settings tile, a web page, a notification and (later) an MCP
tool would all consume the same `label` and `detail`. The moment a client starts
formatting for itself, four interfaces begin to drift apart and there are four
places to fix every bug.

**This repo is the API only.** `GET /` serves its documentation; clients are
separate. The OpenAPI spec lives in [src/openapi.ts](../src/openapi.ts) and a test
fails if a route and the spec drift apart.

---

## Reachability

Resolved. The token host and the bus proxy both answer from Cloudflare's edge and
from mobile data off campus, so no on-campus box is needed. `GET /health?probe=1`
reports live auth state from wherever the Worker is running.

## Quick start

```bash
pnpm install
pnpm test         # zero credentials, zero network
pnpm typecheck
pnpm dev          # cf dev, needs .dev.vars for live data
```

## Configuration

Copy `.dev.vars.example` to `.dev.vars` and fill in the values. They are not
included in this repository, and this repository doesn't explain how to obtain
them. **Never commit them.** `.dev.vars` is gitignored.

Auth is a **public / guest access-token flow** — the same one that lets uNivUS
show Bus Arrival without signing in. No NUSNET credentials are involved
anywhere, and nothing here should ever hold a personal NUS session or another
student's credentials.

| Variable | Purpose |
| --- | --- |
| `NEXTBUS_AUTH_BASE` | uNivUS auth host for the public token |
| `NEXTBUS_PROXY_BASE` | The uNivUS bus proxy, `https://inetapps.nus.edu.sg/univus/api/bus-proxy` |
| `NEXTBUS_PROXY_API_KEY` | Sent as `x-api-key` to the proxy |
| `NEXTBUS_APP_VERSION` | Current uNivUS release, e.g. `univus_android_2.59.2_140`. **Must track the Play Store**; KV `config:appVersion` overrides it (see below) |
| `NEXTBUS_HTD_API` / `NEXTBUS_APP_API` | The two auth headers for the token mint |
| `NEXTBUS_REQUESTED_BY` / `NEXTBUS_SECURED_REQUEST` | Optional; the server does not require them |

Names match `hewliyang/nus-nextbus-web`'s `.env.example`.

Deploy. The Worker's config is [cloudflare.config.ts](../cloudflare.config.ts)
(the website directory is in [wrangler.config.ts](../wrangler.config.ts), which
`cf` builds with):

```bash
pnpm exec cf kv namespaces create --title terminus   # put the id in cloudflare.config.ts
for k in NEXTBUS_AUTH_BASE NEXTBUS_APP_VERSION NEXTBUS_HTD_API NEXTBUS_APP_API NEXTBUS_PROXY_BASE NEXTBUS_PROXY_API_KEY; do
  pnpm exec cf workers secrets update "$k" --worker terminus --type secret_text --text "$(grep "^$k=" .dev.vars | cut -d= -f2-)"
done
pnpm run deploy
```

## Endpoints

| Route | |
| --- | --- |
| `GET /docs` | API documentation (Stoplight Elements), with a live "Send API Request" panel. |
| `GET /openapi.json` | The OpenAPI 3.1 description the docs render. Source: [src/openapi.ts](../src/openapi.ts). |
| `GET /next` | The answer. `?to=` names a stop or venue code; `?lat&lon` alone gives the next buses at your nearest stop. With neither it returns a "Set up" answer rather than inventing a destination. |
| `GET /trip?to=<stop\|venue>&lat&lon` | The answer for a stop or venue code. Without coordinates, `&from=<stop>` sets the origin. |
| `GET /arrivals?stop=<code>` | One stop's board, through the same per-stop cache. |
| `GET /campus` | Static stop/route geometry and destination search data. Cached hard. |
| `GET /stops/pairs` | Each stop with its twin across the road, and where the buses on each side go next. Cached hard. |
| `GET /health` | Graph age and which config is present, never values. `?probe=1` tests auth. |
| `GET /account` | The account page ([apps/web](../../web)), served as static assets. |
| `POST /auth/login`, `/pair`, `/me/*` | Accounts. See below. |

`/next`, `/trip`, `/arrivals`, `/campus` and `/stops/pairs` need an API key
(made on the account page, sent as `x-api-key`) or a signed-in session.

## Personalisation

Per-user trips come from the account (`/me/next`): a NUSMods timetable
imported with `POST /me/import`, plus classes entered by hand. Imported classes only
count in the weeks they run ([src/calendar.ts](../src/calendar.ts), built from
NUSMods' semester dates and MOM's public holidays by
`scripts/fetch_calendar.py`). [`src/config.ts`](../src/config.ts) holds the cache
TTLs and tuning constants.

## Accounts

Sign-up is open; addresses on the `blocklist` table are refused. The account
page at `/account` signs in with an emailed link and stores one profile per user in D1: timetable, home stops, gap threshold and
saved places. Native apps don't sign in; they pair with a 6-character code
from the page and get a device token (`Authorization: Bearer`).

- `GET /me/next` is the widget's one call. It picks the destination from the
  timetable (see `planFor` in [src/profile.ts](../src/profile.ts)) or from
  `?place=`/`?to=`, and returns the usual answer plus `dest` and `places`.
- `GET /me/nearby` lists departures at up to three stops near you.
- Tokens are stored as SHA-256 hashes. Web sessions last 30 days; device
  tokens last until revoked on the page.
- The link in the email opens a page with a button, and only the button's
  POST uses up the link. Outlook's link scanner opens links before the user
  does, so a GET that spent the token would break NUS addresses.

Setup:

```bash
pnpm exec cf d1 migrations apply <database id from cloudflare.config.ts>
```

Email goes out through Cloudflare Email Sending from `EMAIL_FROM`. That
needs the Workers Paid plan and terminus.rcn.sh onboarded under Email Service >
Email Sending in the dashboard.

## How it works

**Direction is resolved by route order, not by distance.** This is the most
important algorithm here. NUS stops come in directional pairs metres apart,
`X` and `Opp X`. That gap is inside GPS error near dense buildings, so picking
the nearer stop is wrong roughly half the time — and it is the specific wrong
answer that makes you miss a bus you can see. Instead
[`resolve.ts`](../src/resolve.ts) checks whether the destination is genuinely
downstream of each candidate in the scraped route sequence, and scores walking
and riding in the same unit (seconds) so the trade-off is legible. On a loop
route both sides technically reach the destination; the wrong side loses on hop
count rather than on a special case.

**Fetch-on-demand with a 15-second edge cache; no poll loop.** Workers has no
long-lived process and Cron Triggers bottom out at one-minute granularity. The
cache entry is keyed on the **resolved stop code**, not the request URL —
`getLastKnownLocation` jitters the coordinates on every call and the tile
appends a cache-buster, so a URL-keyed cache would never hit.

**KV holds only auth tokens.** Never the arrivals —
KV writes are rate-limited and propagation is eventual, which is wrong for
15-second data.

**The stop graph is static and bundled.** Stop locations, route order and
operating hours change a few times a year. `pnpm scrape` rebuilds
`data/stops.json` from the bus proxy's `bus-stops` and `pickup-point` calls.
The proxy has no `ServiceDescription`, so the route codes to fetch come from
the existing graph plus `KNOWN_ROUTES` in the script; a new service with an
unlisted code needs adding there. A weekly GitHub Action runs the same scrape,
but only once the repo has a GitHub remote and the six secrets it reads.

**Failure degrades in public.** `quality` walks `live → scheduled → stale →
ended`. A stale answer keeps its **original** `asOf` timestamp. A three-minute-
old answer honestly labelled beats a spinner, and beats an empty tile that
reads as "no buses".

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

As of uNivUS 2.59.2 (2026-09-28). On 2026-09-05 uNivUS stopped
calling ConnectX directly and moved bus data behind a proxy on its own host:

```
1. POST myizaac2.nus.edu.sg/univus-public/mobile/get-access-token
     headers X-HTD-API, X-APP-API ; body {deviceid, ipaddr, version}
     -> a 24h PUBLIC-domain guest JWT (+ userid)

2. POST inetapps.nus.edu.sg/univus/api/bus-proxy/shuttle-service
     headers x-api-key, Authorization: Bearer <JWT>
     body    {token, userid, domain, deviceid, ipaddr, version, busstopname}
     -> {code: "00000", data: {TimeStamp, name, shuttles: [...], hints}}
```

The guest JWT from step 1 is accepted by the proxy directly -- no seed token,
no refresh endpoint, no buswidget hop. `data` is the old `ShuttleServiceResult`
contents, so `normalize()` is unchanged. Like every uNivUS endpoint, failure
comes back at HTTP 200 with a non-`"00000"` code; `fms.ts` retries once with a
freshly minted token and otherwise reports the stop unavailable.

The retired ConnectX path (`fms.connectx.com.sg/apiy/NUSETA`, `nextbus_token2`
as a query param) now answers `{"result":false,"error":4}` to everything.

**The version string is a kill switch.** When NUS ships a new uNivUS, requests
carrying the old `version` start failing with code `10009` "We have a new
release of uNivUS", and every answer degrades to `quality: unknown`. The fix
is the current Play Store build's `univus_android_<versionName>_<versionCode>`
([uNivUS on Google Play](https://play.google.com/store/apps/details?id=sg.edu.nus.univus)),
written to KV. No deploy is needed, and it's live within a minute:

```bash
pnpm exec cf kv keys put config:appVersion --namespace-id <KV id in cloudflare.config.ts> --body univus_android_2.60.0_141
```

`config:appVersion` overrides the `NEXTBUS_APP_VERSION` secret, which is only
the fallback while the key is unset; a malformed value is ignored. Tokens
remember the version they were minted with, so the next call mints a new one.
The cron probe emails the operator when this happens, with the command and
NUS's full response (see `src/monitor.ts`).

## Auth, confirmed

```
POST https://myizaac2.nus.edu.sg/univus-public/mobile/get-access-token
X-HTD-API: <key>
X-APP-API: <key>

{"deviceid": "<16 hex>", "ipaddr": "127.0.0.1", "version": "univus_android_2.59.2_140"}
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

- **Do not send `X-Forwarded-Proto`.** It makes the NUS load balancer
  intermittently answer 400 "Contradictory scheme headers" (2 of 6 mints in a
  direct A/B, 0 of 6 without).

The three API keys (`X-HTD-API`, `X-APP-API`, the proxy's `x-api-key`) are the
only secrets. Everything else in `.dev.vars.example` is a URL or a version.

## Analytics

Every answer writes one decision row, plus one row per timed arrival, to a
Workers Analytics Engine dataset. Two purposes: checking whether the direction
algorithm is actually right, which nothing else measures, and collecting the
inter-stop travel times phase 2 needs — `plate` is the join key. Queries and
the schema contract are in [docs/analytics.md](analytics.md).

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

## Clients

The Android widget and app ([apps/android](../../android)), the Mac menu bar app
([apps/macos](../../macos)) and the website ([apps/web](../../web)) all use `/me/next`.
For local work, `node scripts/dev-stub.mjs` runs this Worker with a fake bus
feed and a seeded test account.

## Layout

```
src/index.ts      Router
src/resolve.ts    Haversine, directional pairing, downstream reachability, scoring
src/format.ts     label/detail strings, the degrade ladder
src/fms.ts        ShuttleService client + defensive response normalisation
src/auth.ts       Public token, lazy refresh, KV + in-memory memo
src/config.ts     Cache TTLs and tuning constants
src/calendar.ts   NUS teaching weeks and public holidays
src/nusmods.ts    NUSMods share URL -> trips
src/campus.ts     /campus map geometry and destination search
src/pairs.ts      /stops/pairs
src/analytics.ts  Analytics Engine decision + arrival logging
src/openapi.ts    OpenAPI 3.1 spec and the Elements docs page
src/http.ts       JSON responses, query parsing
src/accounts.ts   Sign-in links, sessions, pairing codes (D1)
src/access.ts     API keys, and who may call the keyed routes
src/profile.ts    Profile validation and the where-next planner
src/me.ts         /auth, /pair and /me routes
migrations/       D1 schema
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
