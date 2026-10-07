/**
 * terminus -- answers one question: when is my bus, and should I run.
 *
 * Fetch-on-demand with a 15-second edge cache; no poll loop for answers.
 * Workers has no long-lived process and Cron Triggers bottom out at
 * one-minute granularity. The one poller of the feed is the timelapse
 * recorder (timelapse.ts): a Durable Object on its own alarm, at most one
 * call per service per 30 s, through the same cache, inside fixed hours,
 * behind a kill switch. It is the exception, not a pattern to copy. The
 * cron's health check (monitor.ts) and each push user's Trip object
 * (tripdo.ts) also read on a schedule, a call or a card at a time.
 */


import type { Env, ResolveInput } from './types.ts';
import { sgt } from './config.ts';
import { venueAt, venueToStop } from './nusmods.ts';
import { appVersion, authConfigured, getSession } from './auth.ts';
import { candidates, lookUp, parseVersion, versionString } from './appversion.ts';
import { fmsConfigured, getBuses } from './fms.ts';
import { shortStop } from './format.ts';
import { boardAt, displayName, indexGraph, serviceEndsAt, serviceResumesAt, stoppedReason } from './resolve.ts';
import { buildCampusMap, buildDestinations, ROUTE_COLORS } from './campus.ts';
import { busesOnLine, lineStops, trackedBuses } from './buses.ts';
import { stopPairs } from './pairs.ts';
import { adminStats, isOperator } from './admin.ts';
import { analyticsEnabled, logError } from './analytics.ts';
import { docsPage, openApiSpec } from './openapi.ts';
import { phaseAt, sgtMinute } from './pagesky.ts';
import { CORS, clientKey, coordsFrom, json, jsonCached, numParam, withSecurityHeaders } from './http.ts';
import { type MeDeps, handleMe } from './me.ts';
import { accountsConfigured } from './accounts.ts';
import { readIncidents, readPublicFeed, readUpstream, runCron } from './monitor.ts';
import { ltaConfigured } from './lta.ts';
import { calendarThrough } from './calendar.ts';
import { llmsTxt, robotsTxt, SITEMAP } from './seo.ts';
import { calendarSource, loadCalendar } from './calendarsync.ts';
import { handleDownload } from './downloads.ts';
import { landingPage } from './landing.ts';
import { handleMap, matchesEtag } from './map.ts';
import { landmark, targetStops } from './landmarks.ts';
import { allResidences, residenceWalkMin } from './residences.ts';
import { callerFor } from './access.ts';
import { fcmEnabled } from './push.ts';
import { webPushEnabled } from './webpush.ts';
import { handleTimelapse } from './timelapse.ts';
import { scopeCache } from './edgecache.ts';

import { GRAPH, GRAPH_PUBLIC, twinOf } from './graph.ts';
import { isBeta, markBeta, siteOrigin } from './site.ts';
import { answerFor, arrivedAnswer, collectArrivals, needsSetupAnswer } from './answer.ts';
import { langOfRequest, m, withLang } from './i18n.ts';

// Pure functions of the static GRAPH -- computed once per isolate, served
// with a long client cache, same spirit as GRAPH itself.
const CAMPUS_MAP = buildCampusMap(GRAPH);
const DESTINATIONS = buildDestinations(GRAPH);
const STOP_PAIRS = stopPairs(GRAPH);
// For "Where do you live?": names and stops only. The outlines stay here.
// The common ones come first, so a client matching home stops back to a
// residence (every UTown college shares UTOWN) lands on the likelier one.
const RESIDENCE_LIST = allResidences()
  .map(([code, r]) => ({ code, name: r.name, stops: Object.keys(r.stops), walkM: Object.values(r.stops)[0], walkMin: residenceWalkMin(Object.values(r.stops)[0]), common: r.common === true }))
  .sort((a, b) => Number(b.common) - Number(a.common) || a.name.localeCompare(b.name));

export { GRAPH, answerFor, arrivedAnswer, collectArrivals, coordsFrom, numParam };
// The trip engine's Durable Object (one per user), bound as TRIPS.
export { Trip } from './tripdo.ts';
// The timelapse recorder (one per Singapore day), bound as TIMELAPSE.
export { TimelapseRecorder } from './timelapsedo.ts';

