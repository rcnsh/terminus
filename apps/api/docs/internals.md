# terminus API: how it works

A Cloudflare Worker that answers one question about the NUS internal shuttle
bus: **when is my bus, and should I run.**

Good NUS bus trackers already exist, but answering a three-second question
with one takes six taps: open the app, find the stop, pick the correct side of
the road, read a table, work out which service goes where you are going.

```
GET /api/next  ->  { "label": "D2 · 4 min",
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
in [src/openapi.ts](../src/openapi.ts). worker.smoke.js fails if a route and
the spec drift apart; [test/openapi.test.js](../test/openapi.test.js) calls
every operation, its success and its error cases, and fails when a status
isn't listed in its `responses`, a body doesn't fit its schema or carries a
key the schema doesn't name, an example or a golden answer doesn't fit, a
route's `security` says something other than whether it answers 401, or a
schema goes unused. Its schema checker (`test/_schema.mjs`) knows only the
parts of JSON Schema the spec uses.

The website's own pages (the landing page, `/status/`, `/privacy/` and the
full policy at `/privacy/policy/`, `/pair/`, and the not-found page) wear
the web app's sky: `assets/sky.css` is app.css's palette on an element,
`assets/sky-phase.js` puts the hour on `<html data-sky>` before the page is
drawn, and `assets/sky-page.js` draws the horizon and the night with the
app's own `sky.js` (web-sky.test.js keeps the colours and the hours the
same). An address the website doesn't have, asked for by a browser, gets
`/not-found/` with a 404 (`sitePage` in index.ts); anything else gets the
plain 404. `/docs` takes its bar's band from pagesky.ts, at Singapore's
hour, like the Worker's small pages.

The landing page is sent with the current release's version (from
`latest.json`, read from R2 on every request, so a release shows at once) and, for someone with a live
session, Account in place of Sign in, both written in by `src/landing.ts`
so nothing changes once the page is up. It's `private, no-cache`, with a
weak ETag of its own made from the file's ETag, the version, signed in or
not and the beta (`landingEtag`), so a browser gets a 304 only while its
copy is what it would be sent, never the file's own 304. The version carries its
English in `data-t`, which `i18n.js` words in Chinese.

---

## Quick start

```bash
pnpm install
pnpm test         # zero credentials, zero network
pnpm check        # the tests, then tsc --noEmit
cd apps/api
pnpm typecheck    # tsc --noEmit alone; only in apps/api
pnpm dev          # cf dev, needs .dev.vars for live data; only in apps/api
```

## Configuration

Copy `.dev.vars.example` to `.dev.vars` and fill in the values. They are not
included in this repository, and this repository doesn't explain how to obtain
them. **Never commit them.** `.dev.vars` is gitignored.

Auth is a **public / guest access-token flow**, the same one that lets uNivUS
show Bus Arrival without signing in. No NUSNET credentials are involved
anywhere, and nothing here should ever hold a personal NUS session or another
student's credentials.

| Variable | Purpose |
| --- | --- |
| `LTA_ACCOUNT_KEY` | LTA DataMall account key, for the public buses (free, from datamall.lta.gov.sg). Unset: accounts can turn public buses on and get the shuttle alone |
| `NEXTBUS_AUTH_BASE` | uNivUS auth host for the public token |
| `NEXTBUS_PROXY_BASE` | The uNivUS bus proxy, `https://inetapps.nus.edu.sg/univus/api/bus-proxy` |
| `NEXTBUS_PROXY_API_KEY` | Sent as `x-api-key` to the proxy |
| `NEXTBUS_APP_VERSION` | Current uNivUS release, e.g. `univus_android_2.59.2_140`. **Must track the Play Store**; KV `config:appVersion` overrides it (see below) |
| `NEXTBUS_HTD_API` / `NEXTBUS_APP_API` | The two auth headers for the token mint |
| `NEXTBUS_DEVICE_ID` | Optional; any 16 hex characters. Unset: one is made and kept in KV (`auth:deviceid`), so NUS sees one install |
| `NEXTBUS_REQUESTED_BY` / `NEXTBUS_SECURED_REQUEST` | Optional; the server does not require them |

The `NEXTBUS_*` names match `hewliyang/nus-nextbus-web`'s `.env.example`.

Deploy. The Worker's config is [cloudflare.config.ts](../cloudflare.config.ts)
(the website directory is in [wrangler.config.ts](../wrangler.config.ts), which
`cf` builds with). It names a D1 database, a KV namespace and an R2 bucket
(`terminus-downloads`) for each site, so a new account creates those first
and puts their ids there. The recipe below covers the KV namespace and the
feed's secrets only:

```bash
pnpm exec cf kv namespaces create --title terminus   # put the id in cloudflare.config.ts
for k in NEXTBUS_AUTH_BASE NEXTBUS_APP_VERSION NEXTBUS_HTD_API NEXTBUS_APP_API NEXTBUS_PROXY_BASE NEXTBUS_PROXY_API_KEY; do
  pnpm exec cf workers secrets update "$k" --worker terminus --type secret_text --text "$(grep "^$k=" .dev.vars | cut -d= -f2-)"
done
pnpm run deploy
```

