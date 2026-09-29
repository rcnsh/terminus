/**
 * nusbus-edge -- answers one question: when is my bus, and should I run.
 *
 * Fetch-on-demand with a 15-second edge cache; no poll loop. Workers has no
 * long-lived process and Cron Triggers bottom out at one-minute granularity.
 * A Durable Object alarm could force sub-minute polling, but that means paying
 * to keep a DO pinned all day to serve a handful of taps.
 */

import graphJson from '../data/stops.json' with { type: 'json' };
import serviceHoursJson from '../data/service-hours.json' with { type: 'json' };

import type { Answer, Arrival, Env, Graph, ResolveInput, Stop, StopArrivals } from './types.ts';
import { WALK, sgt } from './config.ts';
import {
  decodeTimetable,
  encodeTimetable,
  nextTrip,
  parseShareUrl,
  resolveTrips,
  venueToStop,
  ImportInputError,
} from './nusmods.ts';
import { authConfigured, getSession } from './auth.ts';
import { fmsConfigured, getArrivals } from './fms.ts';
import { buildAnswer, shortStop } from './format.ts';
import {
  boardAt,
  candidateStops,
  confidence,
  haversineM,
  indexGraph,
  mergeServiceHours,
  nearestStop,
  pickAlt,
  scoreOptions,
  walkAllTheWayS,
} from './resolve.ts';
import { buildCampusMap, buildDestinations } from './campus.ts';
import { analyticsEnabled, logAnswer } from './analytics.ts';
import { DOCS_PAGE, openApiSpec } from './openapi.ts';
import { CORS, clientKey, coordsFrom, json, jsonCached, numParam, withSecurityHeaders } from './http.ts';
import { type MeDeps, handleMe } from './me.ts';
import { accountsConfigured } from './accounts.ts';
import { readUpstream, runCron } from './monitor.ts';
import { calendarThrough } from './calendar.ts';
import { handleDownload } from './downloads.ts';
import { leaveBy } from './leave.ts';

// Operating hours are hand-maintained in their own file so `npm run scrape`
// can never overwrite them. Merged once, at module scope.
export const GRAPH = {
  ...(graphJson as unknown as Graph),
  serviceHours: mergeServiceHours(
    (graphJson as unknown as Graph).serviceHours,
    serviceHoursJson as Record<string, unknown>,
  ),
} as Graph;

// Pure functions of the static GRAPH -- computed once per isolate, served
// with a long client cache, same spirit as GRAPH itself.
const CAMPUS_MAP = buildCampusMap(GRAPH);
const DESTINATIONS = buildDestinations(GRAPH);

export { coordsFrom, numParam };

export async function collectArrivals(
  env: Env,
  ctx: ExecutionContext,
  codes: string[],
  nowMs: number,
): Promise<Map<string, StopArrivals>> {
  const settled = await Promise.allSettled(codes.map((c) => getArrivals(env, ctx, c, nowMs)));
  const out = new Map<string, StopArrivals>();
  settled.forEach((r, i) => {
    // A failed stop still gets an entry, marked unavailable. Dropping it here
    // would make "we could not reach the feed" indistinguishable from "the
    // feed says no bus is coming", and the second one gets a headway guess.
    out.set(
      codes[i],
      r.status === 'fulfilled'
        ? r.value
        : { code: codes[i], arrivals: [], fetchedAt: nowMs, stale: false, available: false },
    );
  });
  return out;
}

