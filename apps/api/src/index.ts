/**
 * terminus -- answers one question: when is my bus, and should I run.
 *
 * Fetch-on-demand with a 15-second edge cache; no poll loop. Workers has no
 * long-lived process and Cron Triggers bottom out at one-minute granularity.
 * A Durable Object alarm could force sub-minute polling, but that means paying
 * to keep a DO pinned all day to serve a handful of taps.
 */


import type { Env, ResolveInput, StopArrivals } from './types.ts';
import { sgt } from './config.ts';
import { venueToStop } from './nusmods.ts';
import { appVersion, authConfigured, getSession } from './auth.ts';
import { candidates, lookUp, parseVersion, versionString } from './appversion.ts';
import { fmsConfigured, getArrivals, getBuses } from './fms.ts';
import { shortStop } from './format.ts';
import { boardAt, indexGraph } from './resolve.ts';
import { buildCampusMap, buildDestinations, ROUTE_COLORS } from './campus.ts';
import { placeBuses } from './buses.ts';
import { stopPairs } from './pairs.ts';
import { adminStats, isOperator } from './admin.ts';
import { analyticsEnabled, logError } from './analytics.ts';
import { DOCS_PAGE, openApiSpec } from './openapi.ts';
import { CORS, clientKey, coordsFrom, json, jsonCached, numParam, withSecurityHeaders } from './http.ts';
import { type MeDeps, handleMe } from './me.ts';
import { accountsConfigured } from './accounts.ts';
import { readIncidents, readUpstream, runCron } from './monitor.ts';
import { calendarThrough } from './calendar.ts';
import { handleDownload } from './downloads.ts';
import { handleMap } from './map.ts';
import { landmark, targetStops } from './landmarks.ts';
import { allResidences } from './residences.ts';
import { callerFor } from './access.ts';

import { GRAPH } from './graph.ts';
import { markBeta, siteOrigin } from './site.ts';
import { answerFor, arrivedAnswer, collectArrivals, needsSetupAnswer } from './answer.ts';
import { langOfRequest, m, withLang } from './i18n.ts';

// Pure functions of the static GRAPH -- computed once per isolate, served
// with a long client cache, same spirit as GRAPH itself.
const CAMPUS_MAP = buildCampusMap(GRAPH);
const DESTINATIONS = buildDestinations(GRAPH);
const STOP_PAIRS = stopPairs(GRAPH);
// For "Where do you live?": names and stops only. The outlines stay here.
const RESIDENCE_LIST = allResidences().map(([code, r]) => ({ code, name: r.name, stops: Object.keys(r.stops), walkM: Object.values(r.stops)[0] }));

export { GRAPH, answerFor, arrivedAnswer, collectArrivals, coordsFrom, numParam };
// The trip engine's Durable Object (one per user), bound as TRIPS.
export { Trip } from './tripdo.ts';

/** `?to=` as a stop code or a NUSMods venue code; `?from=` as an origin stop. */
function resolveDestination(url: URL) {
  const idx = indexGraph(GRAPH);
  const raw = url.searchParams.get('to')?.trim().toUpperCase() || null;
  const fromRaw = url.searchParams.get('from')?.trim().toUpperCase() || null;
  const from = fromRaw && idx.byCode.has(fromRaw) ? fromRaw : null;
  if (!raw) return null;

  const stop = idx.byCode.get(raw);
  // Abbreviated like every other stop name ("Information Technology" -> "IT").
  if (stop) return { to: stop.code, also: [] as string[], from, label: shortStop(stop.name, 14) };
  const lm = landmark(raw);
  if (lm) {
    const t = targetStops(raw);
    return { to: t.to, also: t.also, from, label: lm.name };
  }

  const venue = venueToStop(raw);
  if (venue) return { to: venue.stop, also: [] as string[], from, label: raw.split('-')[0] };
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
  // simply reports the next buses at the nearest stop.
  const input: ResolveInput = { lat, lon, to, toAlso: dest?.also, originCode };
  return json(await answerFor(env, ctx, input, dest?.label ?? null, nowMs));
}