The other secrets are set the same way. Declared with `bindings.secret()` in
cloudflare.config.ts, besides the six above: `ALERT_EMAIL` (where outage
alerts and feedback go), `HEALTH_TOKEN` (the operator's `x-health-token`),
`TURNSTILE_SECRET` (Turnstile on sign-in; unset, the check is skipped; a
pass counts only for the `signin` action on the Worker's own
`TURNSTILE_HOSTNAMES`),
`FCM_SERVICE_ACCOUNT` (push to Android) and `VAPID_PRIVATE_KEY` (Web Push).
Not declared, so a site deploys without them: `LTA_ACCOUNT_KEY` (public
buses), `ANALYTICS_TOKEN` (the dashboard's Analytics Engine charts, with
`CF_ACCOUNT_ID`, which is in the config) and `TIMELAPSE_TOKEN` (opens
`/api/timelapse/*` only). Everything in [src/types.ts](../src/types.ts)'s `Env`
but KV is optional at run time: `/api/health` says what's missing.

## Endpoints

Every API route is under `/api` (since 3.0). What stays at the root is
for people or for what can't change: the pages (the site, `/docs`, the
pairing page `GET /pair`, and the two an email links to, `/auth/verify`
and `/auth/approve`, so a link already sent keeps working), the downloads
(the Mac's Sparkle feed is built into every copy) and the map's files.

The old root paths (before 3.0) aren't served. `movedApi` in
[src/site.ts](../src/site.ts) answers them: a request with
`x-terminus-client` is an app from before 3.0, so it gets the 426
`config:minClient` gives (the app shows "update" rather than an error);
anything else (a script with an API key, a page open since before) gets a
308 to the same path under `/api`, which keeps the method and body. Once no
2.x app is left, these can go.

| Route | |
| --- | --- |
| `GET /docs` | API documentation (Stoplight Elements), with a live "Send API Request" panel. |
| `GET /api/openapi.json` | The OpenAPI 3.1 description the docs render. Source: [src/openapi.ts](../src/openapi.ts). |
| `GET /api/next` | The answer. `?to=` names a stop or venue code; `?lat&lon` alone gives the next buses at your nearest stop. With neither it returns a "Set up" answer rather than inventing a destination. |
| `GET /api/trip?to=<stop\|venue>&lat&lon` | The answer for a stop or venue code. Without coordinates, `&from=<stop>` sets the origin. |
| `GET /api/arrivals?stop=<code>` | One stop's board, through the same per-stop cache, with the stop across the road (`stop.opposite`, as `/api/me/nearby` gives it). See "Board rows" below. |
| `GET /api/buses?svc=<service>` | One service's live buses for the map: the stop each is at (within 40 m along its route) or the two it's between, where to draw it (the stop's dot, or a point on the route line between the stops), the road's heading there, crowding and the next stop; between stops, the stretch of route it's on. A bus away from its route is left out. One upstream call per service per 5 s; each bus with its number plate. |
| `GET /api/line?svc=<service>[&stop=<code>]` | One service's whole line, for the Buses tab's service page: its stops in route order (a loop's first stop not listed again at the end), each with the other shuttle services there; its buses from `/api/buses`, each by index into that list (`at` a stop, or `after` the stop it passed); with `stop`, that stop's index and the service's board row there (a stopped row too); whether the service is running now, and if not why and when it's back (`running`, `stopped`, `resumesAt`). One `/api/buses` read, plus one `/api/arrivals` read with `stop`, both through their caches. No times are worked out for the other stops. 400 for an unknown service or a stop it doesn't call at. |
| `GET /api/campus` | Stops (with the services that call there), each route's path along the roads, the services' colours, destination search data, and the residences for "Where do you live?" (PGP and UTown Residence, where most students live, first and marked `common`; the pickers show them in their own group), each with its walk to its nearest stop in metres (`walkM`) and in whole minutes at the normal pace (`walkMin`, never under 1). Written once per isolate, with an ETag: a client revalidating gets a 304. |
| `GET /map/campus.pmtiles` | The campus street map from R2, by byte range (PMTiles). Open, like the website. Each piece is kept in the edge cache under the file's ETag and its byte range, so R2 is read once per piece per data centre; the ETag itself is looked up at most every 5 minutes per data centre, so a new upload is seen within 5 minutes. Fonts and icons never change at their path (new icons get a new folder, like `v4`), so they're kept by path alone, with no look at R2. When R2 fails, cached pieces are still served (the last ETag R2 gave stays in the edge cache, and R2 is asked again every 30 s) and the rest are 503 with `Retry-After: 60`; 416 is only for a range past the file's end. |
| `GET /map/style.json?theme=&lang=` | The map's MapLibre style, light or dark, English or Chinese: Protomaps' map without its points of interest, every URL on this domain. |
| `GET /map/fonts/…`, `/map/sprites/…` | The map's label glyphs and icons, from R2. |
| `GET /download/android`, `/download/mac` | The current app downloads from R2, as `latest.json` there names them. `?abi=` picks an Android APK by CPU type; `/download/appcast.xml` is the Mac app's Sparkle feed, `/download/latest.json` the version list, `/download/releases/<version>/<file>` a versioned file. `latest.json` and the appcast are read from R2 on every request, so a release is live the moment it's uploaded. |
| `GET /api/stops/pairs` | Each stop with its twin across the road, and where the buses on each side go next. Cached hard. |
| `GET /api/health` | Graph age, how long the calendar lasts, the feed as the cron last saw it (`upstream`) and which config is present, never values (`config.pushAndroid` and `config.pushWeb`: push set up with a usable key). 503, with the same body, when the feed is confirmed down, the cron has stopped or the calendar has run out. With the operator's `x-health-token`, `?probe=1` mints a real token and says what came back, and `?versions=1` says what the version updater would find today in the app stores (see "The version string is a kill switch"); without it both are ignored. |
| `GET /api/status.json` | Whether NUS's feed is up, as the 15-minute check saw it, and the last 20 outages, read from KV at most once a minute per isolate. Two failed checks in a row confirm an outage and two good ones end it, so a feed that answers every other time sends no emails by turns; the outage ends at the first of the two. `feed` (like `/api/health` and the card's notice) follows the last check, though: one good check and it says `up` again, rather than "down" for 15 minutes with the feed back. The [status page](../../web/public/status) shows it. |
| `GET /api/admin/stats` | The operator dashboard's data (accounts, devices by app, sign-ups, reports, feed; answers and errors per day, and the timelapse recorder's polls by what they cost NUS, from Analytics Engine when `ANALYTICS_TOKEN` and `CF_ACCOUNT_ID` are set). Needs `x-health-token`; anything else gets a 404. |
| `GET /api/timelapse/days` | The days the timelapse recorder has kept (closed ones from R2; today's while it records, and any of the past week's still held by a recorder that hasn't written it to R2 yet) and what it's doing today. Needs `x-health-token`: the operator's, or `TIMELAPSE_TOKEN`, which opens `/api/timelapse/*` and nothing else. |
| `GET /api/timelapse/days/<date>` | One recorded day as gzipped JSON (see "The timelapse recorder"). A closed day never changes and is cached for a year; today's is built from what the recorder holds so far, `no-store` (503 if its recorder doesn't answer within 10 s). Needs `x-health-token` (operator or timelapse token). |
| `GET /account` | The account page ([apps/web](../../web)), served as static assets. |
| `POST /api/auth/login`, `/api/auth/code`, `/api/pair`, `/api/me/*` | Accounts. See below. `POST /api/me/feedback` is "Is this wrong?": the answer the user saw and what was wrong (a `reason` from the sheet's chips, `REASONS` in `src/feedback.ts`, a note, or both), kept with the account for a year (`FEEDBACK_KEEP_DAYS`, the cron) and its note emailed to `ALERT_EMAIL`, without the address or the answer (they'd outlive the account in an inbox; the dashboard has both). It needs a reason or a note (feedback, `kind: other`, always a note), and an account with an email: an anonymous one gets 403. |

`/api/next`, `/api/trip`, `/api/arrivals`, `/api/buses`, `/api/line`, `/api/campus` and `/api/stops/pairs` need an API key
(made on the account page, sent as `x-api-key`, or as a bearer token) or a signed-in
session or device; without one they answer 401 with `WWW-Authenticate`. A key opens
these routes only: on `/api/me/*` it is not a session, and gets 401. They're
limited by who's asking: a signed-in account by account (`RL_ME`, `acct:`),
an API key by key (`RL_PUBLIC`, `key:`), and a request with neither by IP.
On campus Wi-Fi hundreds of students share one IP, and the map alone asks
for buses every 5 s. For `/api/buses` only, each isolate remembers who it let
in for 30 s (`recentCallerFor` in `src/access.ts`), so a poll doesn't
look the session up in D1 again: a session signed out or a key revoked can
still see the buses that long, and nothing else. `/api/health`, `/api/status.json`, `/api/admin/stats`,
`/api/timelapse/*` and `/download/*` stay limited by IP. `/map/*` is limited by IP only where it
reads R2 (`RL_MAP`, 300 a minute; past it, 429 with `Retry-After: 60`): a
piece already in the edge cache is never refused, since the file's last
known ETag stands in when its look at R2 would be over the limit, so a
lecture hall can open the map at once.

When D1 can't be reached, checking the key or session behind a keyed
route is tried once more, then answered 503 with `Retry-After: 30`
(`callerOrDown` in access.ts); a D1 outage anywhere else under `/api/me` is a
503 too (`d1Unavailable`), so the apps try again rather than report a
fault. A fault in the query itself (a missing column, a bad binding, too
many variables) stays a 500, so a bug doesn't read as "try again".

Every 429 carries `Retry-After`, and every client waits it out, at most 5
minutes, sending nothing meanwhile (web `send()` in `account/dom.js`,
Android `Quiet`, Mac `Quiet`). A refused request still costs a Worker
request, so a client stuck in a loop must stop sending requests.

What the bill depends on, and the guards against it:

- Worker requests are what grows with use. Static files skip the Worker:
  everything under `/assets/` and `/vendor/`, and every script and style
  sheet (`*.js`, `*.css`), the favicons and the manifest anywhere else
  (`runWorkerFirst` in `cloudflare.config.ts`). Their headers are in
  `apps/web/public/_headers`, checked against `withSecurityHeaders` by a
  test, which also checks that no page or route of the Worker matches.
  So a page costs one Worker request, not one per module. `/vendor/`
  folders carry their version and are kept by browsers for a year
  (`immutable`); the fonts for a week; everything else is revalidated.
- `limits.cpuMs` (5 s) stops a request that loops from running on.
- The map's pieces come from the edge cache, so R2 is read once per piece
  per data centre.

### Board rows

`/api/arrivals`, `/api/me/nearby` and `/api/line` (`stop.row`) share one row per service
(`boardAt` in `src/resolve.ts`): the next bus (`etaS`, `quality`), the ones
after it the feed knows (`later`), and

- `color`: the service's colour from `ROUTE_COLORS`, null for a public bus;
- `towards`: where it goes from this stop, by full name (`longName`, such as
  "Central Library" for CLB): the next stop, then the stop the route ends
  at. On a loop the stop after the last is the first, and the end is where
  it started (D1 at BIZ2 is just "COM 3"). One name when the two are the
  same; none at the end of a line that doesn't loop (K at PGP Foyer);
- `crowd`: how full the bus in `etaS` is, from the feed, null without one;
- `endsAt`: when the service stops running today (`serviceEndsAt`), null
  when its hours are unknown or it isn't running;
- `running`: true on every row, unless asked for the stopped ones (below).

Times count from the request, as `scoreOptions` does: a cached or stale
answer's times are less its age, and a bus whose time passed more than a
minute ago (`BOARD_GONE_S`; the feed's times are whole minutes) is left
out. A live time from a stale feed is `stale`. The response's `asOf` is the
oldest fetch the board used (`boardAsOf`), so the apps' "Updated N ago" is
as old as the times are.

A service outside its hours (`inService`) with no time from the feed is
left off the board. With `?stopped=1` (`/api/arrivals`, `/api/me/nearby`; `/api/line`
always asks this way) it's listed after every running row, by name, with
`running: false`, no time (`quality: ended`), and

- `stopped`: why (`stoppedReason`): `ended` (it ran today and has
  finished), `notYet` (it starts later today) or `noService` (it doesn't run
  today: Sunday hours on a public holiday, as `inService` has it);
- `resumesAt`: its next opening (`serviceResumesAt`), looking up to 8 days
  ahead, null when none is found.

A service the feed still gives a time for stays a running row, whatever its
hours say: the feed is what's on the road. Unknown hours count as running.
The exception is a time at or after the service next opens
(`beforeOpening`): overnight NUS's feed lists times hours ahead that don't
match the published start (an A2 at 09:16 when its hours start at 07:15),
so such a time is dropped, and the row says when the hours open, as for a
service with no time. Within `FIRST_BUS_LEAD_S` (30 min) of now it is kept
as `scheduled` ("~15 min"), the first buses getting ready. A time before
the opening is a bus still out from the night before, and stays live. The
Now card and leave times read the feed through the same function.
The Now tab, the map and the widgets don't ask, so their boards are as
before. `/api/line` also says it for the service itself: `running`, `stopped`
and `resumesAt` at the top (null while it runs).

Only the feed's own times are given: a later bus the feed doesn't report
has no row of its own and no guessed time.

Each row also comes worded, in the request's language, so the Buses tab,
Nearby and the map say the same thing (they used to word these
themselves, and drifted):

- `eta`: `etaS` in words with `mins()` ("4 min", "now"), a `scheduled` or
  `stale` time marked "~6 min" ("约 6 分钟"); null when `etaS` is. Each `later` entry has
  its own `eta` the same way;
- `laterText`: up to three later buses in whole minutes, each `scheduled` or
  `stale` one marked, "then 12, ~20 min" ("之后 12、约 20 分钟"); null with none;
- `toText`: `towards` as "to A, B" ("经 A，开往 B"), "to A" ("开往 A"), or
  "Ends here" ("本站为终点站").

## Personalisation

Per-user trips come from the account (`/api/me/next`): a NUSMods timetable
imported with `POST /api/me/import`, plus classes entered by hand. Imported classes only
count in the weeks they run ([src/calendar.ts](../src/calendar.ts), built from
NUSMods' semester dates and MOM's public holidays by
`scripts/fetch_calendar.py`). NUS's own days off, such as Well-Being Days,
aren't in either source: they're kept by hand in `data/nus-days.json` (add
one when NUS announces it, then deploy) and count as public holidays, so
classes don't run and the shuttles keep Sunday/PH hours. Neither the scrape
nor the cron's merge touches that file. [`src/config.ts`](../src/config.ts) holds the cache
TTLs and tuning constants.

The profile is one JSON document per account, with a version (`updated`,
which every save moves forward). `POST /api/me/once` and `POST /api/me/import`
change part of it: they save only if the version is still the one they read,
and otherwise read it again and redo the change (three tries, then 409), so
a one-off trip added on one phone isn't lost to a save from another.
`PUT /api/me/profile` replaces the whole document; the version is its `ETag`
(`GET /api/me/profile` sends it, `"0"` before the first save). A client that
sends it back as `If-Match` is refused with 412 if another device saved
since; without it, as the apps installed today send, the last save wins.

The calendar keeps itself up to date without a deploy
([src/calendarsync.ts](../src/calendarsync.ts)). `data/calendar.json` is
bundled at deploy time, and the scrape workflow refreshes it weekly, but a
bundled file only changes when someone deploys. So the cron also fetches the
same two sources once a week. The copy must pass checks:
- dates are real (2026-02-30 is refused), and every semester starts on a
  Monday inside its own academic year (two years in a row, 1 July of its
  first year to 31 July of its second);
- there are terms 1 to 4 and at least 4 semesters and 5 holidays;
- holiday names are plain letters, digits, spaces and ordinary punctuation,
  under 80 characters.

It is also compared with what's answered now (KV merged with the bundled
copy): a known semester moved by more than 3 days, or more than 3 future
holidays dropped at once, is refused and the old calendar kept. To accept a
real move, deploy a corrected `calendar.json`; being newer, it wins.

A copy that passes is merged over what's known and kept in KV
(`calendar:data`). Merging adds, except that a future holiday the newer copy
covers and no longer lists is removed, so one added upstream by mistake
doesn't stay. After a failure the cron tries again the next day, and the
error is in the Worker's logs as `cron calendar`.

Every request, and the Trip object, reads that copy at most every 10 minutes
per instance and merges it with the bundled one; the newer wins where they
differ. A year a source drops is kept from the copy before, and a broken reply is
not merged.

`/api/health` says which is in use (`calendar.source`: `bundled` or `fetched`)
and how far it goes. The "calendar runs out soon" email only comes when even
the fetched copy is within 45 days of its end, that is when NUSMods doesn't
list the next academic year yet. The end is three weeks past the last
semester's exams, but never into the week the next academic year's first
semester would start (52 weeks after the last one), which Special Term II
ends a week before. Past the end, imported classes count every week, as
before, except a timetable for a semester the data says has ended; a lesson
with its own dates keeps to them. A sem-1 link pasted then is read as the new
year's, with the old one to fall back on (`termsForImport`).

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

- **`POST /api/auth/anon`** on first launch: an account with no email
  (`users.email` is NULL), so the app is useful before any sign-in. Limited
  per IP (`RL_AUTH`) and globally (`RL_ANON`); the cron deletes anonymous
  accounts unused for 60 days (`users.last_seen`). That sweep, with expired
  sessions, idle devices, old trip outcomes, crowd sightings and feedback
  older than `FEEDBACK_KEEP_DAYS` (365), runs once a
  Singapore day (KV `housekeeping:day`), since each reads a whole table;
  expired sign-in links and codes go every run.
- **Sign-in approved from the email** ([src/applogin.ts](../src/applogin.ts),
  modelled on RFC 8628). `POST /api/auth/app/start {email, name}` returns
  `{request, poll, match, expires}` and emails a 6-character code (in the subject
  too: filters hold back link-only mail) and a link. Typed into the app,
  `POST /api/auth/app/code {request, poll, code}` answers with the token; five
  wrong codes kill the request. Reading mail on another device, the link's
  page (`GET /auth/approve?r=`) offers three numbers; picking the one the
  app shows (`match`) approves, a wrong one or "This wasn't me" kills it.
  That page, like the Worker's other small pages (`page()` in me.ts), has
  a band of the hour's sky across its card, as Settings' pages do in the
  apps: no script, so the hour is the server's, in Singapore
  ([src/pagesky.ts](../src/pagesky.ts); pagesky.test.js keeps its hours
  and colours the web app's). The Android app takes the code in six boxes,
  one field underneath: a paste spreads over them, keeping only the code
  from around it (`codeEdit`, SignInCode.kt).
  The app polls `POST /api/auth/app/poll {request, poll}` every 3 s and gets
  `{status: 'approved', token, email, outcome}` once. The poll secret, the link
  and the code are all different, so the app that starts a request can't confirm it. Sent
  with the anonymous token, the device's account is kept (`added-email`) or
  folded into the email's account: dropped if it had no setup (`signed-in`),
  moved if the account had none (`moved-setup`), otherwise the app asks and
  calls `POST /api/auth/app/merge {anon, keep: 'account'|'device'}` (`choose`).
  Works on every client, including the Mac, which can't take universal
  links without a paid Apple team.
- **A pairing code** from `/api/me/pair-code`, made on the account page or in a
  signed-in app, redeemed with `POST /api/pair`. A guess is tried against every
  live code at once, so besides the per-IP limit (`RL_AUTH`, shared by
  `/api/pair` and `/api/pair/check`) there's one ceiling for everyone (`RL_PAIR`,
  60 a minute): an attacker with an IPv6 range can't spread guesses over
  thousands of addresses.

A device added with a pairing code emails the account's owner: it's the one
way in that doesn't go through the inbox, and it's what lets a signed-in app
make codes (`/api/me/pair-code`). Signing in from the email sends nothing more
(the owner has just used the inbox), and neither does removing a device
(`DELETE /api/me/devices/<id>`), which exposes nothing. API keys and signing out everywhere
stay on the account page; so does deleting an account, except an anonymous
one, which has no page and is deleted from its app.

Apps send `x-terminus-client: <platform>[-<flavour>]/<version>` (for example
`android/1.4.0`), stored per session for the dashboard. Without it the
platform is guessed from the User-Agent, which counts any CFNetwork client as
the Mac.

**Oldest app still served.** KV `config:minClient` holds the oldest version
served per platform, as JSON: `{"android":"2.6.0","mac":"2.6.0"}`. A missing
key, a missing platform or JSON that won't parse means no minimum. Each
isolate reads it once a minute (`TTL.versionMemoMs`, as `config:appVersion`),
so a change is live everywhere within that, with no deploy. On the routes an
app reaches with its token (the bus answers, and `/api/me/*` once signed in), a
request whose `x-terminus-client` names that platform with an older version
gets HTTP 426 and `{"error": "Update terminus to keep using it.", "update":
true}` (the error in Chinese for `zh`). Versions compare by number, and a
pre-release comes before its release: `2.6.0-beta.3` is older than `2.6.0`.
A request without the header (the website, API keys), or with a version that
can't be read, is never refused. Sign-in, pairing and signing out answer
before the check, and an outdated app may still `DELETE /api/me/push` and
`DELETE /api/me`, so it can stop its pushes or delete its account. The apps
take a 426 as "update required": they stop polling, back off for hours,
and offer the update (Play or the website on Android, Sparkle on the Mac).

```bash
pnpm exec cf kv keys put config:minClient --namespace-id <KV id in cloudflare.config.ts> --body '{"android":"2.6.0","mac":"2.6.0"}'
```

- `GET /api/me/next` is the widget's one call. It picks the destination from the
  timetable (see `planFor` in [src/profile.ts](../src/profile.ts)) or from
  `?place=`/`?to=`, and returns the usual answer plus `dest` and `places`.
  A `place` or `to` that names nothing it knows is ignored: the answer is
  the timetable's.
- `GET /api/me/nearby` lists departures at up to three stops near you, plus the
  nearest one's twin across the road when it isn't among them (so up to
  four), each with
  its service's colour (`color`, as on the buses and the map). Each row
  (as on `/stops/{code}`) has the next bus in `etaS` and the ones after it
  the feed knows in `later`, each with its own quality; Nearby draws them
  all on the road, the next one solid and the rest faded.
- The profile's `pinnedStops` are the stops pinned to the Buses tab, in the
  user's order: up to 8, each a shuttle stop or a public stop of its own
  (LTA's code), repeats dropped. A pinned stop gone from a new scrape is
  dropped on read, with the other pins kept.
- The profile comes with `limits` wherever it's sent (GET and PUT
  `/api/me/profile`, the import, the merge): the most pinned stops (8), places
  (12) and home stops (3), the longest class and favourite names (60, 24),
  the home walk's range (0 to 30 minutes) and the list sizes, all from
  `PROFILE_LIMITS`, the numbers `parseProfile` enforces. The apps size their
  fields and pickers from it instead of keeping copies; sent back with the
  profile, it's ignored.
- On a day with no classes (or none left), `/api/me/next` says so (`mode: free`)
  with the next class, and no bus: a bus you have no reason to take reads
  like advice. Departures near you are `/api/me/nearby`.

### The trip engine

`/api/me/next` also says where today's trip is, the same on every device:
`card.phase` is `idle`, `due` (5 min before the leave-by), `heading`,
`waiting` (at the boarding stop), `riding`, `missed` or `arrived`. The
phase comes from the answer and the day's signals: `POST /api/me/signal` with
`boarded`, `missed`, `skipped`, `left`, `arrived`, `location`, `reset`,
`away` or `back`, for the trip in progress or the `trip` key a card action or `/api/me/day`
names. Clients show `card.actions` as buttons and never decide them.

The signals live in a Durable Object per user (`Trip` in
[src/trip.ts](../src/trip.ts), bound as `TRIPS`, keyed by user id, created
in Asia with `locationHint: 'apac'`). It's
only touched on a day with classes and keeps only that day: its signals
(`DayRecord.trips`), the bus each trip's plan is for (`plans`), the wake
pending for push (`watch`), and push's own bookkeeping (who to push to,
the wake owed, what was last pushed). A location is never kept: it's
reduced to what it means, arrived. An alarm deletes everything at the
next Singapore midnight. A request reads
the day once and sends everything it changes in one `POST /update`
(`updateTrip`): a signal, or a reached trip, a plan and
a watch. The object writes only what changed and sets its alarm only when
the time moves. Deleting an account empties it at once (`clearTrip`, tried
twice), and so does signing an anonymous account into another one, or the
cron deleting an idle one. An emptied object keeps only a `gone` mark until
midnight and refuses every write, so a `/api/me/next` already under way when
the account went can't store its trip again.