/** The one function that turns a request into an Answer. */
export async function answerFor(
  env: Env,
  ctx: ExecutionContext,
  input: ResolveInput,
  destLabel: string | null,
  nowMs: number,
  tripKey: string | null = null,
): Promise<Answer> {
  const idx = indexGraph(GRAPH);
  const cands = candidateStops(GRAPH, input);
  const originStop = input.originCode ? (idx.byCode.get(input.originCode) ?? null) : null;
  const fallbackStop = cands[0]?.stop ?? originStop;

  // Already there: two classes in a row at the same stop, or standing at it.
  // Without this the degrade ladder says "Walk · now" and marks it ended.
  const dest = input.to ? idx.byCode.get(input.to) : undefined;
  // Either side of the road counts as there, same as for routing.
  const destSides = dest ? [dest, ...(dest.opposite && idx.byCode.get(dest.opposite) ? [idx.byCode.get(dest.opposite)!] : [])] : [];
  const atDest = destSides.find((d) =>
    input.lat != null
      ? haversineM(input.lat, input.lon!, d.lat, d.lon) / WALK.speedMs < 45
      : input.originCode === d.code,
  );
  if (dest && atDest) return arrivedAnswer(dest, destLabel, nowMs);
  // No coordinates and no origin stop: nothing to resolve from. Saying
  // "No buses running" here would be a claim about the network.
  if (!cands.length) {
    return { ...needsSetupAnswer(nowMs), label: 'No start point', detail: 'Send your location, or a stop to start from' };
  }

  const byStop = await collectArrivals(
    env,
    ctx,
    cands.map((c) => c.stop.code),
    nowMs,
  );

  const options = scoreOptions(GRAPH, cands, byStop, nowMs);
  const alt = pickAlt(options);
  const chosen = options[0]?.stop.code ?? fallbackStop?.code ?? '';
  const arrivals: Arrival[] = byStop.get(chosen)?.arrivals ?? [];

  const walkAllS = walkAllTheWayS(GRAPH, input, fallbackStop);
  const answer = buildAnswer({
    options,
    alt,
    fallbackStop,
    nearestStop: nearestStop(GRAPH, input.lat, input.lon),
    destLabel,
    walkAllS,
    confidence: confidence(options, input.lat != null),
    arrivals,
    nowMs,
  });
  // departsAt null with an arrival time: the answer is to walk.
  const walking = answer.departsAt == null && answer.arriveAt != null;
  answer.leave = leaveBy({
    options,
    candidates: cands,
    byStop,
    graph: GRAPH,
    arriveBy: input.arriveBy,
    walkAllS: walking ? walkAllS : null,
    nowMs,
  });

  // Synchronous, non-blocking, and swallows its own errors. Deliberately not
  // behind waitUntil: there is nothing to await.
  logAnswer(env, {
    answer,
    best: options[0] ?? null,
    dest: input.to,
    tripKey,
    hadCoords: input.lat != null,
    walkAllS,
  });

  return answer;
}

/** `?to=` as a stop code or a NUSMods venue code; `?from=` as an origin stop. */
function resolveDestination(url: URL) {
  const idx = indexGraph(GRAPH);
  const raw = url.searchParams.get('to')?.trim().toUpperCase() || null;
  const fromRaw = url.searchParams.get('from')?.trim().toUpperCase() || null;
  const from = fromRaw && idx.byCode.has(fromRaw) ? fromRaw : null;
  if (!raw) return null;

  const stop = idx.byCode.get(raw);
  // Abbreviated like every other stop name ("Information Technology" -> "IT").
  if (stop) return { to: stop.code, from, label: shortStop(stop.name, 14) };

  const venue = venueToStop(raw);
  if (venue) return { to: venue.stop, from, label: raw.split('-')[0] };
  return null;
}

async function handleNext(url: URL, env: Env, ctx: ExecutionContext, nowMs: number): Promise<Response> {
  const { lat, lon } = coordsFrom(url);

  // A pasted NUSMods timetable (?tt=) takes priority over the hardcoded
  // time-of-day prior: the destination is "your next class", the origin its
  // home stop when no coordinates are sent.
  const encoded = url.searchParams.get('tt');
  if (encoded) {
    const tt = decodeTimetable(encoded);
    const trip = tt ? nextTrip(tt, nowMs) : null;
    if (trip) {
      const input: ResolveInput = {
        lat,
        lon,
        to: trip.to,
        originCode: lat === null ? tt!.home : null,
      };
      return json(await answerFor(env, ctx, input, trip.label, nowMs, null));
    }
    // Decoded but nothing scheduled ahead: fall through to the prior.
  }

  const dest = resolveDestination(url);
  const to = dest?.to ?? null;
  const originCode = dest?.from ?? null;

  // Nothing to work with: no location, no destination, no timetable. Rather
  // than fabricate a trip, tell the user how to get an answer.
  if (lat === null && to === null && originCode === null) {
    return json(needsSetupAnswer(nowMs));
  }

  // With coordinates but no destination, `to` stays null and the resolver
  // simply reports the next buses at the nearest stop.
  const input: ResolveInput = { lat, lon, to, originCode };
  return json(await answerFor(env, ctx, input, dest?.label ?? null, nowMs));
}