/** `?to=` as a stop code or a NUSMods venue code; `?from=` as an origin stop. */
function resolveDestination(url: URL) {
  const idx = indexGraph(GRAPH);
  const raw = url.searchParams.get('to')?.trim().toUpperCase() || null;
  const fromRaw = url.searchParams.get('from')?.trim().toUpperCase() || null;
  const from = fromRaw && idx.byCode.has(fromRaw) ? fromRaw : null;
  if (!raw) return null;

  const stop = idx.byCode.get(raw);
  // Abbreviated like every other stop name ("Information Technology" -> "IT").
  if (stop) return { to: stop.code, also: [] as string[], from, label: shortStop(stop.name, 14), at: null };
  const lm = landmark(raw);
  if (lm) {
    const t = targetStops(raw);
    return { to: t.to, also: t.also, from, label: lm.name, at: null };
  }

  // A room or building: where it is too, so standing in it counts as there.
  const venue = venueToStop(raw);
  if (venue) return { to: venue.stop, also: [] as string[], from, label: raw.split('-')[0], at: venueAt(raw) };
  return null;
}

async function handleNext(url: URL, env: Env, ctx: ExecutionContext, nowMs: number): Promise<Response> {
  const { lat, lon } = coordsFrom(url);

  const dest = resolveDestination(url);
  const to = dest?.to ?? null;
  const originCode = dest?.from ?? null;

  // Nothing to work with: no location and no destination. Rather
  // than fabricate a trip, tell the user how to get an answer.
  if (lat === null && to === null && originCode === null) {
    return json(needsSetupAnswer(nowMs));
  }

  // With coordinates but no destination, `to` stays null and the resolver
  // simply reports the next buses at the nearest stop. `?public=1` counts
  // the public buses too, as an account's `publicBuses` does for /me/next.
  const input: ResolveInput = { lat, lon, to, toAlso: dest?.also, originCode, destAt: dest?.at ?? null, ...(url.searchParams.get('public') === '1' ? { publicBuses: true } : {}) };
  return json(await answerFor(env, ctx, input, dest?.label ?? null, nowMs));
}

async function handleTrip(url: URL, env: Env, ctx: ExecutionContext, nowMs: number): Promise<Response> {
  const dest = resolveDestination(url);
  if (!dest) return json({ error: 'unknown destination: pass ?to= a stop or venue code' }, 400);
  const { lat, lon } = coordsFrom(url);
  if (lat === null && !dest.from) {
    return json({ error: 'pass lat and lon, or ?from= a stop code' }, 400);
  }
  return json(await answerFor(env, ctx, { lat, lon, to: dest.to, toAlso: dest.also, originCode: lat === null ? dest.from : null, destAt: dest.at }, dest.label, nowMs));
}

/**
 * `?probe=1` attempts a real token mint and reports what came back.
 *
 * Two of this project's values were guesses for a long time and each wrong
 * guess cost a redeploy cycle to diagnose. This makes that one request. It
 * never returns the token, and it goes through the ordinary cached path, so
 * hammering it does not hammer upstream.
 */
async function probeAuth(env: Env, nowMs: number): Promise<Record<string, unknown>> {
  if (!authConfigured(env)) return { ok: false, reason: 'auth not configured' };

  // Goes through the ORDINARY cached path. An earlier version minted a fresh
  // token on every call, which turned a debugging session into roughly a dozen
  // mints a minute and started drawing intermittent 400s from upstream. A
  // debug endpoint that can be turned into a hammer is a bad debug endpoint.
  const before = await env.KV.get('auth:session').catch(() => null);
  try {
    const s = await getSession(env, nowMs);
    return { ok: true, cached: Boolean(before), domain: s.domain, expiresIn: `${Math.round((s.expMs - nowMs) / 3600_000)}h` };
  } catch (err) {
    // getSession reports the HTTP status, the envelope code, or the first 80
    // bytes of a non-JSON body, so this message is usually the whole story.
    return { ok: false, cached: Boolean(before), reason: (err as Error).message };
  }
}

/**
 * GET /campus -- static map + search data for the Map and Plan tabs. Pure
 * function of the bundled stop graph: it only changes when a deploy ships a
 * new scrape. So it's written once per isolate, with an ETag of its own
 * bytes, and a client that already has it (the browser revalidating after
 * max-age) gets a 304 instead of the 100 KB again.
 */