A trip that changes buses goes `riding` (the first bus, its ride ending at
the change), `waiting` (at the change stop, `phaseText` "Change buses",
the second bus as the leave-by to catch), then `riding` again on the
second, with no phase of its own, so an app that knows nothing of changes
still shows each part right. The plan and the `boarded` record are the
first bus with the second in `change` (`Boarded.change`); `rideStage()`
says which part you're on, from the clock, and from the feed while it still
has the first bus on its way to the change. Off the first bus, the second
bus's time is read from the feed at the change stop, and that time decides
when it has left: a bus still due there keeps you at the change. The same
bus only (within `SAME_BUS_MS`), so a later one never keeps the trip
waiting; but a guessed time (`estimated`) stands for the first bus within a
headway of it, and with nothing in the feed it's taken to have left only a
headway after the guess (`secondLeavesMs`). Boarding a later first bus that
gets to the change after the planned second bus makes the second a guess
from when you get there (`laterChange`). Still at the
change stop `ASSUME_MS` after the second bus left: missed, and the answer
is the next way there from where you are. `nextPhaseAt` wakes the Trip
object at the change and once the second bus has gone.

### One plan, and push

- **One plan, everywhere** ([src/plan.ts](../src/plan.ts)). The Worker saves the bus a trip is for in the
  day's record (`DayRecord.plans`): from the moment the trip is due, or
  earlier when it was planned from the phone's location (`Boarded.located`).
  Every device then says that bus (the card, the notifications, Today in
  `/api/me/day`). A device without a location
  (the widget, the background refresh, the Mac, the web) shows the phone's
  plan rather than one of its own from where the timetable puts you; a
  located answer replaces it. The same service from the same stop within
  three minutes is the same bus (live times move a little each answer), so
  it isn't saved again, unless its time was an estimate and is now live.
  For a class whose plan was made from the phone's location, from 15
  minutes before its leave-by (at the stop, and the heads-up), the bus you
  were told stays the plan while it still gets you there on time, even if a
  fresh answer would prefer another; only one that would now make you late
  gives way. The plan freezes at its leave-by, or when its bus
  leaves if that comes first: after that the answer would name later buses
  (and, from a moving bus, other stops), but the trip, the card and the ride
  stay about this one, until a miss, when the card shows the next way there.
- **"At the stop"** means at the plan's boarding stop from 15 minutes before
  its leave-by (`WAIT_EARLY_MS`): not hours before at a stop you live by, and
  not at a stop you're riding past. The headline is then the bus ("D2 at
  9:41"), never "Leave by" or "Leave now".
- **The next trip isn't planned from a missed class.** One whose last record is `missed`
  isn't where the next trip is planned from (`DayState.missed`), on the card
  or in Today: without a location, from the class before or from home.
- **The card asks no questions.** It has none in it (the apps can still
  send `boarded`, `missed` and `arrived` signals). Three minutes
  after the departure, only a location says what happened:
  - at the boarding stop: `missed`, and the next way there;
  - on the bus (`seenOnBus` in trip.ts): within 60 m of its road between
    the boarding and alighting stops, and further from the boarding stop
    than a brisk walk (1.5 × `WALK.speedMs`) since it left plus a rough
    fix's error (`MAX_FIX_ACC_M`), along the road and in a straight line.
    Where the line passes the fix more than once (a road used both ways),
    none of those places may be within that walk. The phase is `riding`
    (`TripView.assumed`), and the plan is saved with `seen`, so devices
    without a location (the widget, the Mac, push) follow;
  - anything else, including no location or a rough one: unknown. The
    answer is the next way there, the phase `heading` (never `due`: you
    may be on board), and the card's line says only that the plan's bus
    has left ("The 09:06 has left · next D2 09:16"; `TripView.gone`).
    That is true whether you caught it or not, so nothing is asked. The
    card says so in `card.gone`, and its `phaseText` is "If you missed
    it, here's the next way there.", so the headline's "Leave in 2 min"
    for the next bus reads right on every client. Notifications never say
    "Leave now" then: Android's leave notification and live update and
    the web's push are titled with the line, quietly, and the Mac clears
    its "Leave now". The Trip object pushes (quietly) when `gone` changes,
    though the phase stays `heading`, so the phones update.

  A short ride may never be seen: by the time the bus is beyond a walk,
  you're nearly there, and the destination ends the trip. A location in
  your residence ends a trip home, and at the destination ends the trip
  (`reached`, recorded as `arrived` for every device). Nothing is recorded
  as an outcome for a seen ride. The `location` signal older Android apps
  still send is answered like `/api/me/next` from there and records nothing.
- **The ride from the feed.** Boarding records the plate of the bus due at
  the boarding stop within five minutes; while riding, the same plate in the
  alighting stop's arrivals gives the arrival (quality `live`). Without a
  plate, the arrival is an estimate, marked `~`. Once that arrival has
  passed with nothing saying you're there (you caught the bus after it, or
  it's late), the card never shows the past time: the next bus of the
  service due at your stop is the guess, marked `~`, or with nothing due
  only where to get off; ten minutes after the arrival (`RIDE_GRACE_MS`)
  you're taken to be there.
- **Outcomes** ([src/outcomes.ts](../src/outcomes.ts), `trip_outcomes`, 35
  days): what was said (boarded, missed, arrived, from older apps' taps or
  the phone reaching the destination) and "Not going",
  with the day it happened (`at` is that day's start, never the moment:
  migration 0012);
  three misses of one class in 30 days suggest a bus earlier (`ArriveBy.oneEarlier`);
  three skips in a row offer to stop reminders (`card.remind: false`). Choices
  are `trip_prefs`; a turned-down suggestion waits 30 days.
- **Push** ([src/push.ts](../src/push.ts), [src/tripdo.ts](../src/tripdo.ts)).
  When push is set up (`pushEnabled`: `FCM_SERVICE_ACCOUNT` or
  `VAPID_PRIVATE_KEY` usable), a card served on a class day asks the
  Trip object to wake at `nextPhaseAt` (due, leave-by, departure, +3 min,
  class start, ride end; not at `staleAt`). At each wake it works out the card
  again, nudges the user's devices (`sessions.push_token`) if the phase
  changed, and schedules the next wake; with no device taking
  push it stops. The day's `watch` is the wake pending, absent once it
  stops, and a card asks again only when none is pending or its own is
  sooner, by any amount (`needsWatch`), so a push is never late: the
  leave-by moves by seconds with each refresh, and a later one needs
  nothing, since the object plans its next wake afresh each time it wakes. A nudge is a data message, `{kind: 'card', phase}`, high
  priority for due and missed, reminders on or off (Android starts the live
  notification from them, which it may do from the background only for a
  high-priority message); the app fetches /api/me/next
  itself. A tap nudges the user's other devices at once. The object's single
  alarm is the sooner of the next wake and midnight (`deleteAt`).
  - A phase counts as pushed once a device got it (or none could be sent
    to); when every send failed, the next wake tries again. It's saved as
    soon as the send is done, so an alarm the platform runs again after a
    later failure doesn't push it twice. A wake that
    throws (D1, the feed) is tried again after 30 s, doubling up to 8 min.
    The wake owed is kept as `waking` until the wake is done, so an alarm
    the platform runs again still wakes.
  - The wake's last writes hold the object like a POST: a `/watch` for
    sooner, or a `/clear`, that came in meanwhile stands.
  - At the Worker's compatibility date `deleteAll()` leaves the alarm, so
    `/clear` and midnight delete it first.
  - Each call to Firebase has a 5 s limit, and each device is sent to on
    its own, so one that fails or hangs doesn't keep the push from the
    rest. A token is dropped only when FCM says it's unregistered (404,
    `UNREGISTERED`), names it as the bad value, or says the registration
    token isn't valid (FCM's usual words for one); any other 400 is logged
    with FCM's code and the token kept.
  - The Worker's calls to the Trip object time out after 3 s
    (`TRIP_TIMEOUT_MS`): the card is answered without its trip state, as
    when the object fails.
  - A push secret that's set but won't parse turns that push off; it's
    logged once per isolate, and `/api/health` says which push is usable
    (`config.pushAndroid`, `config.pushWeb`).

The planner ([src/profile.ts](../src/profile.ts), `planFor`):

- A class stays the target until 15 minutes after it starts (you may still
  be on the bus), unless you've reached it. A skipped class is left out.
- An hour after the last class, with no location, you're taken to be home.
- Outside your day, a location on campus but not at home gets the trip home.
- On the trip home, `card.warning` says "Last D2 from UTown in 18 min" from
  45 minutes before the service's published end (`data/service-hours.json`).

A location comes as `lat`/`lon`, with `acc`: how far out it may be, in
metres, its accuracy plus a walking pace times its age (the apps and the web
app work this out, `Locator.uncertaintyM`). Over 200 m (`MAX_FIX_ACC_M`) the
fix is dropped and the answer follows the timetable: a cell-tower fix, or a
precise one from ten minutes ago, planned the trip from the wrong side of
campus and said so with confidence. Every location is rounded to four
decimal places, about 11 metres, as it is read (`roundCoord` in http.ts,
used by `coordsFrom` and `fixOf`), whoever sends it: the apps round too,
but a script with an API key needn't.