/** You are at the destination's stop. `live` because it is a current,
 *  certain answer, even though no bus data was needed for it. */
export function arrivedAnswer(stop: Stop, destLabel: string | null, nowMs: number): Answer {
  return {
    label: "You're here",
    detail: destLabel && destLabel !== stop.name && destLabel !== shortStop(stop.name, 14) ? `${destLabel} is at ${stop.name}` : `You're at ${stop.name}`,
    alt: null,
    stop: { code: stop.code, name: stop.name, confidence: 1 },
    quality: 'live',
    asOf: new Date(nowMs).toISOString(),
    arrivals: [],
    arrived: true,
    leave: null,
  };
}

/** Honest zero-config answer when we have no location, destination or
 *  timetable to resolve. Not an error, and not a fake bus. */
function needsSetupAnswer(nowMs: number): Answer {
  return {
    label: 'Set up',
    detail: 'Send lat/lon for nearby buses, or a timetable (?tt=) from /import',
    alt: null,
    stop: { code: '', name: '', confidence: 0 },
    quality: 'unknown',
    asOf: new Date(nowMs).toISOString(),
    arrivals: [],
  };
}

/**
 * GET /import?share=<nusmods url>&home=<stop code>
 *
 * Stateless: returns the user's personal /next link with the whole timetable
 * encoded into it. Nothing is stored. `home` is optional but needed for any
 * call made without coordinates.
 */
async function handleImport(url: URL, env: Env, nowMs: number): Promise<Response> {
  const share = url.searchParams.get('share');
  if (!share) return json({ error: 'pass ?share=<nusmods share url>' }, 400);

  let parsed;
  try {
    parsed = parseShareUrl(share);
  } catch {
    return json({ error: 'not a valid NUSMods share URL' }, 400);
  }
  if (!parsed.selections.length) return json({ error: 'no modules found in that URL' }, 400);

  const home = url.searchParams.get('home')?.trim().toUpperCase() || null;
  if (home && !indexGraph(GRAPH).byCode.has(home)) {
    return json({ error: `unknown home stop ${home}` }, 400);
  }

  let r;
  try {
    r = await resolveTrips(parsed, nowMs);
  } catch (err) {
    if (err instanceof ImportInputError) return json({ error: err.message }, 400);
    throw err;
  }
  if (r.failed.length) return json({ error: `NUSMods didn't answer for ${r.failed.join(', ')}; try again in a minute`, failed: r.failed }, 502);
  const { trips, unresolved } = r;
  if (!trips.length) {
    return json({ error: 'could not resolve any classes to a stop', unresolved, missing: r.missing }, 422);
  }

  const encoded = encodeTimetable({ home, trips });
  const next = new URL(url);
  next.pathname = '/next';
  next.search = `?tt=${encoded}`;

  return json({
    url: next.toString(),
    path: `/next?tt=${encoded}`,
    home,
    classes: trips.length,
    schedule: trips.map((t) => ({ day: t.day, at: t.arriveByMin, to: t.to, label: t.label })),
    unresolved,
  });
}

