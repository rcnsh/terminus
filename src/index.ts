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

import type { Answer, Arrival, Env, Graph, ResolveInput, StopArrivals } from './types.ts';
import { TRIPS, sgt, tripByKey, tripForTime } from './config.ts';
import {
  decodeTimetable,
  encodeTimetable,
  nextTrip,
  parseShareUrl,
  resolveTrips,
} from './nusmods.ts';
import { authConfigured, authUrl, getSession } from './auth.ts';
import { fmsConfigured, getArrivals } from './fms.ts';
import { buildAnswer, shortStop } from './format.ts';
import {
  boardAt,
  candidateStops,
  confidence,
  indexGraph,
  mergeServiceHours,
  nearestStop,
  pickAlt,
  scoreOptions,
  walkAllTheWayS,
} from './resolve.ts';
import { buildCampusMap, buildDestinations } from './campus.ts';
import { analyticsEnabled, logAnswer } from './analytics.ts';

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

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
};

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // The answer is coordinate-specific and cheap to recompute. The caching
      // that matters happens per stop code inside getArrivals().
      'cache-control': 'no-store',
      ...CORS,
      ...extra,
    },
  });
}

function jsonCached(body: unknown, maxAge: number): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': `public, max-age=${maxAge}`, ...CORS },
  });
}

/**
 * LANDMINE: Number(null) === 0 and Number('') === 0, not NaN. A missing lat
 * silently resolves to the Gulf of Guinea and reports "no stop nearby"
 * instead of falling back to the configured origin.
 */
export function numParam(url: URL, key: string): number | null {
  const raw = url.searchParams.get(key);
  if (raw === null) return null;
  const s = raw.trim();
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function coordsFrom(url: URL): { lat: number | null; lon: number | null } {
  const lat = numParam(url, 'lat');
  const lon = numParam(url, 'lon');
  if (lat === null || lon === null) return { lat: null, lon: null };
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return { lat: null, lon: null };
  return { lat, lon };
}

async function collectArrivals(
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

function resolveDestination(url: URL, nowMs: number) {
  const idx = indexGraph(GRAPH);
  const raw = url.searchParams.get('to')?.trim() || null;

  // Only an explicitly named trip key resolves here. With no ?to= we do NOT
  // invent a destination -- a user without a timetable gets "what's coming at
  // your nearest stop", not someone else's hardcoded commute.
  const trip = tripByKey(raw);
  if (trip) return { to: trip.to, from: trip.from, label: trip.label, key: trip.key };

  if (raw && idx.byCode.has(raw)) {
    const stop = idx.byCode.get(raw)!;
    // Abbreviate like every other stop name, so a bare code does not produce
    // "Information Technology" where a trip key produces "UTown".
    return { to: stop.code, from: null, label: shortStop(stop.name, 14), key: null };
  }
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

  const dest = resolveDestination(url, nowMs);
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
  return json(await answerFor(env, ctx, input, dest?.label ?? null, nowMs, dest?.key ?? null));
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

  const { trips, unresolved } = await resolveTrips(parsed, nowMs);
  if (!trips.length) {
    return json({ error: 'could not resolve any classes to a stop', unresolved }, 422);
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
  const dest = resolveDestination(url, nowMs);
  if (!dest) {
    return json({ error: 'unknown trip', trips: TRIPS.map((t) => t.key) }, 400);
  }
  const { lat, lon } = coordsFrom(url);
  // A bare stop code has no configured origin, so it needs the same fallback
  // /next uses -- otherwise /trip?to=<code> with no coordinates resolves
  // nothing at all.
  const originCode = dest.from ?? (lat === null ? (TRIPS[0]?.from ?? null) : null);
  return json(
    await answerFor(env, ctx, { lat, lon, to: dest.to, originCode }, dest.label, nowMs, dest.key),
  );
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
    return {
      ok: true,
      url: authUrl(env),
      cached: Boolean(before),
      domain: s.domain,
      userid: s.userid ? `${s.userid.slice(0, 8)}…` : null,
      expiresIn: `${Math.round((s.expMs - nowMs) / 3600_000)}h`,
    };
  } catch (err) {
    // getSession reports the HTTP status, the envelope code, or the first 80
    // bytes of a non-JSON body, so this message is usually the whole story.
    return { ok: false, url: authUrl(env), cached: Boolean(before), reason: (err as Error).message };
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

async function handleHealth(url: URL, env: Env, nowMs: number): Promise<Response> {
  const idx = indexGraph(GRAPH);
  const t = sgt(nowMs);
  return json({
    ok: true,
    now: new Date(nowMs).toISOString(),
    sgt: `${String(t.hour).padStart(2, '0')}:${String(t.minutes % 60).padStart(2, '0')} day${t.day}`,
    graph: {
      generated: GRAPH.generated,
      source: (GRAPH as unknown as { source?: string }).source ?? 'unknown',
      stops: GRAPH.stops.length,
      services: [...idx.routes.keys()],
    },
    // Presence only. Never the values.
    config: {
      auth: authConfigured(env),
      fms: fmsConfigured(env),
      serviceId: Boolean(env.NEXTBUS_FMS_SERVICE_ID),
      tenantCode: Boolean(env.NEXTBUS_FMS_TENANT_CODE),
      analytics: analyticsEnabled(env),
    },
    trip: tripForTime(nowMs)?.key ?? null,
    // Opt-in: this one costs an upstream round trip on a cold token.
    auth: url.searchParams.get('probe') === '1' ? await probeAuth(env, nowMs) : undefined,
  });
}

/** GET / -- what this API serves. There is no UI. */
const INDEX = {
  name: 'nusbus-edge',
  endpoints: {
    '/next': 'next bus: ?lat&lon, ?to=<trip key|stop code>, ?tt=<timetable from /import>',
    '/trip': 'a named trip or stop: ?to=<trip key|stop code>&lat&lon',
    '/arrivals': "one stop's board: ?stop=<code>",
    '/campus': 'static stop/route geometry and destination search data',
    '/import': 'NUSMods share URL -> personal /next link: ?share=<url>&home=<stop>',
    '/health': 'config presence and graph info; ?probe=1 tests auth',
  },
};

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const nowMs = Date.now();

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    try {
      switch (url.pathname) {
        case '/':
          return json(INDEX);
        case '/next':
          return await handleNext(url, env, ctx, nowMs);
        case '/trip':
          return await handleTrip(url, env, ctx, nowMs);
        case '/health':
          return await handleHealth(url, env, nowMs);
        case '/campus':
          return handleCampus();
        case '/arrivals':
          return await handleArrivals(url, env, ctx, nowMs);
        case '/import':
          return await handleImport(url, env, nowMs);
        default:
          return json({ error: 'not found' }, 404);
      }
    } catch (err) {
      return json({ error: 'internal', message: String(err) }, 500);
    }
  },
};
