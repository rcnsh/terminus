# terminus API: how it works

A Cloudflare Worker that answers one question about the NUS internal shuttle
bus: **when is my bus, and should I run.**

It is not a bus tracker. Good NUS bus trackers already exist. The problem is
that answering a three-second question currently takes six taps — open the app,
find the stop, pick the correct side of the road, read a table, work out which
service actually goes where you are going.

```
GET /next  ->  { "label": "D2 · 4 min",
                 "detail": "Opp KR MRT · right here · COM3 ~6 min · crowding: low · or A1 9 min",
                 "alt":    "A1 · 9 min · Kent Ridge MRT",
                 "quality": "live", ... }
```

The server returns a pre-rendered string; clients render it without computing
anything. The widget, the menu bar, a web page and a notification all show the same
`label` and `detail`. The moment a client starts
formatting for itself, four interfaces begin to drift apart and there are four
places to fix every bug.

This document is about the API. The clients (Android, Mac, the website) are
the other folders in `apps/`; the Worker serves the website too, so `GET /` is
the landing page and `GET /docs` the API documentation. The OpenAPI spec lives
in [src/openapi.ts](../src/openapi.ts) and a test fails if a route and the spec
drift apart.

---

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
| `GET /buses?svc=<service>` | One service's live buses for the map: the stop each is at (within 40 m along its route) or the two it's between, where to draw it (the stop's dot, or a point on the route line between the stops), the road's heading there, crowding and the next stop; between stops, the stretch of route it's on. A bus away from its route is left out. One upstream call per service per 5 s; each bus with its number plate. |
| `GET /campus` | Stops (with the services that call there), each route's path along the roads, the services' colours, and destination search data. Written once per isolate, with an ETag: a client revalidating gets a 304. |
| `GET /map/campus.pmtiles` | The campus street map from R2, by byte range (PMTiles). Open, like the website. Each piece, font and icon is kept in the edge cache under the file's ETag and its byte range, so R2 is read once per piece per data centre; a new upload is seen within 5 minutes. |
| `GET /map/style.json?theme=&lang=` | The map's MapLibre style, light or dark, English or Chinese: Protomaps' map without its points of interest, every URL on this domain. |
| `GET /map/fonts/…`, `/map/sprites/…` | The map's label glyphs and icons, from R2. |
| `GET /download/android`, `/download/mac` | The current app downloads from R2, as `latest.json` there names them. `?abi=` picks an Android APK by CPU type; `/download/appcast.xml` is the Mac app's Sparkle feed, `/download/latest.json` the version list, `/download/releases/<version>/<file>` a versioned file. |
| `GET /stops/pairs` | Each stop with its twin across the road, and where the buses on each side go next. Cached hard. |
| `GET /health` | Graph age and which config is present, never values. `?probe=1` tests auth. |
| `GET /status.json` | Whether NUS's feed is up, as the 15-minute check saw it, and the last 20 outages. The [status page](../../web/public/status) shows it. |
| `GET /admin/stats` | The operator dashboard's data (accounts, devices by app, sign-ups, reports, feed; answers and errors per day from Analytics Engine when `ANALYTICS_TOKEN` is set). Needs `x-health-token`; anything else gets a 404. |
| `GET /account` | The account page ([apps/web](../../web)), served as static assets. |
| `POST /auth/login`, `/auth/code`, `/pair`, `/me/*` | Accounts. See below. `POST /me/feedback` is "Is this wrong?": the answer the user saw and a note, kept with the account and emailed to `ALERT_EMAIL`. |

`/next`, `/trip`, `/arrivals`, `/buses`, `/campus` and `/stops/pairs` need an API key
(made on the account page, sent as `x-api-key`) or a signed-in session. They're
limited by who's asking: a signed-in account by account (`RL_ME`, `acct:`),
an API key by key (`RL_PUBLIC`, `key:`), and a request with neither by IP.
On campus Wi-Fi hundreds of students share one IP, and the map alone asks
for buses every 5 s. `/health`, `/status.json`, `/admin/stats` and
`/download/*` stay limited by IP. `/map/*` is limited by IP only where it
reads R2 (`RL_MAP`, 300 a minute): a piece already in the edge cache is
never refused, so a lecture hall can open the map at once.

Every 429 carries `Retry-After`, and every client waits it out, at most 5
minutes, sending nothing meanwhile (web `send()` in `account/dom.js`,
Android `Quiet`, Mac `Quiet`). A refused request still costs a Worker
request, so a client stuck in a loop must stop asking, not just fail.

What the bill depends on, and the guards against it:

- Worker requests are what grows with use. Static files under `/assets/`
  and `/vendor/` skip the Worker (`runWorkerFirst` in
  `cloudflare.config.ts`; their headers are in `apps/web/public/_headers`,
  checked against `withSecurityHeaders` by a test), so they're free.
- `limits.cpuMs` (5 s) stops a request that loops from running on.
- The map's pieces come from the edge cache, so R2 is read once per piece
  per data centre.

## Personalisation

Per-user trips come from the account (`/me/next`): a NUSMods timetable
imported with `POST /me/import`, plus classes entered by hand. Imported classes only
count in the weeks they run ([src/calendar.ts](../src/calendar.ts), built from
NUSMods' semester dates and MOM's public holidays by
`scripts/fetch_calendar.py`). [`src/config.ts`](../src/config.ts) holds the cache
TTLs and tuning constants.

The calendar keeps itself up to date without a deploy
([src/calendarsync.ts](../src/calendarsync.ts)). `data/calendar.json` is
bundled at deploy time, and the scrape workflow refreshes it weekly, but a
bundled file only changes when someone deploys. So the cron also fetches the
same two sources once a week. The copy must pass checks:
- dates are real, and every semester starts on a Monday;
- there are terms 1 to 4 and at least 4 semesters and 5 holidays.

A copy that passes is merged over what's known and kept in KV
(`calendar:data`). After a failure the cron tries again the next day, and the
error is in the Worker's logs as `cron calendar`.

Every request, and the Trip object, reads that copy at most every 10 minutes
per instance and merges it with the bundled one; the newer wins where they
differ. A source that drops a year loses nothing, and a broken reply changes
nothing.

`/health` says which is in use (`calendar.source`: `bundled` or `fetched`)
and how far it goes. The "calendar runs out soon" email only comes when even
the fetched copy is within 45 days of its end, that is when NUSMods doesn't
list the next academic year yet. Past the end, imported classes count every
week, as before.

## Accounts

Sign-up is open; addresses on the `blocklist` table are refused. The account
page at `/account` signs in with an emailed code (or the link in the same
email) and stores one profile per user in D1: timetable, home stops, gap threshold and
saved places. A saved profile that no longer validates as a whole (a stop
dropped by the weekly scrape, say) is read back part by part
(`salvageProfile` in `me.ts`): whatever still holds is kept, so the next save
doesn't write defaults over the day's hours, usual times or one-off trips.
Request bodies are read with a hard cap as they arrive (`readCapped`, 64 KB
for JSON), whether or not they declare a length. Apps hold a device token (`Authorization: Bearer`), which they
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
- `GET /me/nearby` lists departures at up to three stops near you, each with
  its service's colour (`color`, as on the buses and the map).
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

### One plan, and push

- **One plan, everywhere** ([src/plan.ts](../src/plan.ts)). The Worker saves the bus a trip is for in the
  day's record (`DayRecord.plans`): from the moment the trip is due, or
  earlier when it was planned from the phone's location (`Boarded.located`).
  Every device then says that bus (the card, the notifications, Today in
  `/me/day`), and it's the bus detection watches. A device without a location
  (the widget, the background refresh, the Mac, the web) shows the phone's
  plan rather than one of its own from where the timetable puts you; a
  located answer replaces it. The same service from the same stop within
  three minutes is the same bus (live times move a little each answer), so
  it isn't saved again. From 15 minutes before its leave-by (at the stop, and the
  heads-up), the bus you were told stays the plan while it still gets you there on time, even if a fresh answer would
  prefer another; only one that would now make you late gives way. The plan freezes at its leave-by, or when its bus
  leaves if that comes first: after that the answer would name later buses
  (and, from a moving bus, other stops), but the trip, the card and the ride
  stay about this one, until a miss, when the card shows the next way there.