`GET /api/me/day` is today's timeline, worked out with the same planner. A
class you're on the bus to carries `onBus` (the bus, where to get off, the
arrival) instead of a leave-by that has passed. Each row comes worded:
`title` (the class, or "Home, from UTown") and `line`, its second line
("Leave by ~09:38 · D2 from PGP", with "~5 min late" when it will be; "On
the D2 · off at UTown · arrive 09:52"; "Not going"), null once it's done or
with nothing to say yet (`dayLine` in `src/day.ts`). Apps send it the same
`lat`/`lon` as `/api/me/next`, and the next class is planned from there, so Today
and the card agree even on the first load, when both are asked at once and
the card's plan isn't saved yet. (Without it, Today planned from the home
stop and its walk from Settings, the card from where you were, and they
differed by a few minutes until the next refresh.) Later classes are planned
from the class or home before them.

Card v2 adds `phase`, `phaseText`, `glance` (12 characters, for a menu bar
or a tile), `line` (one line, for a notification), `actions`, `warning` and
`nextChangeAt` (when the card changes by itself). A leave-by counts there
no sooner than 30 s ahead (`LEAVE_GAP_MS`): a late bus keeps sliding it a
few seconds past now, and clients refetching at it would poll every few
seconds; they say "Leave now" themselves once `leave.at` passes. The glance
is never a minute count, which a menu bar left unrefreshed would freeze:
outside a trip it is the headline bus and its clock time ("D2 09:41", "~"
for an estimate or an old reading), the label's own words when there's no
time.

The card also has its headline and the line above it worded: `title`, the
departure as a clock time ("D2 · 09:42", "~09:42" for a timetable estimate),
which stays true until the bus leaves, or the label when there's no time
(`titleOf`); `heading`, from `dest.why` ("Next class · X", "Long gap ·
Home", "Heading home", "Going to X"), null with no destination; and
`remindAt`, when the apps post the leave reminder: `leave.at` less `DUE_MS`
(five minutes, when the trip turns `due`), only for a class with reminders
on, before the trip is under way and before the class starts, else null
(`remindAtOf`). The apps used to hard-code the five minutes and the
class-only rule. While riding, `ride` lists
the stops from boarding to getting off, with the board and arrival times (the
arrival live when the bus's plate is known), for a progress bar. v1
fields are unchanged. `notice` is a line above the answer while the monitor
has NUS's feed down ("NUS's live bus times have been down since 9:14 AM"),
on an answer that is an estimate or has no time (the feed may be back
before the next check, and a day with no bus needs no notice). Each isolate reads the monitor's state from KV at most once a
minute (`feedDownSince`).

`journey` is the trip as steps, for the card styles on Android and the
web (`account/journey.js`): the steps as a line down the card, as on a
route map (the default), a line across from you to the destination, or a
ticket, chosen in Settings › Appearance per phone or browser. It says when to leave, the walk to the stop, the
bus with its colour and time, the ride, where you get off and when you get
there, and a backup bus (the other bus on a trip; for a class, the sooner
bus to go now on). A class takes the leave-by's bus, any other trip the
headline bus, from the answer's `bus` and `altBus` legs and the leave-by's
`walkS` and `rideS`. On foot the whole way it's the walk alone, so the
styles draw a walk the same way: `bus`, `boardAt` and `ride` are null, `walk`
is the whole walk (from the answer's `foot`, or a class's leave-by to its
room) and `why` is the bus it beats ("D1 would be 16 min") or "Services
ended for the night". A kept plan with a bus still shows its bus. It's null
on the bus, once there and with no time to give; at the stop it has no walk. When where you're going is a walk
from its stop (a class's room, a room or building searched for by its code,
a food court), `walkEnd` is that walk and `arrive` is when you reach the place
itself, with `arriveStop` the bus's arrival at the stop; the detail line's
"LT3 in ~14 min" counts the walk too. Each bus leg carries the walk from the
stop it gets you off at (`endWalkS`), as a food court's stops are different
walks from it, and walking the whole way is weighed against the bus all the
way to the place ("Walk · 8 min"). The answer's own times (`arriveAt`, a
leg's `arrive`) stay at the stop. A class's leave-by already aims at the
room (`leave.arrive` is there): the answer's `endWalk` (kept off the
response) says which, so the walk is never added twice. Apps count down to `leave.at` and `journey.boardAt` themselves.

The journey's lines come worded too (`worded` in `src/card.ts`), so the three
web styles, the app's card and the widgets say the same: `title` ("To
GEA1000 @ UTown · starts 10:00"), `place` ("GEA1000"), `byText` ("by
~09:36", null at the stop), `walkText` ("5 min walk"), `rideText` ("10 min
ride · off at Opp NUSS"), `walkEndText` ("2 min walk"), `arriveText`
("Arrive ~09:51 · 9 min early"), `arriveWhere` ("2 min walk from UTown" or
"at UTown"), `backupText` ("Or go now: R2 at 09:06 from PGP" for a class,
"Or A1 at 09:09 from PGP" for a trip, `why` on foot) and `summary`, one line
for a compact widget, most needed first ("arrive ~09:51 · R2 ~09:42 at
PGP", "Walk to PGP · A1 09:09", "A1 09:09 at PGP", "8 min walk · D1 would
be 16 min"). Only the countdowns ("Leave in 4 min") are the apps' own.

`upcoming` is the next class on its own card, under Done for today, a day
with no classes, and You're home: when ("Tomorrow · Tue"), what ("CS2030
at 10:00"), where ("At COM1 · get off at COM 3"), and why today has none
when it's a break. It's the timetable alone, with no bus or leave-by:
tomorrow's buses aren't known, and a guess there would read as a plan.
`detail` still says the same in a line, for the widgets and the Mac. The
route moves it from the answer into the card (`profile.ts` `upcomingClass`).
- Tokens are stored as SHA-256 hashes. A web session lasts 30 days from its
  last use: `GET /api/me` pushes the expiry back 30 days, and sends the cookie
  again, once fewer than 23 days are left. However much it's used, a web
  session of an account with an email ends 180 days after sign-in (one with
  no email keeps it: it has no other way back in). Device tokens last until
  revoked, or 90 days unused.
- Sign-in emails: one a minute and ten an hour per inbox, web and app
  together, and 30 a minute for everyone (`RL_MAIL`). That ceiling is taken
  only when an email is about to go (`takeGlobalMail`), after the cooldown,
  so repeating one address can't use it up and block everyone's sign-in. The
  cooldown is checked again in the statement that stores the link or the
  request, so requests arriving together send one email. The emailed code's
  wrong guesses are counted on the link's row (`magic_links.code_tries`,
  migration 0009), five at most.
- `POST /auth/verify`, `/auth/approve`, `/api/auth/logout`, `/api/auth/code` and
  `/api/auth/anon/web`, and any other change sent with the session cookie and no
  bearer token, are refused when `Sec-Fetch-Site` says another site sent
  them. So no page elsewhere can sign a visitor in to an account it holds a
  link or code for, or out of theirs. Another subdomain of terminus.run (the beta)
  counts as the same site, so the Lax cookie goes with its POSTs; this check
  is what stops those. JSON bodies need exactly `application/json`: a type
  that only mentions it (`text/plain; x=application/json`) needs no preflight
  from another page.
- The link's page names the account by its whole address: a masked one
  (`f•••@u.nus.edu`) can't be told from a forwarded link to someone else's
  account at the same domain, which would sign the visitor in to it.
- A sign-in (link, code, pairing code or app request) is spent in the same
  D1 batch as the account changes and the new session, each statement
  guarded by "not spent yet" (`Live` in accounts.ts). A failure part way
  changes nothing, so the same link or code works again (the code's KV
  entry is dropped only once the batch has answered), and of two racing
  attempts only one gets a session. An app poll that fails this way answers
  `pending`, and the next poll finishes it.
- An email send that hasn't finished in 20 s (`MAIL_TIMEOUT_MS`) counts as
  failed, and its link or app request is deleted. The Email binding can't
  cancel the send, so one that finishes later still arrives, with a dead
  link and code; the limit is long so that stays rare.
- Signing out everywhere also deletes the account's pairing codes, unspent
  sign-in links and app sign-ins not yet collected, so nothing made just
  before it can still become a new session.
- The link in the email opens a page with a button, and only the button's
  POST uses up the link. Outlook's link scanner opens links before the user
  does, so a GET that spent the token would break NUS addresses.

Setup and deploys: `pnpm run deploy` (and `deploy:beta`) first runs
`scripts/predeploy.mjs`, which refuses a tree with unmerged files, conflict
markers or changes not committed in `apps/api` or `apps/web/public` (a deploy
ships the files on disk, not the commit), then runs `pnpm check`. Only then
does it apply the database's pending migrations, and deploy. The code reads columns from
recent migrations (`magic_links.code_tries` from 0009, `feedback.reply_to`
from 0010, `feedback.reason` from 0014), so a Worker deployed to a database without them answers 500.
By hand, the same first step is:

```bash
pnpm exec cf d1 migrations apply <database id from cloudflare.config.ts>
```

**Migrations must be additive (expand, then contract).** The migration runs
while the old Worker is still serving, and if the deploy after it fails, the
old Worker keeps serving on the new schema. So a migration may only add:
new tables, new indexes, new columns that are nullable or have a `DEFAULT`.
Renaming or dropping a table or column (0002 renamed one; 0006 rebuilt
`users` and the five tables that reference it), or adding `NOT NULL` without a default, breaks the running code. Do those in steps, one deploy each:

1. **Expand.** Add the new column or table; deploy code that writes both the
   old and the new and reads the new, falling back to the old.
2. **Backfill** the new from the old, in a later migration or a one-off
   statement.
3. **Contract.** Once no deployed code reads the old, a later migration drops
   it.

The beta takes each step first. Old migration files are never edited:
D1 records them by name and won't run one again. `test/deploy.test.js`
checks all of this: migrations are numbered 0001 up with no gap, an
`ALTER TABLE` neither drops nor renames nor adds a `NOT NULL` column without
a `DEFAULT` (a contract step says so with a `-- contract:` line; 0002 and 0006
predate the rule), and each migration listed in
`test/fixtures/migrations.sha256` still has its hash. Once a new migration has
been applied to both databases, append its line (from `apps/api/migrations`,
`shasum -a 256 <file> >> ../test/fixtures/migrations.sha256`). The same
test loads `cloudflare.config.ts` in both modes and checks the beta shares no
database, KV, bucket, rate-limit namespace, dataset, Worker or domain with
the stable site, and that the release and map scripts upload to each site's
bucket.

Each Worker answers on two addresses: terminus.run, which people see, and
terminus.rcn.sh, the one kept for good, which the apps call and the Mac's
updates come from (the beta's likewise). A page a browser opens on the old
address is sent to the same path on the new one (`movedPage` in
`src/site.ts`): a GET or HEAD asking for HTML, outside `/download/`,
`/.well-known/`, `/map/` and `/robots.txt`. Anything asking for JSON, the
apps included, is answered where it is. The 301 carries `max-age=86400`, so
search engines move the old address's pages over but a browser asks again
after a day, and moving back is an edit to `MOVED`, not something browsers
keep for good.

That redirect is off for now, as NUS Wi-Fi resets connections to
terminus.run (a domain that new trips its firewall): `movedPage` only runs
with `MOVE_PAGES` set to `on`. Links handed to people (sign-in and
new-device emails, the "create a key" error) come from `linkOrigin`:
`LINK_ORIGIN`, set to the old address, else the site's own. Once
terminus.run loads on campus Wi-Fi, `movingOff` in `cloudflare.config.ts`
goes and `MOVE_PAGES` is set.

Email goes out through Cloudflare Email Sending from `EMAIL_FROM`. That
needs the Workers Paid plan and the sender's domain onboarded under Email
Service > Email Sending in the dashboard: terminus.run is, and the old
address, login@terminus.rcn.sh, stays an allowed sender. Replies, and any
other mail to terminus.run, reach the operator through Email Routing's
catch-all (dashboard only, not in this repo). Sending uses its own
subdomain, cf-bounce.terminus.run, so the two don't share records. The
contact addresses people are given stay on rcn.sh (CLAUDE.md).

### The web app

`/app/` is terminus as an installable web app, meant for iPhones: the answer
card, chips for saved places and Nearby, and Today; the campus map; and
Settings. It uses the same routes as the account page, with the session cookie.

- **How the pages are built.** Preact components with htm templates
  (`assets/ui.js`, Preact vendored by `scripts/vendor-preact.sh`), loaded as
  written: no build step, so the service worker keeps exact files and the
  API's tests import the plain modules (`search.js`, `offline.js`). htm needs
  no `eval`, so the CSP stays `script-src 'self'`. State several parts share
  is a `store()`: the profile and `/api/campus` (`account/profile.js`), and in
  the app what the card is for, the card, Today and the push switch (top of
  `app/app.js`). The tabs are shown and hidden by the fade itself, not by
  Preact, so it can swap them between its halves; MapLibre is driven
  directly inside the Map tab's effects. With no bundler the browser finds
  a module's imports only once it has it, one round trip per level, so
  every page with modules (`/app/`, `/account/`, the landing page, status,
  privacy, not-found) lists every module it starts with as `modulepreload`
  links (kept right by `web-sw.test.js`). What isn't needed at first loads
  with `import()`: the map and Settings in the app, and Settings and setup
  on the account page once someone is signed in. Those `import()` every
  module they need at once, not just the top one, and touching or hovering
  the Map tab asks for `map.js` and MapLibre together (`app/map-files.js`,
  the one place MapLibre's and PMTiles' versions are written).

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
  900 px wide they sit side by side. On a phone, in the app (web and
  Android), the list's title and each page's sit in the same slim band of
  the hour's sky, ending on the low hills, so opening a page doesn't change
  the top; it turns with the phone's clock each minute, whatever tab is on
  screen. The installed app on an iPhone, which has
  no browser swipe, goes back on a swipe from the left edge. "Notify me when
  to leave" is under Notifications. Send feedback posts a note to `/api/me/feedback`
  as `kind: 'other'`; a wrong answer is better reported from under the card,
  which attaches it. The page is laid out as a message (From, the note, a
  counter and Send). Under it, "A better stop for a building" takes
  a building (or a room in it), the stop you use and why, as `kind: 'stop'`
  with `venue` and `stop`: kept as feedback with the reason `better-stop`
  and the suggestion as its `context`, and emailed with the entry for
  `data/src/venue-stops.json`, ready to check and paste. A building the
  table doesn't know, or the stop (or its twin) it has already, is refused. Feedback and wrong-answer reports both need a note and
  an account with an email, so the operator's inbox only gets reports that
  say something, from someone who can be answered; an anonymous account is
  asked to sign in instead. (`reply_to` on old feedback rows is from when an
  anonymous account could type an address; nothing writes it now. The data
  export and the dashboard still read it, so they rely on migration 0010.)
- **12- or 24-hour times.** The profile's `clock` (`auto`, `12`, `24`)
  is the account's choice, set in Language and time or in setup. The server
  words every card in it (`hour12()` in next.ts: the profile's choice, else
  the request's `?h12=1`) and says which on the card (`card.h12`). Each
  client keeps a copy (web `dom.js` `hour12()`, Android `Clock`, Mac
  `Clock`) so the times it writes itself, and the widgets, match; `auto`
  follows the device.
- **Now.** A search button at the end of the chips opens "Go somewhere
  else" (account/search-box.js, ranked by search.js, over `/api/campus`'s
  destinations); a pick shows its card under a chip of its own. "Is this
  wrong?" under the card opens a bottom sheet (account/preview.js
  `Report`, a modal `<dialog>`): the answer it's about, the reasons as
  chips, a note, and who the reply goes to. It sends to `/api/me/feedback`
  and then says so in the sheet, which is the only confirmation; Android's
  sheet is the same. Not for Nearby. A stop's name in Nearby opens it on the map
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
  Opening `/app/` with no session cookie is redirected there by the Worker
  (`signInFirst()`, on `Sec-Fetch-Dest: document`), so the app never flashes
  up before sign-in; the service worker's own fetch of `/app/` still gets
  the page. A session ended elsewhere still reaches the app, whose first 401
  sends it on (`signedOut()` in `dom.js`).
- **Offline.** `/sw.js` fetches the app's files network-first and keeps a
  copy for offline (`SHELL_FILES`; `web-sw.test.js` fails if a module the app
  imports at startup is missing from it). On a slow connection it uses the
  copy after 1 s, and the late reply replaces it for the next load; a reply
  with the kept copy's ETag isn't written again. Vendored files (their
  version in their folder) come from the copy first. `assets/zh.js` is kept
  only once a page asks for it (or the browser is set to Chinese), and the
  map's cache drops an old MapLibre or PMTiles once a new one is kept. `/api/me`, `/api/me/next` and `/api/me/day` are
  also network-first, and the last good reply is kept (one per route, place
  and `to`, so a searched stop's card never stands in for the plan's). When the network
  is down, the kept reply comes back with `x-terminus-cached` (when it was
  fetched), and the page dims the card and says so. Signing out, deleting the
  account or a 401 empties the kept replies.
- **Offline, all day.** Once the kept answer has gone stale (its bus has
  left, or 15 minutes have passed) and the network is still down, every app
  falls back to the day plan it kept from `/api/me/day`: the next class's
  leave-by and how ("Leave by ~13:38 · walk"), "Leave now" once that has
  passed, then the trip home. The rule is the same on all three
  (`app/offline.js`, `OfflineDay.kt`, `OfflineDay.swift`): skip what was done
  or taken off when the plan was fetched, a class 15 minutes after it starts,
  and a trip home at its end (or an hour after it starts); only a plan for
  today counts. All three are tested against `test/fixtures/offline-day.json`
  on the `/api/me/day` golden. The Android widget's background refresh fetches
  `/api/me/day` hourly to keep the plan current, and arms a redraw alarm (no
  network needed) for the moment the offline line next changes.
- **Push.** `POST /api/me/push` with `{subscription}` keeps the browser's Web Push
  subscription on the session as `web:` plus its JSON, next to where an
  Android session keeps its FCM token. So the Trip object's nudges reach both,
  through `push.ts` and `webpush.ts`. Each push is VAPID-signed with
  `VAPID_PRIVATE_KEY` (a P-256 JWK; `scripts/vapid-key.mjs` makes one) and
  its payload encrypted with aes128gcm, using WebCrypto only. Only
  subscriptions on browsers' push services are kept (FCM, Mozilla, Apple,
  Windows): the Worker POSTs to the endpoint, so any other host is refused.
- **Every day, whether or not the app is open.** A Trip object only watches
  once a request asks it to. The Android app asks from its background
  refresh, but a Home Screen web app makes no requests unless it's opened. So
  from 06:00 Singapore time the cron (`armTrips` in monitor.ts) asks the Trip
  object of every user with a push address to watch the day, 400 users a
  run, 20 at a time; each 15-minute run carries on after the last user the
  one before armed (`trips:armed` in KV holds the date and that user, then
  the date alone when the day is done). A Trip object that doesn't take the
  request goes on `trips:retry`, and later runs that day ask only those again. It works out the card, wakes at each
  change and pushes, and on a day without classes it stops. Saving a subscription also refreshes the card, so a Trip object that
  woke before the subscription existed is asked again.
- **What a push shows.** A web push must show a notification (iOS insists).
  So the web app isn't pushed an idle card, or a trip with reminders off. The
  service worker fetches `/api/me/next` and words the notification as the Android
  app does: the ride, or the next way there after a missed bus; otherwise
  when to leave. Nothing asks what happened. Its one button, before you've
  left, is the card's "Not going": the service worker posts
  `/api/me/signal` `{kind: 'skipped'}` itself, without opening the app (the
  Android notification has the same button). A tap elsewhere opens the app.
- **A new semester.** In the week before semester 1 or 2 starts
  (`semesterSoon` in calendar.ts), from 10:00 Singapore time, the cron
  (`remindTerm` in monitor.ts) pushes each device of a user whose imported
  timetable is an older semester's: `{kind: 'term', title, body, zhTitle,
  zhBody}`, worded by the server in both languages, since the device picks
  its own. Android from 2.5.0 (`fetchesNotice`, by the session's
  `x-terminus-client`) is sent only `{kind: 'term'}` and fetches the words
  from `GET /api/me/notice`, so they don't pass through Google; older versions
  can only show what they're sent. Web pushes are encrypted for the browser
  and keep the words. Anyone who has already imported the new semester, or has never
  imported one, is skipped. It goes once per semester, 400 users a run, with
  `term:reminded` in KV marking the semester and the last user reached, as
  `trips:armed` does. The mark is saved before the batch is sent, so a mark
  that can't be saved sends nothing rather than the batch every run. A user
  no device took (push itself failing, say) goes on `term:retry` and is
  tried again on the next runs, up to eight attempts in all
  (`REMIND_TRIES`), while the batches carry on, so one
  phone that can't be reached holds up no one. Each run stamps the mark
  with its time and the list it leaves with the same, so a list that
  couldn't be saved is set aside rather than sent to again. A retried
  user's profile is read afresh: imported since, they're skipped; with a
  new language, they're told in it. A tap opens the timetable settings on the web, and the
  app on Android. The Mac app has no push, so it isn't told.

**When a class really ends.** NUS classes end about half an hour before the
timetable's end time, to leave time to get to the next one. `endOf` takes
NUSMods classes (tagged `nusmods` by `classesOn`, never stored) as ending
`ENDS_EARLY_MIN` (30) minutes early, never less than 15 minutes after they
start: the trip home, gaps long enough to go home in, `/api/me/day`'s `endsAt`
and "In CS2030 till ~11:30" all follow. Classes entered by hand, usual times
and one-off trips end when they say.

**Taking something off today.** Every `/api/me/day` entry not done yet is
`removable`. The apps take it off with `skipped` and its key (swipe on
Android, × in the web app and on the Mac), then show Undo for a few seconds
(Android in a bar at the foot of the screen, the others where the entry was),
which sends `reset`. It's the same whatever the entry is: a timetabled class,
one entered by hand, a usual time or a one-off trip is skipped for today only
(deleting a weekly one is in Settings), and a trip home skipped means staying:
`planFor` plans no trip home after the last class, and in a long gap plans the
next class from where you are. Skipped entries aren't listed; a skipped trip
home isn't an outcome.

**More than class trips.** Today's trips are `classesOn(profile)`:
the imported and hand-entered classes, plus two kinds that are planned the
same way (leave-by, push, "Not going"):

- `profile.usual`: a saved place at a usual time, `{place, day, atMin}`,
  kept apart from `places` so an older app rewriting the places can't drop it.
  The apps no longer add them (a place you go every week is added to the
  timetable by hand); ones already saved are listed in Timetable, where they
  can be removed, and go with their place when it's removed.
- `profile.once`: a one-off trip on a date, `{date, arriveByMin, to, label}`,
  added with `POST /api/me/once` and dropped once its date has passed.

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
the nearer stop is wrong roughly half the time, and it is the wrong answer
that makes you miss a bus you can see. Instead
[`resolve.ts`](../src/resolve.ts) checks whether the destination is
downstream of each candidate in the scraped route sequence, and scores walking
and riding in the same unit (seconds) so the trade-off is legible. On a loop
route both sides technically reach the destination; the wrong side loses on hop
count rather than on a special case.

**Which stops are tried.** With a location, the nearest few stops that have a
bus to the destination (`WALK.maxCandidates`), so a closer stop nothing there
calls at can't push out one that does. Without one, the stop the trip starts
from, the stop across the road from it (a crossing further), and, from home,
every home stop. Going home, any home stop is home: a bus to PGP gets you
there as well as one to PGP Foyer, and the leave-by's `toCode` says which
it calls at, so the ride is followed to that stop. The alternative is
another service, or the same one from another stop only when it gets you
there within `WALK.mentionWithinS` of the best: across the road it's usually
the same bus the wrong way round the loop.

**Changing buses.** Where no single bus goes there, even from a stop a
short walk away, the answer is a trip on two shuttles
([`transfer.ts`](../src/transfer.ts)): the first to a stop the second
calls at, getting off there or crossing to the stop across the road. One
change at most, never onto the same service or onto a public bus. Which
change stops to ask about is settled from the route data alone, before any
fetch: each route is ranked by a timetable guess of the whole trip (half a
headway's wait for each bus, plus `TRANSFER.changeBufferS` to get off and
cross), and at most `TRANSFER.maxFetch` stops are fetched for them beyond
those the answer fetches anyway, all in the one round, through the same
15-second cache. Where no single bus goes, the stops near you that a change
starts from stand in for the one the answer would have had. `scoreOptions`
then times each route on the live arrivals: the first bus as any other, the
second the first one you can catch once the first gets you there, a headway
on from the last the feed lists when it lists none that late. The trip is
as sure as its less sure bus (`worseOf`), so a guessed second bus makes the
whole of it `scheduled` and never ranks it over a measured single bus. A
change counts as `TRANSFER.worthS` of the trip when ranking, as a fare does.
`TRANSFER.mode` `'noDirect'` offers a change only where no single bus
goes; `'beats'` would also offer one where a single bus goes there but a
change is faster by that much, once the answers have been watched
(`docs/analytics.md`, "Changing buses"); `'off'` never does.

The answer keeps one bus in every field clients already read: `bus`,
`departsAt`, `leave.svc`/`stop`/`board` are the first bus, and `arriveAt`,
`toStop` and `leave.arrive` the end of the trip. The second bus is in
`change` (`BusChange` in the API docs), and the detail says it ("change at
Kent Vale to P"), so an app that doesn't know about `change` still tells you
to change. For a class, the leave-by (`forTransfer` in `leave.ts`) works
back from the room: the latest second bus that gets you there on time, then
the latest first bus that gets you to it, and the arrival forwards from that
first bus; a change must leave you `TRANSFER.worthS` more time at home than
a single bus to be the one.

**A loop's run ends at its terminal.** The shuttle loops start and end at
theirs (KRB, COM3, Kent Vale), where the feed lists the run that ends under an
`-E` berth; a public loop ends at its interchange, which can be off campus
between its last campus stop and its first. Riding on past it is the next run,
so it costs a headway (`reach().through`). Rides are `RIDE.secondsPerHop` a
stop, but no faster than `RIDE.longHopMs` over a long
stretch: route P's stops are kilometres apart.

**Every time counts from now.** A stop's arrivals count from when they were
fetched; `scoreOptions` counts each option from the request (`fromMs`), so a
cached or stale answer's bus is compared with a walk that starts now, and
with another stop's fresher times, on one clock. A stale answer's `asOf`
stays its fetch time. The card is made with the request's now too.

**Operating hours bound every guess.** A headway guess, from the last bus the
feed lists or from nothing, is dropped once it's after the service stops
(`serviceEndsAt`), and the leave-by never projects a bus past it. For a class,
a service that starts before the class is kept, its first bus a headway after
it starts: at 06:30 the 08:00 class's bus is the D2 from 07:15, not
"Services ended". The wait for it to start doesn't count against it when
walking is weighed. With no live times and too late for the usual bus, the
leave-by boards when you can reach the stop, never in the past.

**The walk the whole way follows the paths.** With a location, out by the
stops near you and on by the routed walks between stops (`walks.json`); the
straight line with its detour only for a stop or room within
`WALK.maxRadiusM`. A room that close is walked to directly rather than by its
stop. A place with several stops is walked to by whichever makes it shortest
(`wholeWalk`). Walking is free: a public bus has to beat it by
`PUBLIC.fareWorthS` as well.

**In a residence, the walk is from the building, then from your room.** A
location inside a residence's outline ([`residences.ts`](../src/residences.ts))
starts from that residence's own stops, at the path distance from the
building or from the fix, whichever is longer. When the residence is one your
home stops serve, the walk to the nearest of them is your own `homeWalkMin`
(the lift, the stairs, the far block, which a phone indoors can't see), and
its other stops are as much further as the paths say. The same walk counts on
the card, in walking the whole way, and on the Nearby tab.

**A room can have more than one stop.** A building between two stops is
served by both (`stops` in `venues.json`, from `scripts/walk_routes.py`): its
own stop, and one more when the walk to it is at most `VENUE_EXTRA_M` (100 m)
longer than to the nearest, never a stop and its twin across the road (the
resolver adds that itself). Where the map's nearest stop is the wrong one,
`data/src/venue-stops.json` lists the stops students use instead, by hand:
path length can't see a climb or a road with no crossing (LT21 is left from
S17 and LT27, not University Hall, though the hall is 70 m nearer by path).
The listed stops replace the map's choice entirely, and the first becomes the
building's stop for imports and search. A room uNivUS lists on its own
(`COM1-0208`) takes its building's stops, walked from the room where NUSMods
places it; one uNivUS puts at a stop its building doesn't use keeps that
stop alone. To fix a building: add it to `venue-stops.json` with a `why`, run
`python3 scripts/walk_routes.py`, and commit both (`venue-stops.test.js`
fails while `venues.json` is stale). A trip reads its room's stops from `venueStops()` each time, not from the stop
its timetable was saved with. Leaving a class without a location starts from
every one of them (`originAlso`), each with the room's own walk to it
(`originWalkByStopS`), so the planner takes whichever bus is quicker counting
the walk; going to a class arrives at whichever is quicker, with the walk on
from the stop the bus gets you to (`endWalkByStopS`, `ArriveBy.walkByStopS`),
as for a food court. Standing at a room's other stop is not "You're there":
it can be 300 m from the room.

**Fetch-on-demand with a 15-second edge cache; no poll loop.** Workers has no
long-lived process and Cron Triggers bottom out at one-minute granularity. The
cache entry is keyed on the **resolved stop code**, not the request URL:
`getLastKnownLocation` jitters the coordinates on every call and the tile
appends a cache-buster, so a URL-keyed cache would never hit. The one
exception is the timelapse recorder (below): one bounded, switchable poller
of live bus positions, through the same cache. It is not a pattern for
anything else (CLAUDE.md, rule 2).

The cache is one Cloudflare data centre's, shared by its isolates, so "one
call per stop per 15 s" holds per data centre. Within it, concurrent misses
in one isolate share a fetch (the in-flight map), and the isolate fetching
leaves a `#pending` marker beside the key: other isolates serve their stale
answer until it's done rather than fetch too. A cold key with nothing stale
is fetched by whoever asks. The beta's keys live on their own host
(`beta.terminus.internal`, `scopeCache()`), since the cache may be the
zone's and both sites share one: the beta's breaker never quiets the
stable site.