async function handleTrip(url: URL, env: Env, ctx: ExecutionContext, nowMs: number): Promise<Response> {
  const dest = resolveDestination(url);
  if (!dest) return json({ error: 'unknown destination: pass ?to= a stop or venue code' }, 400);
  const { lat, lon } = coordsFrom(url);
  if (lat === null && !dest.from) {
    return json({ error: 'pass lat and lon, or ?from= a stop code' }, 400);
  }
  return json(await answerFor(env, ctx, { lat, lon, to: dest.to, originCode: lat === null ? dest.from : null }, dest.label, nowMs));
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
  const before = await env.NUSBUS_KV.get('auth:session').catch(() => null);
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
  return jsonCached({ viewBox: CAMPUS_MAP.viewBox, stops: CAMPUS_MAP.stops, routes: CAMPUS_MAP.routes, destinations: DESTINATIONS }, 3600);
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

/** The cron runs every 15 minutes; older than this and it has stopped. */
const CRON_STALE_MS = 40 * 60_000;

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
  const probe = url.searchParams.get('probe') === '1' && env.HEALTH_TOKEN && req.headers.get('x-health-token') === env.HEALTH_TOKEN;
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
    },
    ok ? 200 : 503,
  );
}

const PRIMARY_HOST = 'terminus.rcn.sh';
const OLD_HOST = 'nusbus.rcn.sh';
/** Paths apps already installed call on the old host. These keep working there. */
const API_PREFIXES = ['/me', '/auth/', '/pair', '/next', '/trip', '/arrivals', '/campus', '/health', '/import', '/openapi.json'];

/**
 * Browsers on the old host move to the new one. API calls don't: HTTP
 * clients don't follow redirects for POSTs, and apps paired before the
 * rename still call nusbus.rcn.sh. (`/pair` the page is a GET with a
 * `code`, and is redirected too.)
 */
export function oldHostRedirect(req: Request, url: URL): Response | null {
  if (url.hostname !== OLD_HOST || (req.method !== 'GET' && req.method !== 'HEAD')) return null;
  const isPairPage = url.pathname.startsWith('/pair') && url.searchParams.has('code');
  if (!isPairPage && API_PREFIXES.some((p) => url.pathname === p || url.pathname.startsWith(p.endsWith('/') ? p : `${p}/`))) return null;
  const to = new URL(url);
  to.hostname = PRIMARY_HOST;
  return new Response(null, { status: 301, headers: { location: to.toString(), 'cache-control': 'public, max-age=86400' } });
}

const ME_DEPS: MeDeps = { graph: GRAPH, answerFor, collectArrivals };

export default {
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runCron(env, Date.now()));
  },

  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const res = await route(req, env, ctx);
    // A redirect or a download body passes through untouched apart from headers.
    return withSecurityHeaders(res, new URL(req.url).pathname);
  },
};

async function route(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const nowMs = Date.now();

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    const moved = oldHostRedirect(req, url);
    if (moved) return moved;

    try {
      const me = await handleMe(req, url, env, ctx, nowMs, ME_DEPS);
      if (me) return me;
      // Public routes: a per-IP ceiling. The per-stop cache already protects
      // NUS; this protects the Worker from being a free proxy, and D1/R2 from
      // being a free bill.
      if (env.RL_PUBLIC && (['/next', '/trip', '/arrivals', '/import', '/health'].includes(url.pathname) || url.pathname.startsWith('/download/'))) {
        const { success } = await env.RL_PUBLIC.limit({ key: `pub:${clientKey(req)}` });
        if (!success) return json({ error: 'too many requests, slow down' }, 429, { 'retry-after': '60' });
      }
      const dl = await handleDownload(url.pathname, env);
      if (dl) return dl;

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
        case '/campus':
          return handleCampus();
        case '/arrivals':
          return await handleArrivals(url, env, ctx, nowMs);
        case '/import':
          return await handleImport(url, env, nowMs);
        default:
          // Everything else is the website.
          if (env.ASSETS && (req.method === 'GET' || req.method === 'HEAD')) return env.ASSETS.fetch(req);
          return json({ error: 'not found' }, 404);
      }
    } catch (err) {
      // Logged, because a caught error never shows up as an exception in the
      // dashboard. The path only: the query can hold coordinates.
      console.error('unhandled', req.method, url.pathname, err instanceof Error ? (err.stack ?? err.message) : String(err));
      return json({ error: 'internal' }, 500);
    }
}
