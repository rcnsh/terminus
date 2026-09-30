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
| `GET /status.json` | Whether NUS's feed is up, as the 15-minute check saw it, and the last 20 outages. The [status page](../../web/public/status) shows it. |
| `GET /admin/stats` | The operator dashboard's data (accounts, devices by app, sign-ups, reports, feed; answers and errors per day from Analytics Engine when `ANALYTICS_TOKEN` is set). Needs `x-health-token`; anything else gets a 404. |
| `GET /account` | The account page ([apps/web](../../web)), served as static assets. |
| `POST /auth/login`, `/auth/code`, `/pair`, `/me/*` | Accounts. See below. `POST /me/feedback` is "Is this wrong?": the answer the user saw and a note, kept with the account and emailed to `ALERT_EMAIL`. |

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
page at `/account` signs in with an emailed code (or the link in the same
email) and stores one profile per user in D1: timetable, home stops, gap threshold and
saved places. Apps hold a device token (`Authorization: Bearer`), which they
get one of three ways:

- **`POST /auth/anon`** on first launch: an account with no email
  (`users.email` is NULL), so the app is useful before any sign-in. Limited
  per IP (`RL_AUTH`) and globally (`RL_ANON`); the cron deletes anonymous
  accounts unused for 60 days (`users.last_seen`).
- **Sign-in approved from the email** ([src/applogin.ts](../src/applogin.ts),
  modelled on RFC 8628). `POST /auth/app/start {email, name}` returns
  `{request, poll, match}` and emails a 6-character code (in the subject
  too: filters hold back link-only mail) and a link. Typed into the app,
  `POST /auth/app/code {request, poll, code}` answers with the token; five
  wrong codes kill the request. Reading mail on another device, the link's
  page (`GET /auth/approve?r=`) offers three numbers; picking the one the
  app shows (`match`) approves, a wrong one or "This wasn't me" kills it.
  The app polls `POST /auth/app/poll {request, poll}` every 3 s and gets
  `{status: 'approved', token, outcome}` once. The poll secret, the link
  and the code are all different, so the app that starts a request can't confirm it. Sent
  with the anonymous token, the device's account is kept (`added-email`) or
  folded into the email's account: dropped if it had no setup (`signed-in`),
  moved if the account had none (`moved-setup`), otherwise the app asks and
  calls `POST /auth/app/merge {anon, keep: 'account'|'device'}` (`choose`).
  Works on every client, including the Mac, which can't take universal
  links without a paid Apple team.
- **A pairing code** from `/me/pair-code`, made on the account page or in a
  signed-in app, redeemed with `POST /pair`.

Every device added to or removed from an account with an email emails its
owner. That's what lets a signed-in app add (`/me/pair-code`) and remove
(`DELETE /me/devices/<id>`) devices. API keys and signing out everywhere
stay on the account page; so does deleting an account, except an anonymous
one, which has no page and is deleted from its app.

Apps send `x-terminus-client: <platform>[-<flavour>]/<version>` (for example
`android/1.4.0`), stored per session for the dashboard. Without it the
platform is guessed from the User-Agent, which counts any CFNetwork client as
the Mac.

- `GET /me/next` is the widget's one call. It picks the destination from the
  timetable (see `planFor` in [src/profile.ts](../src/profile.ts)) or from
  `?place=`/`?to=`, and returns the usual answer plus `dest` and `places`.
- `GET /me/nearby` lists departures at up to three stops near you.
- On a day with no classes (or none left), `/me/next` says so (`mode: free`)
  with the next class, and no bus: a bus you have no reason to take reads
  like advice. Departures near you are `/me/nearby`.

### The trip engine

`/me/next` also says where today's trip is, the same on every device:
`card.phase` is `idle`, `due` (5 min before the leave-by), `heading`,
`waiting` (at the boarding stop), `riding`, `missed` or `arrived`. The
phase comes from the answer and the day's signals: `POST /me/signal` with
`boarded`, `missed`, `skipped`, `left`, `arrived`, `location` or `reset`,
for the trip in progress or the `trip` key a card action or `/me/day`
names. Clients show `card.actions` as buttons and never decide them.