**Under failure, less load, not more.** A NUS host answering 429 or 5xx,
not answering at all (a timeout, a failed connection, the body included:
`timedFetch` reads it under the same timeout), or a refused version or key
(10009, 10000), opens the feed's breaker for `breakerS`, every stop and
service with it. A host that hangs is treated as down at once: left to each
key's `failMemoS`, every stop and service would hold a connection for the
whole timeout, again and again. A failed token mint is memoised
for `failMemoS`, so the next stops wait rather than each mint. Any other
refusal gets one retry: with another isolate's newer token if there is one
(memo, then KV), else a fresh mint, but at most one per `remintGapS` in a
data centre; with neither, no retry. So a code that keeps coming back costs
one call per key per `failMemoS`.

**KV holds small, slow-changing state; arrivals stay in the edge cache.** The guest token
and device id, the `config:appVersion` override and the `config:timelapse`
switch, the fetched calendar (`calendar:data`), the monitor's view of the
NUS feed and its incidents, of DataMall (`monitor:public`) and of the
version updater's tries (`monitor:autoversion`), the cron's place in its
batches (`trips:armed`, `term:reminded`), sign-in codes and a few
short-lived marks. KV writes are rate-limited and propagation is eventual,
which is wrong for 15-second data: arrivals and live buses live in the edge
cache.