let campusBody: Promise<{ body: string; etag: string }> | null = null;

async function handleCampus(req: Request): Promise<Response> {
  campusBody ??= (async () => {
    const body = JSON.stringify({ viewBox: CAMPUS_MAP.viewBox, stops: CAMPUS_MAP.stops, routes: CAMPUS_MAP.routes, destinations: DESTINATIONS, residences: RESIDENCE_LIST });
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body)));
    return { body, etag: `"${Array.from(digest.slice(0, 12)).map((b) => b.toString(16).padStart(2, '0')).join('')}"` };
  })();
  const { body, etag } = await campusBody;
  const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, max-age=3600', etag, ...CORS };
  if (matchesEtag(req, etag)) return new Response(null, { status: 304, headers });
  return new Response(body, { headers });
}

/**
 * GET /arrivals?stop=<code> -- what is coming at one stop, for the map's
 * tap-a-stop popover. Goes through the same per-stop 15s edge cache as
 * /next, so a map open does not cost more than checking that one stop would
 * on its own -- there is no bulk "every stop at once" fetch anywhere.
 */
async function handleArrivals(url: URL, env: Env, ctx: ExecutionContext, nowMs: number): Promise<Response> {
  const code = url.searchParams.get('stop')?.trim().toUpperCase() || '';
  // `?public=1`, or a stop only public buses call at (LTA's code): the board
  // with the public buses on it.
  const graph = url.searchParams.get('public') === '1' || !indexGraph(GRAPH).byCode.has(code) ? GRAPH_PUBLIC : GRAPH;
  const idx = indexGraph(graph);
  const stop = idx.byCode.get(code);
  if (!stop) return json({ error: 'unknown stop', stop: code }, 400);

  // Same failure handling as /next: a rejected fetch means "we never reached
  // the feed", not "no bus is coming" -- those are different answers, and
  // /next never lets this surface as a 500, so /arrivals must not either.
  const sa = (await collectArrivals(env, ctx, [code], nowMs, graph)).get(code)!;
  // `?stopped=1`: the services not running now too, for the Buses tab.
  const board = boardAt(graph, idx, code, sa, nowMs, { stopped: url.searchParams.get('stopped') === '1' });
  return json({
    // Its twin, for "This side | Across the road" (or the twin's name, when
    // it's only near rather than across).
    stop: { code: stop.code, name: stop.name, longName: displayName(stop, stop.code), ...twinOf(stop, idx.byCode) },
    board,
    asOf: new Date(sa.stale ? sa.fetchedAt : nowMs).toISOString(),
    available: sa.available,
  });
}

/**
 * GET /buses?svc=<service> -- where that service's buses are now, for the
 * map. One upstream call per service per 5 s however many people watch it
 * (getBuses). Like /arrivals, an unreachable feed is `available: false`, not
 * an error and not "no buses".
 */
async function handleBuses(url: URL, env: Env, ctx: ExecutionContext, nowMs: number): Promise<Response> {
  const svc = url.searchParams.get('svc')?.trim().toUpperCase() || '';
  if (!GRAPH.routes?.[svc]) return json({ error: 'unknown service', svc }, 400);
  const live = await getBuses(env, ctx, svc, nowMs).catch(() => null);
  return json({
    svc,
    color: ROUTE_COLORS[svc] ?? null,
    buses: live ? await trackedBuses(GRAPH, svc, live, ctx) : [],
    asOf: new Date(live?.stale ? live.fetchedAt : nowMs).toISOString(),
    available: Boolean(live),
    stale: Boolean(live?.stale),
  }, 200, { 'cache-control': 'private, max-age=5' });
}

/**
 * GET /line?svc=<service>[&stop=<code>] -- one service's whole line, for a
 * service's page: its stops in route order, its buses placed on that list,
 * and with `stop`, that service's board row there. Costs what /buses does,
 * plus one /arrivals read with `stop`, both through their caches. No times
 * are worked out for the other stops: only the feed's own are shown.
 */