- **"At the stop"** means at the plan's boarding stop from 15 minutes before
  its leave-by (`WAIT_EARLY_MS`): not hours before at a stop you live by, and
  not at a stop you're riding past. The headline is then the bus ("D2 at
  9:41"), never "Leave by" or "Leave now".
- **A missed class is not where you are.** One whose last record is `missed`
  isn't where the next trip is planned from (`DayState.missed`), on the card
  or in Today: without a location, from the class before or from home.
- **Nothing is asked.** The card has no question in it (the apps can still
  send `boarded`, `missed` and `arrived` signals). Three minutes
  after the departure the phase is taken as `riding` (`TripView.assumed`),
  and the phone's location corrects it: at the boarding stop, or standing
  still off the bus's road, makes it `missed` (detect.ts); in your residence
  ends a trip home, and at the destination ends the trip (`reached`, recorded
  as `arrived` for every device). Nothing is recorded for an assumption.
- **The ride from the feed.** Boarding records the plate of the bus due at
  the boarding stop within five minutes; while riding, the same plate in the
  alighting stop's arrivals gives the arrival (quality `live`). Without a
  plate, the arrival is an estimate, marked `~`.
- **Outcomes** ([src/outcomes.ts](../src/outcomes.ts), `trip_outcomes`, 35
  days): what detection saw (boarded, missed, arrived) and "Not going";
  three misses of one class in 30 days suggest a bus earlier (`ArriveBy.oneEarlier`);
  three skips in a row offer to stop reminders (`card.remind: false`). Choices
  are `trip_prefs`; a turned-down suggestion waits 30 days.