**The stop graph is static and bundled.** Stop locations, route order and
operating hours change a few times a year. `pnpm scrape` rebuilds
`data/stops.json` from the bus proxy's `bus-stops` and `pickup-point` calls.
The proxy has no `ServiceDescription`, so the route codes to fetch come from
the existing graph plus `KNOWN_ROUTES` in the script; a new service with an
unlisted code needs adding there. The **scrape stop graph** workflow
(`.github/workflows/scrape.yml`) runs the same scrape every Monday in three
jobs: `scrape` holds the feed and DataMall secrets and runs only the repo's
standard-library Python; `test` runs the test suite and `check_scraped.py`
on the scraped files, with no secrets; `commit` is the only job that can
push, runs no npm code, and fast-forwards `main` to a commit of just the
data files on top of the commit that was scraped and tested. If `main`
moved during the run, nothing is pushed and the run says to run it again. A
deploy then puts the data live.

The scrapers that send keys (`scrape_stops.py`, `scrape_lta.py`) refuse
every redirect, since urllib re-sends every header to wherever one points;
the others follow https redirects only. Each caps the bytes it reads per
reply, and `scrape_lta.py` the pages per dataset. `route_shapes.py` asks
only overpass-api.de. `check_scraped.py` compares with HEAD: a stop moved
over 100 m, a changed stop order on an existing route, any item lost from a
list under 20, a name with odd characters or a web address, a moved
semester or more than 3 future holidays gone all fail, and such a change is
committed by hand.

**Route lines follow the roads.** `scripts/route_shapes.py` routes each
service stop to stop along OpenStreetMap's drivable roads (one-way streets
respected, each stop joined on the side the bus drives) into
`data/shapes.json`; the weekly scrape runs it after the stop graph and
`check_scraped.py` checks the result. Each shape records the stops it was
made for: a route whose stops changed since is drawn as straight lines
until the next run. The NUS feed has no route shapes of its own.

**The street map is one file on R2.** `scripts/map-tiles.sh`, run by the
**map tiles** workflow, cuts the campus (about 3.3 MB) from the Protomaps
build of OpenStreetMap, from zoom 12 up (the clients never zoom out past
13), and uploads it, with Noto Sans glyphs and the light
and dark icons, under `map/` in each site's downloads bucket (stable and
beta have their own; the workflow does both by default).

Protomaps' Noto Sans has no Chinese, so on the Chinese map every Chinese
name drew as empty space on Android (the web draws Chinese in the device's
own fonts, `localIdeographFontFamily`, which the Android map can't). The
script fills each range Protomaps leaves empty from Noto Sans SC (noto-cjk
at `NOTO_CJK_TAG`), turned into glyphs by Stadia Maps' `build_pbf_glyphs`
(`GLYPHS_VERSION`); the tool and both fonts are checked against SHA-256s
in the script. They go into the same three fonts, so the style names no
other. A client downloads only the ranges its labels use.

A range is kept for 30 days by its URL, at the edge, in the apps' map
caches and in the web app's service worker, so changed fonts need a new
URL: the style's glyphs URL ends `?v=` and `GLYPHS` in `src/map.ts`, bumped
when the fonts on R2 change (v2 brought the Chinese), and the edge keeps the
versioned range apart from the old.

Every client's MapLibre parses these files natively, so what goes up is
pinned in `scripts/map-tiles.lock`: the build date, bbox and minzoom, the
`pmtiles` version, the cut's SHA-256 and size, the basemaps-assets commit,
the noto-cjk tag and `build_pbf_glyphs` version, and one SHA-256 over the sorted `<sha256>  <path>` lines of the 776 font and
icon files. `pmtiles extract` is deterministic for a given build and
version, so a normal run cuts the locked build again and refuses to upload
unless every value matches. `--update` takes the newest build and rewrites
the lock without uploading; the owner commits it, then uploads within a few
days, since Protomaps keeps a build only about a week (once it's gone, R2
keeps serving the last upload). The workflow's manual run builds and checks
without the token, then uploads in a separate step that downloads nothing;
its twice-yearly schedule only runs `--check`, which fails as a reminder
when a newer build exists.

**Public buses are more services at the same stops** ([`public.ts`](../src/public.ts),
[`lta.ts`](../src/lta.ts), `data/public.json`). Singapore's public buses stop
at the shuttles' shelters along Kent Ridge Crescent and Lower Kent Ridge
Road, and a 95 or 151 is often the first bus to a stop the shuttle also
serves. `scripts/scrape_lta.py` takes LTA DataMall's stops, routes and
services, keeps the stops within 200 m of a shuttle stop (the campus, not
Pasir Panjang Road or the AYE) and trims each public service to its stops
there; the weekly scrape runs it, with the `LTA_ACCOUNT_KEY` secret, and
`check_scraped.py` checks the result. The script also decides which public
stops are a shuttle stop's shelter: within 20 m (`SAME_SHELTER_M`), the
nearest, one per shuttle stop, kept as `merged` in the file. `withPublic()`
builds a second graph from it, `GRAPH_PUBLIC`: a merged stop is the shuttle
stop, which gains a `publicCode`; any other is a stop of its own under
LTA's five-digit code. Everything built from `GRAPH` alone (the map, the
search, the stop pairs) is untouched, and so are the golden answers: the
public graph is used only when a profile's `publicBuses` is on (off by
default, a switch in every client's Settings), when `?public=1` is sent, or
for `/api/arrivals` at a stop only public buses call at.

Three things about public buses are their own. A two-way service is two
routes, `151/1` and `151/2`, and shows as `151` (`svcName()`); LTA's
arrivals name each bus's destination, which tells the directions apart at
the one stop both call at. Ride time comes from metres along the route
(`along`, from LTA's distances), not a count of stops: a public route's
campus stops can be a long way round the island apart (the 95 goes out to
Holland Village between Opp Kent Ridge MRT and Kent Ridge MRT). And a fare
counts: a public bus is the headline only when it beats the free bus by
`PUBLIC.fareWorthS`, and otherwise is the alternative; its leg carries
`paid: true`, the detail says "public bus", and the clients draw a `$` on
its badge. Only a time LTA marks `Monitored` as `1`, `true` or `"1"` is
`live`; any other value (0, `false`, missing, renamed) is the operator's timetable, `scheduled`, so
a change in how the field is written can't pass a timetabled time off as
live. The leave-by keeps a timetabled time estimated too
(`leave.estimated`). A leave-by from a stale feed, or a plan an earlier
answer kept for the trip, carries `stale: true` and is never drawn as
live. A plan kept for a device without a location shows this answer's
times when it has that same bus. A day both of
whose LTA times are "-" is `null` in `serviceHours`, "not running today":
95B, 96A and the other weekday-only services aren't guessed at weekends.

`normalizePublic()` reads only zoned times (DataMall sends `+08:00`; one
without a zone would be read as UTC on a Worker, 8 h out) within a week.
`publicProblem()` checks the reply by value: each service needs its
`NextBus`, each slot an `EstimatedArrival` that is a zoned time or the
empty slot's `""`, and where both directions of a service call (Kent Ridge
Terminal), each bus its `DestinationCode`. A service the graph doesn't know
or a bus already gone is not a problem.

A shelter both feeds answer for is asked of both (`collectArrivals`), and
`StopArrivals.feeds` keeps each feed's own state, so the shuttle feed being
down reads as "no data" for the shuttles and not as "no bus", while the 95
stays live, and the other way round. DataMall is called like NUS is: one
call per stop per 15 s through the edge cache (`edgecache.ts`, which both
feeds now use), a failed stop not asked again for `failMemoS`, a refused
key (401), a 429, a 5xx or no answer at all (a timeout, a failed
connection) tripping a breaker for `breakerS`. The stable cron probes it once a
run for `/api/status.json` (`publicFeed`) and `/api/health` (the beta reads its own
trips instead; see "The beta's checks" below); it raises no alerts, since
the shuttle is the product and this is extra. LTA has no live train feed,
so the MRT is not here; nor are live public buses on the map, which the
per-stop feed cannot give without polling every stop. Contains information
from LTA DataMall accessed via the Singapore Open Data Licence.