The signals live in a Durable Object per user (`Trip` in
[src/trip.ts](../src/trip.ts), bound as `TRIPS`, keyed by user id). It's
only touched on a day with classes, keeps that day's signals and nothing
else (a location is reduced to what it means: at the stop, or arrived), and
an alarm deletes everything at the next Singapore midnight. Deleting an
account empties it at once (`clearTrip`), and so does signing an anonymous
account into another one.

### Tap to confirm, and push (phase 3)

- **The planned bus is remembered.** From the moment a trip is due, the Worker
  saves the bus it's for in the day's record (`DayRecord.plans`, only when it
  changes). The plan freezes at its leave-by time, or when its bus leaves if
  that comes first. After that the answer moves on to later buses, but the
  question and the ride stay about this one. It freezes at the leave-by time,
  not at departure, because devices keep polling in between, and past the
  leave time every answer names a later bus. Before it freezes, a plan made
  without a location (the widget, the background refresh) doesn't replace one
  made with one (`Boarded.located`), since they plan from different places.
- **The question** (`card.ask`: "On the 9:41 D2?" with On it · Missed it ·
  Not going) is on the card from the bus's departure until the class starts,
  while nobody has answered. Three minutes after the departure with no answer
  the phase is taken as `riding` (`TripView.assumed`); a location still at the
  boarding stop makes it `missed` instead. Nothing is recorded for an assumption.
- **The ride from the feed.** "On it" records the plate of the bus due at the
  boarding stop within five minutes; while riding, the same plate in the
  alighting stop's arrivals gives the arrival (quality `live`). Without a
  plate, the estimate from the tap, marked `~`.
- **Outcomes** ([src/outcomes.ts](../src/outcomes.ts), `trip_outcomes`, 35
  days): each answer, and `none` once for a question left unanswered. Five
  `none` in a row mute the question (`users.ask_from` turns it back on);
  three misses of one class in 30 days suggest a bus earlier (`ArriveBy.oneEarlier`);
  three skips in a row offer to stop reminders (`card.remind: false`). Choices
  are `trip_prefs`; a turned-down suggestion waits 30 days.
- **Push** ([src/push.ts](../src/push.ts), [src/tripdo.ts](../src/tripdo.ts)).
  When `FCM_SERVICE_ACCOUNT` is set, a card served on a class day asks the
  Trip object to wake at `nextPhaseAt` (due, leave-by, departure, +3 min,
  class start, ride end; not at `staleAt`). At each wake it works out the card
  again, nudges the user's devices (`sessions.push_token`) if the phase or
  the question changed, and schedules the next wake; with no device taking
  push it stops. A nudge is a data message, `{kind: 'card', phase, ask}`, high
  priority for due, missed and a new question; the app fetches /me/next
  itself. A tap nudges the user's other devices at once. The object's single
  alarm is the sooner of the next wake and midnight (`deleteAt`).

The planner ([src/profile.ts](../src/profile.ts), `planFor`):

- A class stays the target until 15 minutes after it starts (you may still
  be on the bus), unless you've reached it. A skipped class is left out.
- An hour after the last class, with no location, you're taken to be home.
- Outside your day, a location on campus but not at home gets the trip home.
- On the trip home, `card.warning` says "Last D2 from UTown in 18 min" from
  45 minutes before the service's published end (`data/service-hours.json`).

`GET /me/day` is today's timeline, worked out with the same planner. A
class you're on the bus to carries `onBus` (the bus, where to get off, the
arrival) instead of a leave-by that has passed.