- **Push** ([src/push.ts](../src/push.ts), [src/tripdo.ts](../src/tripdo.ts)).
  When `FCM_SERVICE_ACCOUNT` is set, a card served on a class day asks the
  Trip object to wake at `nextPhaseAt` (due, leave-by, departure, +3 min,
  class start, ride end; not at `staleAt`). At each wake it works out the card
  again, nudges the user's devices (`sessions.push_token`) if the phase
  changed, and schedules the next wake; with no device taking
  push it stops. A nudge is a data message, `{kind: 'card', phase}`, high
  priority for due and missed; the app fetches /me/next
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
arrival) instead of a leave-by that has passed. Apps send it the same
`lat`/`lon` as `/me/next`, and the next class is planned from there, so Today
and the card agree even on the first load, when both are asked at once and
the card's plan isn't saved yet. (Without it, Today planned from the home
stop and its walk from Settings, the card from where you were, and they
differed by a few minutes until the next refresh.) Later classes are planned
from the class or home before them.

Card v2 adds `phase`, `phaseText`, `glance` (12 characters, for a menu bar
or a tile), `line` (one line, for a notification), `actions`, `warning` and
`nextChangeAt` (when the card changes by itself). While riding, `ride` lists
the stops from boarding to getting off, with the board and arrival times (the
arrival live when the bus's plate is known), for a progress bar. v1
fields are unchanged. `notice` is a line above the answer while the monitor
has NUS's feed down ("NUS's live bus times have been down since 9:14 AM"),
on an answer that is an estimate or has no time (the feed may be back
before the next check, and a day with no bus needs no notice). Each isolate reads the monitor's state from KV at most once a
minute (`feedDownSince`).
- Tokens are stored as SHA-256 hashes. A web session lasts 30 days from its
  last use: `GET /me` pushes the expiry back 30 days, and sends the cookie
  again, once fewer than 23 days are left. However much it's used, a web
  session of an account with an email ends 180 days after sign-in (one with
  no email keeps it: it has no other way back in). Device tokens last until
  revoked, or 90 days unused.
- Sign-in emails: one a minute and ten an hour per inbox, web and app
  together. The emailed code's wrong guesses are counted on the link's row
  (`magic_links.code_tries`, migration 0009), five at most.
- `POST /auth/verify`, `/auth/approve` and `/auth/logout` are refused when
  `Sec-Fetch-Site` says another site sent them, so no page elsewhere can sign
  a visitor in to an account it holds a link for, or out of theirs.
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

### The web app

`/app/` is terminus as an installable web app, meant for iPhones: the answer
card, chips for saved places and Nearby, and Today; the campus map; and
Settings. It uses the same routes as the account page, with the session cookie.

- **How the pages are built.** Preact components with htm templates
  (`assets/ui.js`, Preact vendored by `scripts/vendor-preact.sh`), loaded as
  written: no build step, so the service worker keeps exact files and the
  API's tests import the plain modules (`search.js`, `offline.js`). htm needs
  no `eval`, so the CSP stays `script-src 'self'`. State several parts share
  is a `store()`: the profile and `/campus` (`account/profile.js`), and in
  the app what the card is for, the card, Today and the push switch (top of
  `app/app.js`). The tabs are shown and hidden by the fade itself, not by
  Preact, so it can swap them between its halves; MapLibre is driven
  directly inside the Map tab's effects. With no bundler the browser finds
  a module's imports only once it has it, one round trip per level, so
  `/app/` and `/account/` list every module they start with as
  `modulepreload` links (kept right by `web-sw.test.js`). What isn't
  needed at first loads with `import()`: the map and Settings in the app,
  and Settings and setup on the account page once someone is signed in.

- **Tabs.** Now, Map and Settings are three views of one page (`#map`,
  `#settings` in the address, so Back and a reload keep the tab). Switching
  fades through as the Android app does (Web Animations: out in 90 ms, in
  over 210 ms from a 0.92 zoom; a plain short fade with reduced motion), and
  Now and Settings come back where they were scrolled to.
- **Settings** is the account page's own: the `Settings` component in
  `account/settings.js`, its pages in `account/settings-pages.js`. The
  account page draws it after sign-in and setup, with its widget preview; the
  app draws it the first time Settings opens, without the preview (Now has the
  card) and with Sign out or Add an email in Account. Both read and change one
  copy of the profile (`account/profile.js`), which the map's "Save as place"
  changes too, so a place saved on the map is in Settings at once. It's
  fetched afresh each time Settings opens again (it may have changed on
  another device), unless a change here is still waiting to be saved.
- **Settings' pages.** A list in three short cards with headings: Your day
  (Your trips, Timetable, Favourites, Notifications in the app), Account
  (Account, Devices) and Display (Language and time, and Appearance, whose
  Auto/Light/Dark switch is on its row, with no page). Links under the list
  open About and Send feedback, and go to Privacy and Status. Each row has a line
  saying what's set, opening its page. The page is in the address (`#trips`
  on the account page, `#settings/trips` in the app), so the browser's Back
  returns to the list. On a phone the page slides in over the list; from
  900 px wide they sit side by side. The installed app on an iPhone, which has
  no browser swipe, goes back on a swipe from the left edge. "Notify me when
  to leave" is under Notifications. Send feedback posts a note to `/me/feedback`
  as `kind: 'other'`; a wrong answer is better reported from under the card,
  which attaches it.