**Failures show in `quality`.** A time is `live` (from the feed now),
`stale` (from the feed's last good answer), `scheduled` (a headway guess
inside operating hours, or, for a public bus, LTA's timetable) or `unknown`
(no time at all: the feed couldn't be reached); `ended` means the services
have stopped. A measured time (`live` or `stale`, `isMeasured`) always
ranks ahead of a guess, whatever the minutes say. A stale answer keeps its
**original** `asOf` timestamp. A three-minute-
old answer labelled as such beats a spinner, and beats an empty tile that
reads as "no buses". Only a real arrival becomes `stale`; a headway guess
from an old answer stays `scheduled`. A stale bus's leg (`bus`, `altBus`) is
`estimated`, as a guess's is, so its times are drawn with a `~`. Arrival times count from when they were
fetched, so a bus that has left since then (by the walk to it) is never
offered as catchable.

## What the feed looks like

`test/fixtures/` holds real captured responses and `test/fixtures/README.md`
records what they establish. Three findings changed the code:

**The list key depends on who wraps it.** The feed itself lists arrivals
under `shuttles` (the raw `connectx-ShuttleService-COM3.json`, and the bus
proxy's `data`); `bus.hewliyang.com`'s proxy, where most stop fixtures come
from, puts them under `timings` in an `etas` envelope. `normalize()` returned
an empty array on those captures until a fixture proved it, and now reads
both (`ARRIVAL_LIST_KEYS`).

**Crowding is a headcount, not a bucket.** In hewliyang's captures,
`arrivalTime_capacity` / `arrivalTime_ridership` against 88-seat buses, so
`88/88` means "you are not getting on this one" rather than a vague "high".
The raw feed has `passengers` per row and `px` per arrival instead, `"-"`
when unknown; `normalize()` reads either. Some vehicles report nothing, and
an absent field is not an empty bus.

**A terminus reports the same service under two berth codes.** COM3 is the
D1/D2 terminus and returns both `COM3-D2-S` (a run starting there) and
`COM3-D2-E` (a run ending there); mid-route stops like `UHALL-OPP` and `UHC`
carry a bare code. This is a second direction problem underneath the
`X` / `X-OPP` one, and it is the dangerous kind, because both berths belong to
the same physical stop, so choosing the right stop does not save you. Nothing
orders the two: when no bus is waiting to depart, the terminating arrival is
the sooner of the two, so taking the earliest ETA hands you a bus that ends
its run as you board. `normalize()` reads the `-E` suffix and marks such
a row `ends: true`, and `resolveBerths()` drops those rows, so nothing past
the normaliser knows how the feed spells it; `berth` itself is opaque, only
compared. Where several berths exist and no suffix separates them, the answer caps
`confidence` at 0.5 and says "direction unconfirmed" rather than guessing.

Also: `arrivalTime_ts` looks like an absolute arrival time and would be better
than relative minutes across a cache TTL, but real rows carry timestamps
minutes in the past alongside a positive `arrivalTime`. It is not used.

`normalize()` and `normalizeBuses()` treat anything they can't read as
missing, never as zero: an `arrivalTime` that is negative or looks like a
clock time ("-3", "12:30") is no time; `eta_s` is a number or a string of
digits (a decimal point allowed, rounded to whole seconds), so a blank, `false` or `[]` there is no time rather than "arriving
now"; a time more than a week away (`MAX_ETA_S`: an epoch, a changed unit)
is no time; and a live bus with a blank or null latitude, longitude or
direction has no position or heading, rather than sitting at latitude 0 or
heading north. Service names are read as the graph spells them ("d2" and
"D 2" are D2), since everything downstream compares them exactly.

The list itself is found under the names the feed has used (`shuttles`,
`activebus`, ...), or failing those, any array of rows. Only rows: the
shuttle reply carries `hints`, a list of strings, beside its `shuttles`,
and with `shuttles` gone that would otherwise be read as an empty board.

A reply the feed calls OK but that can't be read is a failure, never an
empty board. With no list at all (`hasList`), or a list whose rows lost
what `normalize()` reads, the fetch throws. That is checked by value, row
by row (`arrivalsProblem`): no row names a service, or none names a service
we know, or not one row reads. A row reads when its first time is there
and is one it can read, or is the feed's own "no bus" ("-", or an empty
`_etas`); a missing time (renamed, null) or one it can't (a clock time, a
word, more than a week away) doesn't. When only some rows don't read,
those services alone are no data (`arrivalsUnread`, `StopArrivals.unread`):
`unknown` on the card, never the "no bus" headway guess, which would hand
the headline to another service while the bus that's really next is
missing. The rest of the board stays live, so one odd value doesn't take a
stop down, or, at the probe's stop, put the feed-down notice on every
card. The Worker logs which services didn't read. `busesProblem` throws when no row has a plate or a position,
or when there are rows and not one bus can be read from them (positions
null, swapped or in another format; plates blank), unless they're all at
0, 0, the feed's "no fix yet". Read as it was, every
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

The guest JWT from step 1 is accepted by the proxy directly, with no seed token,
refresh endpoint or buswidget hop. `data` is the old `ShuttleServiceResult`
contents, so `normalize()` is unchanged. Like every uNivUS endpoint, failure
comes back at HTTP 200 with a non-`"00000"` code; `fms.ts` retries once with a
fresher token (at most one mint a minute) and otherwise reports the stop
unavailable. Any other HTTP status is the host saying no, and isn't retried.

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
it tried, with the command above and NUS's full response. After a switch, the
isolates still sending the old version (for up to `versionMemoMs`) are refused
too; a refusal of a version `config:appVersion` no longer holds opens neither
the breaker nor the mint memo, nor quiets its stop or service for
`failMemoS`, so it doesn't stop the isolates already
sending the new one, and that isolate forgets its old version. To see what it would
find today, without calling NUS: `GET /api/health?versions=1` with the
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

Four things that will bite you:

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

The feed's secrets are its three API keys (`X-HTD-API`, `X-APP-API`, the
proxy's `x-api-key`); the rest of its settings are URLs, the version, the
optional device id and two optional headers. `.dev.vars.example` also has
`LTA_ACCOUNT_KEY`, DataMall's key, which is as secret as the three.

## Analytics

Every answer someone asks for (`/api/next`, `/api/trip`, `/api/me/next`) writes one
decision row, plus one row per timed arrival (eight at most,
`MAX_ARRIVAL_ROWS`), to a Workers Analytics Engine dataset. Answers the server works out for itself are not logged
(`log: false`): the Trip object's wakes, and each class's leave-by on
`/api/me/day`. They would cost rows and count as answers on the dashboard. Two purposes: checking whether the direction
algorithm is right, which nothing else measures, and inter-stop
travel times from the feed's own predictions (`plate` is the join key), a
check on `RIDE.secondsPerHop`. Queries and
the schema contract are in [docs/analytics.md](analytics.md).

Logging is a no-op without the binding and swallows its own errors. A logging
failure never fails an answer.

A cron step that fails (the feed check, the calendar, arming trips, ...) is
logged and also written as an `error` row with the route `cron <step>`, so
it shows with the errors on the dashboard; it sends no email. The cron's
handler waits for every step, so a long run isn't cut off partway while the
trigger's history says it succeeded. The monitor never acts on a KV read
that failed: it changes no state, sends nothing and writes no incident, and
the next run carries on. Its state is saved before an alert is emailed (an
email that fails, or takes over 15 s, is sent again the next run). KV takes
one write a second to a key, so the state is written once a run: a delivered
alert is noted under `monitor:alerted`, and the next run clears it from the
state. Each run puts the outage list right if an earlier write of it failed.

**The beta's checks.** Only the stable Worker's cron asks NUS and LTA (one
stop each, past the cache). Both Workers run the cron, and the beta asking
too would double that scheduled load for a site few people use. Instead,
whenever a request on the beta trips a feed's breaker, the failure (with
NUS's code, response and the version string it refused) is noted in the
beta's KV (`monitor:seen`, `monitor:seen-public`; at most once a minute per
isolate; [`src/feedwatch.ts`](../src/feedwatch.ts)). The beta's cron reads a
note from the last 15 minutes as a failed check (`sawTrip`) and runs the same
state machine on it, so its status page, the card's "down since" notice and
`/api/health` follow its own traffic, and a note from a version since switched
away from doesn't count. With no traffic there is nothing to note and the
feeds read as up. A refused version (10009) runs the automatic update as on
the stable site, so the beta keeps its own `config:appVersion` current; that
tries a few candidates with NUS, only while NUS is refusing the beta. The
beta emails no one: its alerts go to its logs as `beta: terminus: ...`, with
the fix commands naming the beta's KV namespace (`KV_NAMESPACE_IDS`, kept in
step with `cloudflare.config.ts` by a test), and each run while its feed is
down is counted on its dashboard as the error `cron feed down`.

## Known weaknesses

- **A room's other stops are used by the account's trips only** (`/api/me/next`,
  `/api/me/day`). The public `/api/next?to=` and `/api/trip?to=` keep one stop per
  building: they count no walk from the stop to the room, so a second stop
  would look as near as the first. On the bus, the arrival line counts the
  walk from the room's usual stop, not the one you get off at. And path
  length can't tell an easy walk from a hard one: a stop the map wrongly
  prefers needs an entry in `data/src/venue-stops.json`, found by someone
  who walks it: the apps' Send feedback page asks for these.

- `RIDE.secondsPerHop` is a **guessed constant** and the ranking inherits its
  error. It separates a 2-hop ride from a 14-hop ride, which is the case that
  matters; it does not reliably separate 4 hops from 5. `stop.confidence`
  reports which situation you are in: below ~0.6, the answer is little better
  than a coin flip. The feed's own predictions are the way to check it
  ([docs/analytics.md](analytics.md)).