async function handleLine(url: URL, env: Env, ctx: ExecutionContext, nowMs: number): Promise<Response> {
  const svc = url.searchParams.get('svc')?.trim().toUpperCase() || '';
  if (!GRAPH.routes?.[svc]) return json({ error: 'unknown service', svc }, 400);
  const idx = indexGraph(GRAPH);
  const route = idx.routes.get(svc)!;
  const code = url.searchParams.get('stop')?.trim().toUpperCase() || '';
  const index = code ? (route.pos.get(code)?.[0] ?? null) : null;
  if (code && index === null) return json({ error: 'stop not on this service', svc, stop: code }, 400);

  const [live, sa] = await Promise.all([
    getBuses(env, ctx, svc, nowMs).catch(() => null),
    // A rejected fetch is "never reached the feed", as on /arrivals.
    code ? collectArrivals(env, ctx, [code], nowMs, GRAPH).then((m) => m.get(code)) : Promise.resolve(undefined),
  ]);
  const placed = live ? await trackedBuses(GRAPH, svc, live, ctx) : [];
  const ends = serviceEndsAt(GRAPH, svc, nowMs);
  // A bus out on the line runs, whatever the hours say: the feed is the
  // truth and the hours a hint, as on a board, so the page never says
  // "Stopped" over a moving bus.
  const stopped = placed.length ? null : stoppedReason(GRAPH, svc, nowMs);
  const resumes = stopped ? serviceResumesAt(GRAPH, svc, nowMs) : null;
  return json({
    svc,
    color: ROUTE_COLORS[svc] ?? null,
    endsAt: ends === null ? null : new Date(ends).toISOString(),
    // By its hours unless a bus is out; `stopped` and `resumesAt` are null while it runs.
    running: stopped === null,
    stopped,
    resumesAt: resumes === null ? null : new Date(resumes).toISOString(),
    stops: lineStops(idx, svc),
    buses: busesOnLine(route.seq, route.loop, placed),
    ...(code ? { stop: { code, index, row: boardAt(GRAPH, idx, code, sa, nowMs, { stopped: true }).find((r) => r.svc === svc) ?? null } } : {}),
    available: Boolean(live),
    asOf: new Date(live?.stale ? live.fetchedAt : nowMs).toISOString(),
  }, 200, { 'cache-control': 'private, max-age=5' });
}

/**
 * A page of the website. One that isn't there, asked for by a browser, is
 * the not-found page (web/public/not-found/), still with a 404; anything
 * else, a script or a client, gets what the website answered.
 */