- **12- or 24-hour times.** The profile's `clock` (`auto`, `12`, `24`)
  is the account's choice, set in Language and time or in setup. The server
  words every card in it (`hour12()` in next.ts: the profile's choice, else
  the request's `?h12=1`) and says which on the card (`card.h12`). Each
  client keeps a copy (web `dom.js` `hour12()`, Android `Clock`, Mac
  `Clock`) so the times it writes itself, and the widgets, match; `auto`
  follows the device.
- **Now.** A search button at the end of the chips opens "Go somewhere
  else" (account/search-box.js, ranked by search.js, over `/campus`'s
  destinations); a pick shows its card under a chip of its own. "Is this
  wrong?" under the card sends it to `/me/feedback` (account/preview.js
  `Report`), except for Nearby. A stop's name in Nearby opens it on the map
  (MapTab's `focus` in map.js).
- **Theme.** Appearance's switch chooses light, dark or the device's own, for this
  browser only (`localStorage` `terminus-theme`). `assets/theme.js`, in every
  page's `<head>`, sets `<html data-theme>` before the page draws; `site.css`
  has the dark colours under both the device's dark mode (unless
  `data-theme="light"`) and `data-theme="dark"`. The map follows it too.

- **Install.** `/manifest.webmanifest` has `start_url` `/app/`, the icons in
  `assets/icons` (drawn by `apps/android/store/render.swift`), and a share
  target that opens Settings with a shared NUSMods link ready to import. On an
  iPhone in Safari, the page explains Add to Home Screen, since iOS never
  offers it. A web app on the Home Screen has its own cookies, so it signs in
  once by itself. The sign-in code is typed there; the emailed link would open
  in Safari. `/account/?next=/app/` comes back to the app after sign-in, and
  `/account/?add=1&next=/app/` adds an email from the app's Settings.
- **Offline.** `/sw.js` fetches the app's files network-first and keeps a
  copy for offline (`SHELL_FILES`; `web-sw.test.js` fails if a module the app
  imports at startup is missing from it). `/me`, `/me/next` and `/me/day` are
  also network-first, and the last good reply is kept (one per route, place
  and `to`, so a searched stop's card never stands in for the plan's). When the network
  is down, the kept reply comes back with `x-terminus-cached` (when it was
  fetched), and the page dims the card and says so. Signing out, deleting the
  account or a 401 empties the kept replies.
- **Offline, all day.** Once the kept answer has gone stale (its bus has
  left, or 15 minutes have passed) and the network is still down, every app
  falls back to the day plan it kept from `/me/day`: the next class's
  leave-by and how ("Leave by ~13:38 · walk"), "Leave now" once that has
  passed, then the trip home. The rule is the same on all three
  (`app/offline.js`, `OfflineDay.kt`, `OfflineDay.swift`): skip what was done
  or taken off when the plan was fetched, a class 15 minutes after it starts,
  and a trip home at its end (or an hour after it starts); only a plan for
  today counts. All three are tested against `test/fixtures/offline-day.json`
  on the `/me/day` golden. The Android widget's background refresh fetches
  `/me/day` hourly to keep the plan current, and arms a redraw alarm (no
  network needed) for the moment the offline line next changes.