- For a shuttle, `quality: 'scheduled'` has no timetable behind it. It means
  "inside operating hours, feed gave nothing, here is a headway estimate".
  (For a public bus it is LTA's own timetable.) It is the weakest rung that
  still gives a time, and it is labelled as such; only `unknown`, with no
  time at all, is weaker.
- The `-E` rule rests on one captured stop's arrivals. `stops.json` has `-E`
  berths at all three shuttle termini (`KRB-A1-E`, `KRB-A2-E`, `COM3-D1-E`,
  `COM3-D2-E`, `KV-P-E`), but only COM3's arrivals are in the fixtures.
  `resolveBerths()` drops every row that ends here rather than preferring
  `-S`, since route P starts at a bare `KV`. If a terminus spells its berths
  differently in the arrivals, it falls through to the ambiguous branch and
  caps confidence, which is the safe direction to fail, but it wants a
  second terminus in the fixtures to confirm.
- Most stop fixtures come from `bus.hewliyang.com`'s proxy, not the feed
  directly: the rows are passthrough, the envelope is his. One raw ConnectX
  `ShuttleService` body (`connectx-ShuttleService-COM3.json`) confirms the
  rows. There's no capture of the current bus proxy's reply yet; `normalize()`
  is tested on both shapes it replaced.

## Clients

The Android widget and app ([apps/android](../../android)), the Mac menu bar app
([apps/macos](../../macos)) and the website ([apps/web](../../web)) all use `/api/me/next`.
The Android app, the web app and the Mac (in a window of its own) also have
the campus map: `/api/campus`, `/api/buses`, `/api/arrivals` and `/map/*`. The Buses
tab (web and Android) opens a service's whole line with `/api/line`. The apps
download `campus.pmtiles` once and read it from disk, since MapLibre Native
fails the whole style when one streamed piece fails. The Mac's MapLibre is
built from source (`scripts/vendor-maplibre-mac.sh`; no macOS build is
published), and its Metal renderer draws the style's background layer over
the street map's fills, so the Mac drops that layer when the street map is
there.
For local work, `node scripts/dev-stub.mjs` runs this Worker with a fake bus
feed and a seeded test account.

The apps call terminus.rcn.sh (the beta's: beta.terminus.rcn.sh), not
terminus.run, which they show in links and text: the old address is the one
kept for good, so an app never updated keeps working if the site moves.
Android has the two as `API_BASE` and `SITE` in BuildConfig; the Mac as
`Api.base` and `Api.site`, with `TerminusAPI` and `TerminusSite` in the
beta's Info.plist. The Mac's Sparkle feed is on the old address too.

Settings, About has a Developer group that picks the server from those built
in (`Servers.kt`, `Servers` in `Api.swift`): the site's two addresses and,
in a debug build, the dev stub (Android: `localhost:8787` through `adb
reverse`, or `10.0.2.2:8787` from the emulator; Mac: `localhost:8787`). It's
always there in debug and beta builds, and in a stable release after seven
taps on the version. Nothing can add a server: a saved choice that isn't
built in (dropped by a later version, or written by another app into the
Mac's preferences) is ignored on every read, and the default used. The
stub keeps its own sign-in, so a real token never goes to it over plain
HTTP: Android sets the session aside (`Store.swapSession`, `token-site` and
`token-local`) and restarts the app; the Mac keeps a token per folder
(`terminus`, `terminus-beta`, `terminus-dev`) and relaunches. The site's two
addresses are one server with one token, so switching between them keeps
you signed in.

### Live buses on the map

`/api/buses` shows each bus at a stop or between two (`src/buses.ts`). The feed
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
the stop after the one it's at, or the one it's heading to. `upcoming`
lists the stops still ahead, `nextStop` first, to where the line ends
(round a loop, back at its first stop), and `towards` is that end: the
map's bus sheet says "Towards COM 3" and lists the stops from these, so no
client walks the route itself.

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
track leaves the bus where it was, so `along` never goes back. One up to
500 m behind (`HOLD_BACK_M`), with nowhere ahead it could be, holds it
where it was for up to 2 minutes (`HOLD_BACK_MS`), or as long as its track
lasts at the end of a loop: A1 and A2 leave Kent Ridge Bus Terminal along
the road they came in by before they join the start of their line.

A track lasts ten minutes from the last time the feed reported the bus,
moved or not: a bus standing still at a terminus for longer keeps its side.
A bus with no track (just appeared, or nobody watched the service for ten
minutes) is placed by its heading when moving; standing, by the stop it's
at, if it's clearly nearer one stop than its twin across the road; otherwise
on the nearer side. A track that started wrong gives way when the bus is
seen moving the other way twice in a row; one odd heading doesn't move it.
A tracked bus that strays more than 50 m off its line for under 30 s (a GPS
jump) stays at its last place; longer (`HOLD_OFF_MS`: the depot, a
detour), its track is dropped and it's left out of the answer until it's
back on its line.

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
each. The offset is in pixels at full size (zoom 17) and shrinks with the
bus's icon as the map zooms out (web `BUS_SIZE` in map.js, Android
`busSize`, Mac `iconScale`). When a
bus's place changes, it slides there along the route line at a steady 100 m a
second, so a longer stretch takes longer: from 1 s for a short hop to
4 s, done before the next answer, 5 s on (a typical slide, half of a
421 m stretch, takes about 2 s); with reduced motion, after 15 s without an answer, or to a place
it can't reach along the line (behind it, or over 1.5 km on), it jumps.
On a loop it slides on past the line's start, as the API places it. Clients
take that from `/api/campus`'s `loop`, not from where the line ends: A1's and
A2's lines end some 40 m from where they start at KRB.
A tapped bus is ringed. Between stops, its `stretch` is drawn over the
route, wider, with the rest of the route faded well back. Its card says
where it is ("At COM 3", or "Next: COM 3" between stops) and where it's
going ("Towards Kent Ridge MRT"), with the stops ahead from `upcoming`.

### The timelapse recorder

A day of every shuttle, for a timelapse video
([`src/timelapse.ts`](../src/timelapse.ts),
[`src/timelapsedo.ts`](../src/timelapsedo.ts)). It is the **only poller of
the NUS feed** and the one exception to "don't add load on NUS"
(CLAUDE.md, rule 2). Answers fetch because someone asked; the only other
scheduled reads are the stable cron's health check (one stop from NUS and one from
LTA every 15 minutes, past the cache; the beta's cron asks neither) and each push user's Trip object
(a card at most every 30 s, through the cache). It is bounded on every side:

- **Rate.** Each service's live buses (`active-bus`, the map's call; the feed
  has no call for every service at once) once per `TIMELAPSE.pollMs`, 30 s
  by default and never below `MIN_POLL_MS`, 15 s (`pollInterval()` enforces
  it). The services are spread across the interval: with eight running, one
  every 3.75 s rather than all at once. Arrivals are never polled.
- **Path.** Through `getBuses()` and `trackedPlacement()`, exactly as `/api/buses`
  asks: the 5 s edge cache, one fetch in flight per service, `failMemoS`
  after a failure and the breaker after a refusal. When the map has just
  asked for a service, the poll is a cache hit and costs NUS nothing. With
  the breaker open the poll is skipped, not retried. A stale answer (the
  feed failing) is not recorded.
- **Hours.** Only inside `TIMELAPSE.hours`, 06:30 to 00:30 Singapore time.
  The window crosses midnight, so a day is the date its window opened, until
  it closes the next morning. Within it, only services inside their own
  operating hours (`inService`, on the same calendar as the rest of the
  Worker, so a holiday known only from KV runs holiday hours), checked
  again before each poll. No service
  is asked again within `pollMs` of its last ask, across rounds too (a round
  with fewer services has shorter slots). After `idleRounds` rounds
  in a row (3 minutes) in which every running service answered and no bus was out
  anywhere, it stops: for the
  day if it has seen buses and no service is still inside its hours
  (service is over), else for `idleSleepMs` (15 minutes): before the first
  bus of the morning, or a gap while services are still running, after
  which it asks again. Ending the day on a gap would lose the rest of it. A round in which any
  service failed (an outage, the breaker, one service refused) doesn't count
  towards that, and starts the count again.
- **Back-off.** A round in which no service it asked answered is a failing
  feed. The next round then waits 2, 4, then 8 times `pollMs` (four minutes
  at most), and the first round that gets an answer brings it back. The
  failure memo is shorter than a round, so without this an outage would be
  asked at the full rate all day. Each service's `asked` time is saved
  before its request, so an alarm that throws afterwards, which the platform
  runs again within seconds, doesn't ask again. A poll that throws after
  its request (placing the buses, storage) counts as a failed poll and the
  round moves on, so one service failing every time can't stall the day.
- **Kill switch.** KV `config:timelapse` set to `off` (or `on`) wins.
  Otherwise the `TIMELAPSE_ENABLED` var applies: `on` for the stable site,
  `off` for the beta (so the two never poll twice), and off when unset or
  when KV can't be read (it may hold an `off`). The
  switch is read once a round, so `off` stops it within 30 s, without a
  deploy. On again, the cron restarts it within 15 minutes.

At the defaults that is at most 17,280 polls a day (8 services × 2 a
minute × 18 hours), and the code holds it there: `pollInterval()`
lengthens the interval when `stops.json` has more routes (the weekly
scrape commits it unattended), so that services × ceil(window ÷
interval) stays within `TIMELAPSE.maxPollsPerDay`. A day already running
takes the longer interval from its next round after such a deploy. The services' real hours make it about 13,300 on a
weekday, 9,000 on a Saturday and 6,700 on a Sunday or holiday. Each poll
is one `active-bus` call, plus at most one retry on a rejection that a
token might fix, with a token minted at most once a minute. The map alone, with one
person watching one service, asks for it every 5 s: six times this rate.
Every poll writes an Analytics Engine row saying what it cost (`upstream`,
`error`, `hit`, `stale`, `failed`, `skipped`; analytics.md), and a `retry`
row for each request past the first. A request
that reached NUS and failed is `error`, so an outage doesn't hide the load. The dashboard shows the
real requests to NUS per day.

**How it runs.** One `TimelapseRecorder` Durable Object per Singapore day,
named by its date, created in Asia (`locationHint: 'apac'`), so the edge
cache it reads is likely the one Singapore's map users fill. The 15-minute
cron (`ensureRecorder`) starts the day's recorder inside the window with
the switch on, and does nothing if it is already running. From then on the
object's own alarm is its clock, since a cron can't run more often than
once a minute. It never runs inside a user's request, so it can't slow or
fail one.

**What it keeps.** Each poll that brought a new reading is one row in the
object's SQLite storage: milliseconds since the row before (it can be
negative: a cached answer can be a moment older than the last row), the
service, and four whole numbers per bus. Those are the plate's index in a
day's list of plates, latitude and longitude in steps of 1/100,000 of a
degree (about 1.1 m) from a fixed point by campus, and metres along the
route line. That is the bus's own place on the line from its track
(`trackedPlacement`, the same placement the map uses), not the stop or
midpoint the map draws it at; `-1` off the line. A poll with no buses is a
row with none; a failed poll is no row. The route lines and stops are kept
with the day, so the replay draws each `along` on the line it was measured
on. A deploy that changes a line mid-day is caught by a fingerprint of each
line kept with the day (`lineKeys`): from then on that service's positions
are kept without metres along, and the replay leaves those buses out rather
than draw them on the wrong line.

**At the close** the object writes the day to R2 (the site's downloads
bucket) as `timelapse/YYYY-MM-DD.json.gz` (`DayFile`), deletes everything,
its alarm included, and costs nothing from then on. If anything on the
way fails (R2, or the object's own storage) it keeps the day and tries
again 10 minutes later, for a week after the close; meanwhile
`/api/timelapse/days` still lists it (the recorders of the past week are asked
too). Past the week the day is given up and the storage deleted. Once a
day, at the cron's first run after the window opens, the recorders of the
past eight days are asked to start: one holding a day whose alarm is gone
(the platform's retries of a throwing alarm ran out) is woken to close it,
and one holding nothing does nothing. The eighth day covers a day whose
retries ran to a week after its close, later than the last morning that
asked it. Asking about a day nobody recorded
creates no storage. `/download/*`
serves only release files, so the days are reachable only through
`/api/timelapse/days`, with the operator token or `TIMELAPSE_TOKEN`. The second
opens these routes and nothing else, so the machine that renders the videos
unattended (`scripts/render-timelapse.mjs`, on a VPS) never holds the
dashboard's key.

**Replaying it.** The operator's page,
[`/admin/timelapse/`](../../web/public/admin/timelapse), reads a day with
[`replay.js`](../../web/public/admin/timelapse/replay.js). The API's tests
read it with the same module. Between two readings a bus moves along its
route line from one `along` to the next (forward past the end of a loop),
not in a straight line. Readings more than 2 minutes apart are not joined:
the bus fades out after the first and in before the next. A reading
further on than a bus could have driven fades out and in too, but stays
in the count of buses out throughout (`countBySvc`), so a service with
one bus out doesn't blink to none at every jump (a one-way route's end).
After its last reading a bus stays for one poll, then fades. The page draws the map
at the video's exact size with `preserveDrawingBuffer` and no label fades.
For each frame it sets the time, gives the buses' GeoJSON source their
places, waits for the map's `idle`, and draws the map and the overlay
(clock, date, buses per service, wordmark, map credit) onto one canvas.
Mediabunny then encodes that canvas, H.264 in MP4 (`fastStart:
'in-memory'`) or VP9 in WebM where the browser can't do H.264. Awaiting
each frame's `add()` respects the encoder's backpressure, so the video is
the same however fast the machine is. Mediabunny is vendored
(`scripts/vendor-mediabunny.sh`, MPL-2.0 with its licence), and the service
worker never keeps it.

## Layout

```
src/index.ts      Router
src/resolve.ts    Haversine, directional pairing, downstream reachability, scoring
src/format.ts     label/detail strings, the degrade ladder
src/fms.ts        ShuttleService client + defensive response normalisation
src/lta.ts        LTA DataMall client: the public buses at a stop
src/public.ts     Public buses in the graph (GRAPH_PUBLIC), route keys, ride metres
src/edgecache.ts  Fetch through the edge cache, stale on failure, breaker: both feeds
src/auth.ts       Public token, lazy refresh, KV + in-memory memo
src/config.ts     Cache TTLs and tuning constants
src/calendar.ts   NUS teaching weeks and public holidays
src/calendarsync.ts  The calendar fetched weekly by the cron into KV, between deploys
src/nusmods.ts    NUSMods share URL -> trips
src/campus.ts     /api/campus: stops, route lines and colours, destination search
src/buses.ts      /api/buses: live buses placed on their route, next stop; /api/line's stops and buses
src/timelapse.ts  The timelapse recorder's rules, day file and /api/timelapse/days
src/timelapsedo.ts  The recorder's Durable Object: one per Singapore day
src/map.ts        /map/*: the street map file, its style, fonts and icons
src/pairs.ts      /api/stops/pairs
src/analytics.ts  Analytics Engine logging: decisions and arrivals, errors
                  (logError, logCronError), timelapse polls (logPoll)
src/openapi.ts    OpenAPI 3.1 spec and the Elements docs page
src/http.ts       JSON responses, query parsing, CORS, security headers and
                  the CSP, timedFetch (upstream calls under a timeout)
src/types.ts      Env (bindings and secrets) and the API's shared types
src/landing.ts    The landing page, with the version and Account written in
src/pagesky.ts    The band of sky on the Worker's small pages and /docs
src/async-hooks.d.ts  Types for node:async_hooks, the one Node API used
src/seo.ts        robots.txt, the sitemap and /llms.txt (a guide for AI agents); the beta asks not to be crawled
src/accounts.ts   Sign-in codes and links, sessions, anonymous accounts, pairing codes (D1)
src/applogin.ts   App sign-in approved from the email
src/access.ts     API keys, and who may call the keyed routes
src/profile.ts    Profile validation and the where-next planner
src/me.ts         /api/auth, /api/pair and /api/me routes
src/next.ts       /api/me/next's answer: the plan, free days, riding, the trip's phase
src/day.ts        /api/me/day, today's timeline
src/trip.ts       Trip phases, and the per-user Durable Object with today's signals
src/tripdo.ts     The Trip object's wakes and push
src/answer.ts     The answer engine: stops near you, their arrivals, the best bus
src/card.ts       The card every client shows, worded once
src/leave.ts      When to set off; src/clock.ts clock times and lateness
src/plan.ts       Which bus a trip is about: one plan for every device
src/outcomes.ts   What happened to each planned trip, and what it suggests
src/crowd.ts      Full buses: a packed bus can pass a stop
src/walk.ts       Walking along campus paths (data/walks.json)
src/graph.ts      The stop graph, with hand-kept fixes
src/geo.ts        Distance (a leaf module)
src/residences.ts, src/landmarks.ts  Halls and named places served by several stops
src/push.ts       FCM to Android; src/webpush.ts Web Push to the web app
src/monitor.ts    The cron: feed health, incidents, housekeeping, arming trips,
                  the new-semester reminder
src/feedwatch.ts  The beta's feed checks, from the breaker trips of its own traffic
src/appversion.ts Finding the new uNivUS version when NUS refuses the old one
src/downloads.ts  /download/*: app files and the Mac appcast from R2
src/admin.ts      /api/admin/stats; src/feedback.ts "Is this wrong?" reports
src/i18n.ts       Every server string in English and Chinese
src/site.ts       Which Worker this is: stable or beta
data/             Bundled JSON: stops.json, shapes.json, public.json,
                  calendar.json, walks.json, venues, rooms, landmarks, residences
migrations/       D1 schema
scripts/          dev-stub.mjs, the scrapers, probes and render-timelapse.mjs
test/             *.test.js, worker.smoke.js, fixtures/ (captures, golden answers)
```

`normalize()` in `fms.ts` is the only function that touches the raw FMS shape.
It is undocumented and has changed before, so it is tolerant and everything
downstream assumes a clean `Arrival[]`. When the feed shifts, exactly one
function needs editing, and `arrivalsProblem()` makes sure the shift is
noticed (an alert) rather than read as an empty board. The same goes for
`normalizeBuses()` with `busesProblem()`, and `normalizePublic()` in
`lta.ts` with `publicProblem()`.

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

This reads the public guest-token endpoint the uNivUS app itself uses to
show Bus Arrival without a sign-in (a guest JWT plus the app's
`x-api-key`; no NUSNET account). On request, that's at most one call per
stop per 15 seconds, and one per service per 5 seconds for live buses while
someone has the map open. On a schedule: the 15-minute health check (one
stop), each push user's Trip object (through the same caches), and the
timelapse recorder, each service's bus positions at most once per 30
seconds inside fixed hours, behind a kill switch. Public buses come from
LTA DataMall, one call per stop per 15 seconds, plus one stop per health
check. Use it in line with the
[NUS Acceptable Use Policy for IT Resources](https://nus.edu.sg/registrar/docs/info/registration-guides/aup-form.pdf).
Do not commit captured credentials, do not use NUSNET credentials with it, and
do not raise the request rate.