async function sitePage(req: Request, assets: Fetcher): Promise<Response> {
  const res = await assets.fetch(req);
  if (res.status !== 404 || !(req.headers.get('accept') ?? '').includes('text/html')) return res;
  const page = await assets.fetch(new Request(new URL('/not-found/', req.url), { headers: req.headers }));
  if (!page.ok) return res;
  return new Response(page.body, { status: 404, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}

/** The cron runs every 15 minutes; older than this and it has stopped. */
const CRON_STALE_MS = 40 * 60_000;

/**
 * The public status page's data: whether NUS's live feed is answering, as
 * the cron sees it, and recent outages. Causes are a kind, never NUS's error.
 */
async function handleStatus(env: Env, nowMs: number): Promise<Response> {
  const [u, incidents, pub] = await Promise.all([readUpstream(env), readIncidents(env), readPublicFeed(env)]);
  const iso = (ms: number | null) => (ms == null ? null : new Date(ms).toISOString());
  return json(
    {
      feed: u ? (u.up ? 'up' : 'down') : 'unknown',
      since: u ? iso(u.since) : null,
      checkedAt: u ? iso(u.checkedAt) : null,
      // Checks every 15 minutes; if they've stopped, what's above is old news.
      checking: u ? nowMs - u.checkedAt <= CRON_STALE_MS : false,
      incidents: incidents.map((i) => ({ start: iso(i.start), end: iso(i.end), cause: i.cause })),
      // LTA DataMall, for the public buses: extra, so no incidents and no alerts.
      publicFeed: pub ? (pub.up ? 'up' : 'down') : 'unknown',
      publicSince: pub ? iso(pub.since) : null,
    },
    200,
    { 'cache-control': 'public, max-age=60' },
  );
}

async function handleHealth(req: Request, url: URL, env: Env, nowMs: number): Promise<Response> {
  const idx = indexGraph(GRAPH);
  const t = sgt(nowMs);
  const u = await readUpstream(env);
  const cronStale = u ? nowMs - u.checkedAt > CRON_STALE_MS : null;
  const through = calendarThrough();
  const daysLeft = Math.floor((Date.parse(`${through}T00:00:00Z`) - nowMs) / 86_400_000);
  // Unhealthy means something an operator must act on. No record yet (a
  // fresh deploy before the first cron run) is not that.
  const ok = u?.up !== false && cronStale !== true && daysLeft > 0;
  // The probe spends an upstream call, so only the operator gets it.
  const operator = isOperator(env, req);
  const probe = operator && url.searchParams.get('probe') === '1';
  // Reads the Play and APKCombo pages (no NUS calls), to see what the
  // automatic version update would find today.
  const versions = operator && url.searchParams.get('versions') === '1';
  return json(
    {
      ok,
      now: new Date(nowMs).toISOString(),
      sgt: `${String(t.hour).padStart(2, '0')}:${String(t.minutes % 60).padStart(2, '0')} day${t.day}`,
      graph: {
        generated: GRAPH.generated,
        source: (GRAPH as unknown as { source?: string }).source ?? 'unknown',
        stops: GRAPH.stops.length,
        services: [...idx.routes.keys()],
      },
      calendar: { through, daysLeft, source: calendarSource() },
      // Presence only. Never the values.
      config: {
        auth: authConfigured(env),
        proxy: fmsConfigured(env),
        publicBuses: ltaConfigured(env),
        analytics: analyticsEnabled(env),
        accounts: accountsConfigured(env),
        email: Boolean(env.EMAIL && env.EMAIL_FROM),
        alerts: Boolean(env.EMAIL && env.EMAIL_FROM && env.ALERT_EMAIL),
        // Set and usable: a secret that won't parse turns that push off.
        pushAndroid: fcmEnabled(env),
        pushWeb: webPushEnabled(env),
      },
      // From the cron probe: whether the NUS feed answered, and since when.
      upstream: u ? { up: u.up, since: new Date(u.since).toISOString(), checkedAt: new Date(u.checkedAt).toISOString(), cronStale } : null,
      auth: probe ? await probeAuth(env, nowMs) : undefined,
      versions: versions ? await versionLookup(env, nowMs) : undefined,
    },
    ok ? 200 : 503,
  );
}

async function versionLookup(env: Env, nowMs: number): Promise<Record<string, unknown>> {
  const current = await appVersion(env, nowMs);
  const found = await lookUp();
  const cur = parseVersion(current);
  return {
    current,
    play: found.play,
    apkcombo: found.apkcombo ? versionString(found.apkcombo) : null,
    errors: found.errors,
    wouldTry: cur ? candidates(cur, { refusal: [], ...found }).map(versionString) : [],
  };
}

const ME_DEPS: MeDeps = { graph: GRAPH, publicGraph: GRAPH_PUBLIC, answerFor, collectArrivals };

/** Routes that need an API key or a signed-in account. */
const KEYED = ['/next', '/trip', '/arrivals', '/buses', '/line', '/campus', '/stops/pairs'];

export default {
  async scheduled(_event: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    scopeCache(env);
    // Awaited, not left to waitUntil: a run that outlives the handler could be
    // cut off partway, with the trigger's history still saying it succeeded.
    await runCron(env, Date.now());
  },

  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    scopeCache(env);
    // Every word the server writes is in this request's language (i18n.ts).
    const res = await withLang(langOfRequest(req), () => route(req, env, ctx));
    // A redirect or a download body passes through untouched apart from headers.
    return withSecurityHeaders(res, new URL(req.url).pathname);
  },
};

async function route(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(req.url);
  const nowMs = Date.now();

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  // The calendar the cron keeps fresh in KV (calendarsync.ts), read every few minutes.
  await loadCalendar(env, nowMs);

  try {
    const me = await handleMe(req, url, env, ctx, nowMs, ME_DEPS);
    if (me) return me;
    // Public routes: a per-IP ceiling. The per-stop cache already protects
    // NUS; this protects the Worker from being a free proxy, and D1/R2 from
    // being a free bill.
    const keyed = KEYED.includes(url.pathname);
    if (env.RL_PUBLIC && (url.pathname === '/health' || url.pathname === '/status.json' || url.pathname === '/admin/stats' || url.pathname.startsWith('/download/') || url.pathname.startsWith('/timelapse/'))) {
      const { success } = await env.RL_PUBLIC.limit({ key: `pub:${clientKey(req)}` });
      if (!success) return json({ error: 'too many requests, slow down' }, 429, { 'retry-after': '60' });
    }
    // The answers need an API key or a signed-in account, and are limited
    // by who's asking: on campus Wi-Fi hundreds of students share one IP,
    // and the map alone asks every 5 s. A key has its own ceiling wherever
    // it's used from; a request with neither is limited by IP.
    if (keyed) {
      const caller = await callerFor(env, req, nowMs, ctx);
      const bucket =
        caller?.kind === 'key' ? { rl: env.RL_PUBLIC, key: `key:${caller.keyId}` }
        : caller?.kind === 'account' ? { rl: env.RL_ME, key: `acct:${caller.userId}` }
        : { rl: env.RL_PUBLIC, key: `pub:${clientKey(req)}` };
      if (bucket.rl && !(await bucket.rl.limit({ key: bucket.key })).success) {
        return json({ error: caller?.kind === 'key' ? 'too many requests for this key, slow down' : 'too many requests, slow down' }, 429, { 'retry-after': '60' });
      }
      if (!caller) {
        return json({ error: m().needsKey(siteOrigin(env)) }, 401, {
          'www-authenticate': 'Bearer realm="terminus"',
        });
      }
    }
    const dl = await handleDownload(url.pathname, env, url);
    if (dl) return dl;
    // A recorded day of buses: operator only, like /admin/stats.
    const timelapse = await handleTimelapse(req, url, env, nowMs);
    if (timelapse) return timelapse;
    // The street map: open like the website, and served from R2 or built.
    const map = await handleMap(req, url, env, ctx);
    if (map) return map;

    switch (url.pathname) {
      case '/docs':
        // The landing page at / is a static asset (apps/web). The beta's
        // docs, like its pages, ask not to be indexed.
        return new Response(docsPage(phaseAt(sgtMinute(nowMs))), {
          headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=300', ...(isBeta(env) ? { 'x-robots-tag': 'noindex' } : {}) },
        });
      case '/robots.txt':
        return new Response(robotsTxt(env), { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=3600' } });
      case '/llms.txt':
        return new Response(llmsTxt(url.origin), { headers: { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'public, max-age=3600' } });
      case '/sitemap.xml':
        if (isBeta(env)) return json({ error: 'not found' }, 404);
        return new Response(SITEMAP, { headers: { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, max-age=3600' } });
      case '/openapi.json':
        // servers[] is this request's origin, so the docs' "Send API Request"
        // hits whichever deployment is serving them.
        return jsonCached(openApiSpec(url.origin), 300);
      case '/next':
        return await handleNext(url, env, ctx, nowMs);
      case '/trip':
        return await handleTrip(url, env, ctx, nowMs);
      case '/health':
        return await handleHealth(req, url, env, nowMs);
      case '/status.json':
        return await handleStatus(env, nowMs);
      case '/admin/stats':
        // The dashboard's data: operator only, never cached.
        if (!isOperator(env, req)) return json({ error: 'not found' }, 404);
        return json(await adminStats(env, nowMs), 200, { 'cache-control': 'no-store' });
      case '/campus':
        return await handleCampus(req);
      case '/stops/pairs':
        // Static like /campus: changes only with a new scrape.
        return jsonCached(STOP_PAIRS, 3600, 'private');
      case '/arrivals':
        return await handleArrivals(url, env, ctx, nowMs);
      case '/buses':
        return await handleBuses(url, env, ctx, nowMs);
      case '/line':
        return await handleLine(url, env, ctx, nowMs);
      default:
        // Everything else is the website; the landing page with its version and account link.
        if (env.ASSETS && (req.method === 'GET' || req.method === 'HEAD')) {
          if (url.pathname === '/') return markBeta(await landingPage(req, env.ASSETS, env, nowMs, ctx), env);
          return markBeta(await sitePage(req, env.ASSETS), env);
        }
        return json({ error: 'not found' }, 404);
    }
  } catch (err) {
    // Logged, because a caught error never shows up as an exception in the
    // dashboard. The path only: the query can hold coordinates.
    console.error('unhandled', req.method, url.pathname, err instanceof Error ? (err.stack ?? err.message) : String(err));
    logError(env, url.pathname);
    return json({ error: 'internal' }, 500);
  }
}