- **Push.** `POST /me/push` with `{subscription}` keeps the browser's Web Push
  subscription on the session as `web:` plus its JSON, next to where an
  Android session keeps its FCM token. So the Trip object's nudges reach both,
  through `push.ts` and `webpush.ts`. Each push is VAPID-signed with
  `VAPID_PRIVATE_KEY` (a P-256 JWK; `scripts/vapid-key.mjs` makes one) and
  its payload encrypted with aes128gcm, using WebCrypto only. Only
  subscriptions on browsers' push services are kept (FCM, Mozilla, Apple,
  Windows): the Worker POSTs to the endpoint, so any other host is refused.
- **Every day, not just when the app is open.** A Trip object only watches
  once a request asks it to. The Android app asks from its background
  refresh, but a Home Screen web app makes no requests unless it's opened. So
  from 06:00 Singapore time the cron (`armTrips` in monitor.ts) asks the Trip
  object of every user with a push address to watch the day, 400 users a
  run, 20 at a time; each 15-minute run carries on after the last user the
  one before armed (`trips:armed` in KV holds the date and that user, then
  the date alone when the day is done). It works out the card, wakes at each
  change and pushes, and on a day without classes it stops. Saving a subscription also refreshes the card, so a Trip object that
  woke before the subscription existed is asked again.
- **What a push shows.** A web push must show a notification (iOS insists).
  So the web app isn't pushed an idle card, or a trip with reminders off. The
  service worker fetches `/me/next` and words the notification as the Android
  app does: the ride, or the next way there after a missed bus; otherwise
  when to leave. Nothing asks what happened. Its one button, before you've
  left, is the card's "Not going": the service worker posts
  `/me/signal` `{kind: 'skipped'}` itself, without opening the app (the
  Android notification has the same button). A tap elsewhere opens the app.