Card v2 adds `phase`, `phaseText`, `glance` (12 characters, for a menu bar
or a tile), `line` (one line, for a notification), `actions`, `warning` and
`nextChangeAt` (when the card changes by itself). While riding, `ride` lists
the stops from boarding to getting off, with the board and arrival times (the
arrival live when the bus's plate is known), for a progress bar (phase 6). v1
fields are unchanged.
- Tokens are stored as SHA-256 hashes. A web session lasts 30 days from its
  last use: `GET /me` pushes the expiry back 30 days, and sends the cookie
  again, once fewer than 23 days are left. Device tokens last until revoked,
  or 90 days unused.
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

### The web app (phase 5)

`/app/` is terminus as an installable web app, meant for iPhones: the answer
card, chips for saved places and Nearby, and Today. Settings are the account
page. It uses the same routes as the account page, with the session cookie.

- **Install.** `/manifest.webmanifest` has `start_url` `/app/`, the icons in
  `assets/icons` (drawn by `apps/android/store/render.swift`), and a share
  target that sends a shared NUSMods link to the account page's import. On an
  iPhone in Safari, the page explains Add to Home Screen, since iOS never
  offers it. A web app on the Home Screen has its own cookies, so it signs in
  once by itself. The sign-in code is typed there; the emailed link would open
  in Safari. `/account/?next=/app/` comes back to the app after sign-in.
- **Offline.** `/sw.js` fetches the app's files network-first and keeps a
  copy for offline. `/me`, `/me/next` and `/me/day` are also network-first,
  and the last good reply is kept (one per route and place). When the network
  is down, the kept reply comes back with `x-terminus-cached` (when it was
  fetched), and the page dims the card and says so. Signing out, deleting the
  account or a 401 empties the kept replies.
- **Push.** `POST /me/push` with `{subscription}` keeps the browser's Web Push
  subscription on the session as `web:` plus its JSON, next to where an
  Android session keeps its FCM token. So the Trip object's nudges reach both,
  through `push.ts` and `webpush.ts`. Each push is VAPID-signed with
  `VAPID_PRIVATE_KEY` (a P-256 JWK; `scripts/vapid-key.mjs` makes one) and
  its payload encrypted with aes128gcm, using WebCrypto only.
- **Every day, not just when the app is open.** A Trip object only watches
  once a request asks it to. The Android app asks from its background
  refresh, but a Home Screen web app makes no requests unless it's opened. So
  from 06:00 Singapore time the cron (`armTrips` in monitor.ts) asks the Trip
  object of every user with a push address to watch the day. It works out the
  card, wakes at each change and pushes, and on a day without classes it
  stops. Saving a subscription also refreshes the card, so a Trip object that
  woke before the subscription existed is asked again.
- **What a push shows.** A web push must show a notification (iOS insists).
  So the web app isn't pushed an idle card, or a trip with reminders off. The
  service worker fetches `/me/next` and words the notification as the Android
  app does: the question at the departure; the ride, or the next way there
  after a missed bus; otherwise when to leave. Where the browser has
  notification buttons (Android Chrome), there is one: "Missed it" at the
  question (silence already means on it), otherwise the card's main action.
  Only one, because Chrome for Android 149 reported the second button's
  action when the first of two was tapped (checked on the emulator). Where
  there are no buttons (iOS), a tap opens the app on the card's buttons.

### Every trip, detected (phase 8)

**Detection (8.1, `detect.ts`).** During a trip the Android app sends
`POST /me/signal` `{kind: 'location', lat, lon, speed, acc}` about every
20 seconds, from the live notification's foreground service. Each fix is
judged and dropped; only what it means is kept on the trip record, marked
`detected`:

- **On the bus:** at least 4 m/s, within 60 m (plus the fix's accuracy, up to
  60 m) of the straight lines between the planned service's stops from the
  boarding stop to the one you get off at, having had a `waiting` record (a
  fix at the boarding stop) in the last 30 minutes, from two minutes before
  the bus's departure. The record gets `departed`, the departure estimated
  from the fix (now, less the distance from the stop at that speed), and the
  plate of the service's first bus due at the next stop.
- **Missed:** three minutes after the planned departure, below 1.5 m/s, and
  still within 80 m of the boarding stop or still in your residence. A miss
  at the stop (`atStop`) lets the next bus from it be noticed the same way,
  whichever service it is.
- **There:** on the bus (tapped, detected or assumed), within 100 m of the
  stop you get off at, either side of the road; or the answer planned from the
  fix says you're at the destination.

A tap always wins: detection only changes a trip nobody has answered, or one
it answered itself, except that it notices the end of a ride someone said they
were on.

Nobody is asked what detection can tell. Each fix also notes the time on the
day's record (`followed`, at most once a minute); while the last one is under
90 seconds old the card has no "On the D2" / "Missed it" / "I'm there" and no
question, and a silence isn't noted as "no answer". Plans ("Not going", "Not
on campus today") stay on the app's card. Anything detected has
`detected: true` and one quiet action, `undetected` ("Not right?", also for
ten minutes after a detected arrival, which puts you back on the bus), shown
as a link on the app's card and never on the widget or in a notification. The
widget shows only status buttons, and notifications never show "Not going".
When the fixes stop, the buttons and the question come back. A `waiting`
record (a fix at the stop) is not an answer: after the departure only a
location at the stop now counts as missed. The trip
record is then `undetected` (or the ride again, with `noDetect`), which the
planner reads as no record at all but which stops detection, and the
"no answer means on it" assumption, for that trip. Analytics counts
`detected:<kind>` signals separately from taps.

**Measured ride times (8.2, `ridetimes.ts`).** A ride detection saw start and
end is one row in `ride_times` (migration 0008): service, stops, hops,
seconds, hour and kind of day, plate. No user, device or location. Rides
under 30 s or over 300 s a stop are dropped as mistakes. Taps never count:
they are minutes out either way. Once a day from 04:00 the cron prunes rows
older than 120 days and writes seconds per stop to KV (`ride:hops`): per
service with at least 10 rides, and per hour of the day with 10 of its own,
clamped to 45 to 240 s. `answerFor` reads it (cached ten minutes per isolate)
and passes `hopS` to the resolver, so a leg's `rideS` is measured where the
table has the service and `RIDE.secondsPerHop` elsewhere.

**When a class really ends.** NUS classes end about half an hour before the
timetable's end time, to leave time to get to the next one. `endOf` takes
NUSMods classes (tagged `nusmods` by `classesOn`, never stored) as ending
`ENDS_EARLY_MIN` (30) minutes early, never less than 15 minutes after they
start: the trip home, gaps long enough to go home in, `/me/day`'s `endsAt`
and "In CS2030 till ~11:30" all follow. Classes entered by hand, usual times
and one-off trips end when they say.

**More than class trips (8.3).** Today's trips are `classesOn(profile)`:
the imported and hand-entered classes, plus two kinds that are planned the
same way (leave-by, the question, push, detection, "Not going"):

- `profile.usual`: a saved place at a usual time, `{place, day, atMin}`,
  kept apart from `places` so an older app rewriting the places can't drop it.
- `profile.once`: a one-off trip on a date, `{date, arriveByMin, to, label}`,
  added with `POST /me/once` and dropped once its date has passed.

Each counts as an hour there, for what the planner does next. On an idle trip
the card also offers `away` ("Not on campus today"), which records every trip
left today as skipped with `away: true` (not as outcomes, so a day away never
suggests dropping a class); the free card then says so and offers `back`.
The Android widget's buttons (Timetable, Nearby, and the places you use most,
counted on the phone) switch the widget in place: `WidgetModes.kt`.

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
Usually nobody has to: on a 10009 the cron check runs
[`src/appversion.ts`](../src/appversion.ts), which reads the new version from
NUS's refusal if it names one, or from the uNivUS pages on Google Play
(versionName) and APKCombo (versionName and versionCode). It tries the
likeliest strings with NUS (a token and one bus call each, three at most),
writes the one NUS accepts to `config:appVersion`, and emails to say so. Each
candidate is tried once, and the pages are read at most hourly while NUS keeps
refusing. If nothing works, the usual "feed is down" email follows, saying what
it tried, with the command above and NUS's full response. To see what it would
find today, without calling NUS: `GET /health?versions=1` with the
`x-health-token` header.

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
  dressed up as a number. Measured ride times (phase 8.2) replace it per
  service and hour once enough rides have been detected; until then, and for
  services nobody rides with detection on, it is still the guess.
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
src/accounts.ts   Sign-in codes and links, sessions, anonymous accounts, pairing codes (D1)
src/applogin.ts   App sign-in approved from the email
src/access.ts     API keys, and who may call the keyed routes
src/profile.ts    Profile validation and the where-next planner
src/me.ts         /auth, /pair and /me routes
src/next.ts       /me/next's answer: the plan, free days, riding, the trip's phase
src/day.ts        /me/day, today's timeline
src/trip.ts       Trip phases, and the per-user Durable Object with today's signals
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
