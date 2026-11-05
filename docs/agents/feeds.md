# Feed limits (CLAUDE.md, rule 2)

Every call terminus makes to NUS's shuttle feed and LTA DataMall, and the
limits on each: the detail behind rule 2 in CLAUDE.md.
`test/feed-limits.test.js` holds the floors, and ADR 0003 and ADR 0004 the
reasons.

## On request

Arrivals are cached 15 s per stop
(`TTL.arrivalsMs`), live buses 5 s per service (`TTL.busesMs`), all in
`src/config.ts`. Never lower these, poll in bulk, or scan for endpoints.
Upstream failures back off (`failMemoS`, `breakerS`): a refused version
or key, a 429 or 5xx from a NUS host, or no answer at all (a timeout,
a failed connection), opens the breaker; a failed token mint isn't
tried again for `failMemoS`; a refused call is retried once, with a
token minted at most once a minute (`remintGapS`). The cache is per
Cloudflare data centre, so a miss asks the feed gate
(`src/feeds/feedgate.ts`, one Durable Object per stop or service) first: one
call per key per window across every data centre. Don't route a feed
call around it. The same goes for LTA DataMall, the public buses' feed (`src/feeds/lta.ts`):
one call per stop per 15 s, through the same cache
(`src/feeds/edgecache.ts`).

On failure the cache serves a stale answer if one exists (up to
`staleMaxS`), and a failed stop isn't asked again for `failMemoS`. The uNivUS version string must track the Play Store; KV
`config:appVersion` overrides the secret.

## The timelapse recorder, the one poller

`src/map/timelapse.ts`, `src/map/timelapsedo.ts`. The only code that
polls the NUS feed on a schedule rather than on request. Its limits:
- **Rate:** each service's live buses once per `TIMELAPSE.pollMs` (30 s),
  spread across that time, never below `MIN_POLL_MS` (15 s, enforced in
  code). Arrivals are never polled.
- **Path:** `getBuses()`, the map's own path, so the 5 s cache,
  `failMemoS` and the breaker all apply. An open breaker skips the poll.
- **Hours:** `TIMELAPSE.hours` (06:30 to 00:30 Singapore time), and only
  services inside their own operating hours. It stops early when no bus
  is out.
- **Kill switch:** KV `config:timelapse` = `off` stops it within a round,
  without a deploy. Otherwise the `TIMELAPSE_ENABLED` var applies: on for
  the stable site, off for the beta, off when unset.

- **Back-off:** after a round in which no service answered, the next
  waits 2, 4, then 8 times as long.

At most 17,280 polls a day (`TIMELAPSE.maxPollsPerDay`, enforced in
code: more routes in `stops.json` lengthen the interval), and every
request counted on the dashboard (a retry inside a poll too). Don't add another poller, don't widen this one's
hours or rate, don't point it at arrivals or LTA, and don't reuse its
alarm for anything else that calls NUS.

## The crons and the Trip objects

A few other scheduled calls exist, small and bounded; don't grow them.
The stable Worker's 15-minute cron health check asks NUS for one stop
and LTA for one stop each run, past the cache on purpose
(`src/ops/monitor.ts`). While NUS refuses our uNivUS version, the same check
reads Google Play at most hourly and tries at most three new version
strings on that stop per run, ten per release, never one twice
(`src/feeds/appversion.ts`). The beta's cron makes no health check: it reads
the breakers its own traffic opened (`src/feeds/feedwatch.ts`), and runs
the version search only while NUS is refusing the beta. Both crons
mint a new guest token while the kept one is still good with under
half its lifetime left (`renewToken` in `src/feeds/fms.ts`), trying
each run until one works, but not again for a token whose renewal NUS
refused for its version or key (`auth:renewRefused`): at most two a day
(`auth:renewed`). Each push
user's Trip object (`src/push/tripdo.ts`) wakes at most every 30 s to
recompute the card, asking for its stops through the cache.