async function handleTrip(url: URL, env: Env, ctx: ExecutionContext, nowMs: number): Promise<Response> {
  const dest = resolveDestination(url);
  if (!dest) return json({ error: 'unknown destination: pass ?to= a stop or venue code' }, 400);
  const { lat, lon } = coordsFrom(url);
  if (lat === null && !dest.from) {
    return json({ error: 'pass lat and lon, or ?from= a stop code' }, 400);
  }
  return json(await answerFor(env, ctx, { lat, lon, to: dest.to, toAlso: dest.also, originCode: lat === null ? dest.from : null }, dest.label, nowMs));
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
 * function of the bundled stop graph, so it is cheap to cache hard: it only
 * changes when a deploy ships a new scrape, same as the graph itself.
 */
function handleCampus(): Response {
  return jsonCached({ viewBox: CAMPUS_MAP.viewBox, stops: CAMPUS_MAP.stops, routes: CAMPUS_MAP.routes, destinations: DESTINATIONS, residences: RESIDENCE_LIST }, 3600, 'private');
}

/**
 * GET /arrivals?stop=<code> -- what is coming at one stop, for the map's
 * tap-a-stop popover. Goes through the same per-stop 15s edge cache as
 * /next, so a map open does not cost more than checking that one stop would
 * on its own -- there is no bulk "every stop at once" fetch anywhere.
 */
async function handleArrivals(url: URL, env: Env, ctx: ExecutionContext, nowMs: number): Promise<Response> {
  const code = url.searchParams.get('stop')?.trim().toUpperCase() || '';
  const idx = indexGraph(GRAPH);
  const stop = idx.byCode.get(code);
  if (!stop) return json({ error: 'unknown stop', stop: code }, 400);

  // Same failure handling as collectArrivals(): a rejected fetch means "we
  // never reached the feed", not "no bus is coming" -- those are different
  // answers, and /next never lets this surface as a 500, so /arrivals must
  // not either.
  const sa = await getArrivals(env, ctx, code, nowMs).catch(
    () => ({ code, arrivals: [], fetchedAt: nowMs, stale: false, available: false }) as StopArrivals,
  );
  const board = boardAt(GRAPH, idx, code, sa, nowMs);
  return json({
    stop: { code: stop.code, name: stop.name },
    board,
    asOf: new Date(sa.stale ? sa.fetchedAt : nowMs).toISOString(),
    available: sa.available,
  });
}

/**
 * GET /buses?svc=<service> -- where that service's buses are now, for the
 * map. One upstream call per service per 10s however many people watch it
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
    buses: live ? await placeBuses(GRAPH, svc, live.buses) : [],
    asOf: new Date(live?.stale ? live.fetchedAt : nowMs).toISOString(),
    available: Boolean(live),
    stale: Boolean(live?.stale),
  }, 200, { 'cache-control': 'private, max-age=5' });
}

/** The cron runs every 15 minutes; older than this and it has stopped. */
const CRON_STALE_MS = 40 * 60_000;

/**
 * The public status page's data: whether NUS's live feed is answering, as
 * the cron sees it, and recent outages. Causes are a kind, never NUS's error.
 */
async function handleStatus(env: Env, nowMs: number): Promise<Response> {
  const [u, incidents] = await Promise.all([readUpstream(env), readIncidents(env)]);
  const iso = (ms: number | null) => (ms == null ? null : new Date(ms).toISOString());
  return json(
    {
      feed: u ? (u.up ? 'up' : 'down') : 'unknown',
      since: u ? iso(u.since) : null,
      checkedAt: u ? iso(u.checkedAt) : null,
      // Checks every 15 minutes; if they've stopped, what's above is old news.
      checking: u ? nowMs - u.checkedAt <= CRON_STALE_MS : false,
      incidents: incidents.map((i) => ({ start: iso(i.start), end: iso(i.end), cause: i.cause })),
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
      calendar: { through, daysLeft },
      // Presence only. Never the values.
      config: {
        auth: authConfigured(env),
        proxy: fmsConfigured(env),
        analytics: analyticsEnabled(env),
        accounts: accountsConfigured(env),
        email: Boolean(env.EMAIL && env.EMAIL_FROM),
        alerts: Boolean(env.EMAIL && env.EMAIL_FROM && env.ALERT_EMAIL),
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

const ME_DEPS: MeDeps = { graph: GRAPH, answerFor, collectArrivals };

/** Routes that need an API key or a signed-in account. */
const KEYED = ['/next', '/trip', '/arrivals', '/buses', '/campus', '/stops/pairs'];

export default {
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runCron(env, Date.now()));
  },

  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
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

    try {
      const me = await handleMe(req, url, env, ctx, nowMs, ME_DEPS);
      if (me) return me;
      // Public routes: a per-IP ceiling. The per-stop cache already protects
      // NUS; this protects the Worker from being a free proxy, and D1/R2 from
      // being a free bill.
      if (env.RL_PUBLIC && (KEYED.includes(url.pathname) || url.pathname === '/health' || url.pathname === '/status.json' || url.pathname === '/admin/stats' || url.pathname.startsWith('/download/'))) {
        const { success } = await env.RL_PUBLIC.limit({ key: `pub:${clientKey(req)}` });
        if (!success) return json({ error: 'too many requests, slow down' }, 429, { 'retry-after': '60' });
      }
      // The answers need an API key or a signed-in account.
      if (KEYED.includes(url.pathname)) {
        const caller = await callerFor(env, req, nowMs, ctx);
        if (!caller) {
          return json({ error: m().needsKey(siteOrigin(env)) }, 401, {
            'www-authenticate': 'Bearer realm="terminus"',
          });
        }
        // And a ceiling per key, wherever it's used from.
        if (caller.kind === 'key' && env.RL_PUBLIC && !(await env.RL_PUBLIC.limit({ key: `key:${caller.keyId}` })).success) {
          return json({ error: 'too many requests for this key, slow down' }, 429, { 'retry-after': '60' });
        }
      }
      const dl = await handleDownload(url.pathname, env);
      if (dl) return dl;
      // The street map: open like the website, and served from R2 or built.
      const map = await handleMap(req, url, env);
      if (map) return map;

      switch (url.pathname) {
        case '/docs':
          // The landing page at / is a static asset (apps/web).
          return new Response(DOCS_PAGE, {
            headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=300' },
          });
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
          return handleCampus();
        case '/stops/pairs':
          // Static like /campus: changes only with a new scrape.
          return jsonCached(STOP_PAIRS, 3600, 'private');
        case '/arrivals':
          return await handleArrivals(url, env, ctx, nowMs);
        case '/buses':
          return await handleBuses(url, env, ctx, nowMs);
        default:
          // Everything else is the website.
          if (env.ASSETS && (req.method === 'GET' || req.method === 'HEAD')) return markBeta(await env.ASSETS.fetch(req), env);
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