- **A new semester.** In the week before semester 1 or 2 starts
  (`semesterSoon` in calendar.ts), from 10:00 Singapore time, the cron
  (`remindTerm` in monitor.ts) pushes each device of a user whose imported
  timetable is an older semester's: `{kind: 'term', title, body, zhTitle,
  zhBody}`, worded by the server in both languages, since the device picks
  its own. Anyone who has already imported the new semester, or has never
  imported one, is skipped. It goes once per semester, 400 users a run, with
  `term:reminded` in KV marking the semester and the last user reached, as
  `trips:armed` does. A tap opens the timetable settings on the web, and the
  app on Android. The Mac app has no push, so it isn't told.

### Every trip, detected

**Detection (`detect.ts`).** During a trip the Android app sends
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

Nothing is asked, so a wrong guess puts itself right: taken to be on the bus
(detected, or nobody said) but standing still more than twice the corridor
off its road is a miss, and the plan moves on to the next way there. Each fix
also notes the time on the day's record (`followed`, at most once a minute).
Anything detected has `detected: true` ("Looks like you're on the bus"). The
cards offer only plans ("Not going", "Not on campus today"). A `waiting` record (a fix at the stop) is not an answer: after the
departure only a location at the stop now counts as missed. Analytics counts
`detected:<kind>` signals separately from taps.

**Measured ride times (`ridetimes.ts`).** A ride detection saw start and
end is one row in `ride_times` (migration 0008): service, stops, hops,
seconds, hour and kind of day, plate. No user, device or location. Rides
under 30 s or over 300 s a stop are dropped as mistakes, and so are rides
from accounts under 3 days old and a second ride on the same service in the
same hour from one account (a short-lived KV mark, so the rows still hold no
user). Taps never count:
they are minutes out either way. Once a day from 04:00 the cron prunes rows
older than 120 days and writes seconds per stop to KV (`ride:hops`): per
service with at least 10 rides, and per hour of the day with 10 of its own,
the median seconds per stop, clamped to 45 to 240 s. `answerFor` reads it (cached ten minutes per isolate)
and passes `hopS` to the resolver, so a leg's `rideS` is measured where the
table has the service and `RIDE.secondsPerHop` elsewhere.

**When a class really ends.** NUS classes end about half an hour before the
timetable's end time, to leave time to get to the next one. `endOf` takes
NUSMods classes (tagged `nusmods` by `classesOn`, never stored) as ending
`ENDS_EARLY_MIN` (30) minutes early, never less than 15 minutes after they
start: the trip home, gaps long enough to go home in, `/me/day`'s `endsAt`
and "In CS2030 till ~11:30" all follow. Classes entered by hand, usual times
and one-off trips end when they say.

**Taking something off today.** Every `/me/day` entry not done yet is
`removable`. The apps take it off with `skipped` and its key (swipe on
Android, × in the web app and on the Mac), then show Undo for six seconds,
which sends `reset`. It's the same whatever the entry is: a timetabled class,
one entered by hand, a usual time or a one-off trip is skipped for today only
(deleting a weekly one is in Settings), and a trip home skipped means staying:
`planFor` plans no trip home after the last class, and in a long gap plans the
next class from where you are. Skipped entries aren't listed; a skipped trip
home isn't an outcome.

**More than class trips.** Today's trips are `classesOn(profile)`:
the imported and hand-entered classes, plus two kinds that are planned the
same way (leave-by, push, detection, "Not going"):

- `profile.usual`: a saved place at a usual time, `{place, day, atMin}`,
  kept apart from `places` so an older app rewriting the places can't drop it.
  The apps no longer add them (a place you go every week is added to the
  timetable by hand); ones already saved are listed in Timetable, where they
  can be removed, and go with their place when it's removed.
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

**KV holds small, slow-changing state, never the arrivals.** The guest token
and device id, the `config:appVersion` override, the monitor's view of the
feed and its incidents, measured ride times (`ride:hops`) and a few
short-lived marks. KV writes are rate-limited and propagation is eventual,
which is wrong for 15-second data: arrivals and live buses live in the edge
cache.

**The stop graph is static and bundled.** Stop locations, route order and
operating hours change a few times a year. `pnpm scrape` rebuilds
`data/stops.json` from the bus proxy's `bus-stops` and `pickup-point` calls.
The proxy has no `ServiceDescription`, so the route codes to fetch come from
the existing graph plus `KNOWN_ROUTES` in the script; a new service with an
unlisted code needs adding there. The **scrape stop graph** workflow
(`.github/workflows/scrape.yml`) runs the same scrape every Monday with the
feed secrets, tests the result and commits it to `main`; a deploy then puts
it live.

**Route lines follow the roads.** `scripts/route_shapes.py` routes each
service stop to stop along OpenStreetMap's drivable roads (one-way streets
respected, each stop joined on the side the bus drives) into
`data/shapes.json`; the weekly scrape runs it after the stop graph and
`check_scraped.py` checks the result. Each shape records the stops it was
made for: a route whose stops changed since is drawn as straight lines
until the next run. The NUS feed has no route shapes of its own.

**The street map is one file on R2.** `scripts/map-tiles.sh`, run by the
**map tiles** workflow, cuts the campus (about 4 MB) from the Protomaps
build of OpenStreetMap and uploads it, with Noto Sans glyphs and the light
and dark icons, under `map/` in each site's downloads bucket (stable and
beta have their own; the workflow does both by default). Twice a year is
plenty; run it by hand once after a first deploy.

**Failure degrades in public.** `quality` walks `live → scheduled → stale →
ended`. A stale answer keeps its **original** `asOf` timestamp. A three-minute-
old answer honestly labelled beats a spinner, and beats an empty tile that
reads as "no buses". Only a real arrival becomes `stale`; a headway guess
from an old answer stays `scheduled`. Arrival times count from when they were
fetched, so a bus that has left since then (by the walk to it) is never
offered as catchable.

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

`normalize()` and `normalizeBuses()` treat anything they can't read as
missing, never as zero: an `arrivalTime` that is negative or looks like a
clock time ("-3", "12:30") is no time, and a live bus with a blank or null
latitude, longitude or direction has no position or heading, rather than
sitting at latitude 0 or heading north.

A reply the feed calls OK but that can't be read is a failure, never an
empty board. With no list at all (`hasList`), or a list whose rows lost
what `normalize()` reads (`arrivalsProblem`: no row names a service, none
names a service we know, or none has an arrival time; `busesProblem`: no
row has a plate or a position), the fetch throws. Read as it was, every
service would have "no bus", every card a headway guess, the map "No D2
buses running", and the monitor's probe a healthy feed. Thrown, it is the
feed being down: the last answer while it's under five minutes old, then
"No live data", the monitor's email after two checks, and the feed-down
notice on the card. How far away the times are is not checked: after
midnight every real arrival is the next morning's, hours away.

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
algorithm is actually right, which nothing else measures, and inter-stop
travel times from the feed's own predictions (`plate` is the join key), a
cross-check on the ride times detection measures. Queries and
the schema contract are in [docs/analytics.md](analytics.md).

Logging is a no-op without the binding and swallows its own errors. An answer
that failed because logging failed would be an absurd way to miss a bus.

## Known weaknesses

- `RIDE.secondsPerHop` is a **guessed constant** and the ranking inherits its
  error. It separates a 2-hop ride from a 14-hop ride, which is the case that
  matters; it does not reliably separate 4 hops from 5. `stop.confidence`
  reports which situation you are in — below ~0.6, the answer is a coin flip
  dressed up as a number. Measured ride times replace it per
  service and hour once enough rides have been detected; until then, and for
  services nobody rides with detection on, it is still the guess.
- `quality: 'scheduled'` has no timetable behind it. It means "inside operating
  hours, feed gave nothing, here is a headway estimate". It is the weakest rung
  of the ladder and it is labelled as such.
- The `-S` / `-E` rule rests on one captured stop. If any NUS route uses a
  different berth convention, `resolveBerths()` will fall through to the
  ambiguous branch and cap confidence, which is the safe direction to fail —
  but it wants a second terminus in the fixtures to confirm.
- Most stop fixtures come from `bus.hewliyang.com`'s proxy, not the feed
  directly: the rows are passthrough, the envelope is his. One raw ConnectX
  `ShuttleService` body (`connectx-ShuttleService-COM3.json`) confirms the
  rows. There's no capture of the current bus proxy's reply yet; `normalize()`
  is tested on both shapes it replaced.

## Clients

The Android widget and app ([apps/android](../../android)), the Mac menu bar app
([apps/macos](../../macos)) and the website ([apps/web](../../web)) all use `/me/next`.
The Android app and the web app also have the campus map: `/campus`, `/buses`,
`/arrivals` and `/map/*`.
For local work, `node scripts/dev-stub.mjs` runs this Worker with a fake bus
feed and a seeded test account.

### Live buses on the map

`/buses` shows each bus at a stop or between two (`src/buses.ts`). The feed
gives a position, a speed and a heading every 15–20 s per bus (the reply's
own time stamp changes that often, for every bus at once, however often
it's asked): too far apart, and too noisy, to draw a bus where it really
is. So each bus is placed on its route line, the route's road shape from
`data/shapes.json` with each stop's distance along it, only to tell where
it is in the route:

- Within 40 m of one of its stops, measured along the line (so never the
  twin stop across the road), it's at that stop (`at`), drawn at the stop's
  dot. Stops are at least 136 m apart along every route, so a bus is never
  within 40 m of two. Several at one stop get a `slot` each, 0 for the one
  furthest on.
- Otherwise it's between the stop it passed and the next, drawn halfway
  along the line between them; with several there, spread evenly, in the
  order they're in (a third and two thirds for two). Two close together can
  swap places in the feed, so on the same stretch they keep the order they
  were last shown in, and a bus is never drawn behind where it was last
  shown on that stretch (one coming into the feed ahead of it, or the one
  ahead leaving, would otherwise push it back). Its `stretch` is that part
  of the line, from the stop it passed (`last`) to the next, in metres
  along the line: on a long stretch the midpoint can be hundreds of metres
  from the bus, so a tapped bus shows the whole stretch as where it is.
- Before a route's first stop it's at the first; past a one-way route's
  last, at the last. A bus more than 50 m from its line (the depot, a
  detour), or on a service with no line, isn't shown.

`heading` is the way the road runs at the place it's drawn, and `nextStop`
the stop after the one it's at, or the one it's heading to.

The hard part is the side of the road. Most of D1, D2 and K, and parts of
the others, use one road both ways, and the two directions of the line are
0–12 m apart, often drawn on the very same points. A bus's GPS can't tell
them apart, and a bus drawn on the wrong side shows the wrong next stop,
kilometres round the route.

So each bus has a track: where along the line it was last placed, and when.
A bus drives forward along its route, so a new position counts only where
the bus could have driven to since (from 50 m back, for GPS error, to
100 m + 20 m/s ahead), and the other side of the road is never one of
them. Among those places, a stretch running the way it's heading comes
first, then the least distance driven. A position a little behind the
track leaves the bus where it was, so `along` never goes back.

A bus with no track (just appeared, or nobody watched the service for ten
minutes) is placed by its heading when moving; standing, by the stop it's
at, if it's clearly nearer one stop than its twin across the road; otherwise
on the nearer side. A track that started wrong gives way when the bus is
seen moving the other way twice in a row; one odd heading doesn't move it.
A tracked bus that strays more than 50 m off its line for under 30 s (a GPS
jump) stays at its last place; longer (the depot, a detour), it's drawn
where the feed puts it, with no `along` and no next stop.

The tracks live in the edge cache with the placed answer, keyed by service
(`trackedBuses`). Each feed update is placed once per data centre, and every
Worker instance there returns that answer and places the next update from
those tracks. Kept in each instance's memory instead, a request landing on
another instance would place a standing bus afresh, often on the wrong side.

The older NextBus API (`nnextbus.nus.edu.sg`) still answers, behind a
password NUS hasn't given us, and almost certainly reads the same 20-second
positions.

Clients draw a bus at a stop just beside its dot, on the kerb side (left
of the way it's going: buses drive on the left), so the dot stays in sight,
and the ones behind it (`slot` 1, 2) one bus further back along the road
each. The offset is in pixels, so it looks the same at every zoom. When a
bus's place changes, it slides there along the route line at a steady 150 m a
second, so a longer stretch takes longer: from 0.8 s for a short hop to
4 s, done before the next answer, 5 s on; with reduced motion, after 15 s without an answer, or to a place
it can't reach along the line (behind it, or over 1.5 km on), it jumps.
A tapped bus is ringed. Between stops, its `stretch` is drawn over the
route, wider, with the rest of the route faded well back, and its card
says "Between LT13 and COM 3".

## Layout

```
src/index.ts      Router
src/resolve.ts    Haversine, directional pairing, downstream reachability, scoring
src/format.ts     label/detail strings, the degrade ladder
src/fms.ts        ShuttleService client + defensive response normalisation
src/auth.ts       Public token, lazy refresh, KV + in-memory memo
src/config.ts     Cache TTLs and tuning constants
src/calendar.ts   NUS teaching weeks and public holidays
src/calendarsync.ts  The calendar fetched weekly by the cron into KV, between deploys
src/nusmods.ts    NUSMods share URL -> trips
src/campus.ts     /campus: stops, route lines and colours, destination search
src/buses.ts      /buses: live buses placed on their route, next stop
src/map.ts        /map/*: the street map file, its style, fonts and icons
src/pairs.ts      /stops/pairs
src/analytics.ts  Analytics Engine decision + arrival logging
src/openapi.ts    OpenAPI 3.1 spec and the Elements docs page
src/http.ts       JSON responses, query parsing
src/seo.ts        robots.txt and the sitemap; the beta asks not to be crawled
src/accounts.ts   Sign-in codes and links, sessions, anonymous accounts, pairing codes (D1)
src/applogin.ts   App sign-in approved from the email
src/access.ts     API keys, and who may call the keyed routes
src/profile.ts    Profile validation and the where-next planner
src/me.ts         /auth, /pair and /me routes
src/next.ts       /me/next's answer: the plan, free days, riding, the trip's phase
src/day.ts        /me/day, today's timeline
src/trip.ts       Trip phases, and the per-user Durable Object with today's signals
src/tripdo.ts     The Trip object's wakes and push
src/answer.ts     The answer engine: stops near you, their arrivals, the best bus
src/card.ts       The card every client shows, worded once
src/leave.ts      When to set off; src/clock.ts clock times and lateness
src/plan.ts       Which bus a trip is about: one plan for every device
src/detect.ts     What a location says about the trip
src/outcomes.ts   What happened to each planned trip, and what it suggests
src/ridetimes.ts  Measured ride times
src/crowd.ts      Full buses: a packed bus can pass a stop
src/walk.ts       Walking along campus paths (data/walks.json)
src/graph.ts      The stop graph, with hand-kept fixes
src/geo.ts        Distance (a leaf module)
src/residences.ts, src/landmarks.ts  Halls and named places served by several stops
src/push.ts       FCM to Android; src/webpush.ts Web Push to the web app
src/monitor.ts    The cron: feed health, incidents, housekeeping, arming trips,
                  the new-semester reminder
src/appversion.ts Finding the new uNivUS version when NUS refuses the old one
src/downloads.ts  /download/*: app files and the Mac appcast from R2
src/admin.ts      /admin/stats; src/feedback.ts "Is this wrong?" reports
src/i18n.ts       Every server string in English and Chinese
src/site.ts       Which Worker this is: stable or beta
migrations/       D1 schema
```

`normalize()` in `fms.ts` is the only function that touches the raw FMS shape.
It is undocumented and has changed before, so it is tolerant and everything
downstream assumes a clean `Arrival[]`. When the feed shifts, exactly one
function needs editing, and `arrivalsProblem()` makes sure the shift is
noticed (an alert) rather than read as an empty board.

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
