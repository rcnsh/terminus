import type { Env, ResolveInput } from './types.ts';
import { sgt } from './config.ts';
import { venueAt, venueToStop } from './timetable/nusmods.ts';
import { appVersion, authConfigured, getSession } from './feeds/auth.ts';
import { candidates, lookUp, parseVersion, versionString } from './feeds/appversion.ts';
import { fmsConfigured, getBuses } from './feeds/fms.ts';
import { shortStop } from './answer/format.ts';
import { boardAsOf, boardAt, displayName, indexGraph, nearStopWalks } from './answer/resolve.ts';
import { serviceEndsAt, serviceResumesAt, stoppedReason } from './answer/hours.ts';
import { buildCampusMap, buildDestinations, ROUTE_COLORS } from './map/campus.ts';
import { busesOnLine, lineStops, trackedBuses } from './map/buses.ts';
import { stopPairs } from './map/pairs.ts';
import { adminStats, canReadAppVersion, handleDeleteReport, handleDismissCrash, holdsHealthToken, isOperator } from './ops/admin.ts';
import { handleCollect } from './ops/collect.ts';
import { handleAppError } from './ops/apperrors.ts';
import { handlePasskey } from './accounts/passkey.ts';
import { analyticsEnabled, logError } from './ops/analytics.ts';
import { docsPageFor, openApiJson } from './openapi.ts';
import { phaseAt, sgtMinute } from './site/pagesky.ts';
import { CORS, clientKey, coordsFrom, json, jsonCached, numParam, withSecurityHeaders } from './http.ts';
import { handleMe } from './accounts/me.ts';
import { UPDATE_REQUIRED, accountsConfigured, clientOutdated, hasSessionCookie } from './accounts/accounts.ts';
import { answering, answeringSince, feedStatus, readUpstream, runCron, statusRecords } from './ops/monitor.ts';
import { ltaConfigured } from './feeds/lta.ts';
import { calendarThrough } from './timetable/calendar.ts';
import { llmsTxt, robotsTxt, SITEMAP } from './site/seo.ts';
import { calendarSource, loadCalendar } from './timetable/calendarsync.ts';
import { handleDownload } from './site/downloads.ts';
import { landingPage } from './site/landing.ts';
import { handleMap, matchesEtag } from './map/map.ts';
import { landmark, targetStops } from './answer/landmarks.ts';
import { residenceList } from './answer/residences.ts';
import { ACCOUNTS_DOWN, callerOrDown, d1Unavailable, recentCallerFor } from './accounts/access.ts';
import { fcmEnabled } from './push/push.ts';
import { webPushEnabled } from './push/webpush.ts';
import { apnsEnabled } from './push/apns.ts';
import { handleTimelapse } from './map/timelapse.ts';
import { scopeCache } from './feeds/edgecache.ts';

import { GRAPH, GRAPH_PUBLIC, oppositeOf } from './answer/graph.ts';
import { appSiteAssociation, markBeta, movedApi, movedPage } from './site/site.ts';
import { isBeta, linkOrigin } from './origin.ts';
import { noteLegacy } from './ops/legacy.ts';
import { noteKeyUse } from './ops/keyuse.ts';
import { type MeDeps, answerFor, arrivedAnswer, collectArrivals, needsSetupAnswer } from './answer/answer.ts';
import { lang, langOfRequest, m, withLang } from './i18n.ts';
import type { Lang } from './i18n.ts';

let stopPairsMemo: ReturnType<typeof stopPairs> | null = null;

export { GRAPH, answerFor, arrivedAnswer, collectArrivals, coordsFrom, numParam };
export { Trip } from './push/tripdo.ts';
export { TimelapseRecorder } from './map/timelapsedo.ts';
export { FeedGate } from './feeds/feedgate.ts';

function resolveDestination(url: URL) {
  const idx = indexGraph(GRAPH);
  const raw = url.searchParams.get('to')?.trim().toUpperCase() || null;
  const fromRaw = url.searchParams.get('from')?.trim().toUpperCase() || null;
  const from = fromRaw && idx.byCode.has(fromRaw) ? fromRaw : null;
  if (!raw) return null;

  const stop = idx.byCode.get(raw);
  if (stop)
    return { to: stop.code, also: [] as string[], from, label: shortStop(stop.name, 14), at: null, near: nearStopWalks(GRAPH, stop.code) };
  const lm = landmark(raw);
  if (lm) {
    const t = targetStops(raw);
    return { to: t.to, also: t.also, from, label: lm.name, at: null };
  }

  const venue = venueToStop(raw);
  if (venue) return { to: venue.stop, also: [] as string[], from, label: raw.split('-')[0], at: venueAt(raw) };
  return null;
}

async function handleNext(url: URL, env: Env, ctx: ExecutionContext, nowMs: number): Promise<Response> {
  const { lat, lon } = coordsFrom(url);

  const dest = resolveDestination(url);
  const to = dest?.to ?? null;
  const originCode = dest?.from ?? null;

  if (lat === null && to === null && originCode === null) {
    return json(needsSetupAnswer(nowMs));
  }

  const input: ResolveInput = {
    lat,
    lon,
    to,
    toAlso: dest?.also,
    originCode,
    destAt: dest?.at ?? null,
    ...(dest?.near ? { endWalkByStopS: dest.near } : {}),
    ...(url.searchParams.get('public') === '1' ? { publicBuses: true } : {}),
  };
  return json(await answerFor(env, ctx, input, dest?.label ?? null, nowMs));
}

async function handleTrip(url: URL, env: Env, ctx: ExecutionContext, nowMs: number): Promise<Response> {
  const dest = resolveDestination(url);
  if (!dest) return json({ error: 'unknown destination: pass ?to= a stop or venue code' }, 400);
  const { lat, lon } = coordsFrom(url);
  if (lat === null && !dest.from) {
    return json({ error: 'pass lat and lon, or ?from= a stop code' }, 400);
  }
  return json(
    await answerFor(
      env,
      ctx,
      {
        lat,
        lon,
        to: dest.to,
        toAlso: dest.also,
        originCode: lat === null ? dest.from : null,
        destAt: dest.at,
        ...(dest.near ? { endWalkByStopS: dest.near } : {}),
      },
      dest.label,
      nowMs,
    ),
  );
}

async function probeAuth(env: Env, nowMs: number): Promise<Record<string, unknown>> {
  if (!authConfigured(env)) return { ok: false, reason: 'auth not configured' };

  const before = await env.KV.get('auth:session').catch(() => null);
  try {
    const s = await getSession(env, nowMs);
    return { ok: true, cached: Boolean(before), domain: s.domain, expiresIn: `${Math.round((s.expMs - nowMs) / 3600_000)}h` };
  } catch (err) {
    return { ok: false, cached: Boolean(before), reason: (err as Error).message };
  }
}

const campusBodies = new Map<Lang, Promise<{ body: string; etag: string }>>();

async function handleCampus(req: Request): Promise<Response> {
  const l = lang();
  let made = campusBodies.get(l);
  if (!made) {
    made = (async () => {
      const map = buildCampusMap(GRAPH);
      const body = JSON.stringify({
        viewBox: map.viewBox,
        stops: map.stops,
        routes: map.routes,
        destinations: buildDestinations(GRAPH),
        residences: residenceList(),
      });
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body)));
      return {
        body,
        etag: `"${Array.from(digest.slice(0, 12))
          .map((b) => b.toString(16).padStart(2, '0'))
          .join('')}"`,
      };
    })();
    made.catch(() => campusBodies.delete(l));
    campusBodies.set(l, made);
  }
  const { body, etag } = await made;
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'private, max-age=3600',
    vary: 'accept-language',
    etag,
    ...CORS,
  };
  if (matchesEtag(req, etag)) return new Response(null, { status: 304, headers });
  return new Response(body, { headers });
}

async function handleArrivals(url: URL, env: Env, ctx: ExecutionContext, nowMs: number): Promise<Response> {
  const code = url.searchParams.get('stop')?.trim().toUpperCase() || '';
  const graph = url.searchParams.get('public') === '1' || !indexGraph(GRAPH).byCode.has(code) ? GRAPH_PUBLIC : GRAPH;
  const idx = indexGraph(graph);
  const stop = idx.byCode.get(code);
  if (!stop) return json({ error: 'unknown stop', stop: code }, 400);

  const sa = (await collectArrivals(env, ctx, [code], nowMs, graph)).get(code)!;
  const board = boardAt(graph, idx, code, sa, nowMs, { stopped: url.searchParams.get('stopped') === '1' });
  return json({
    stop: { code: stop.code, name: stop.name, longName: displayName(stop, stop.code), ...oppositeOf(stop, idx.byCode) },
    board,
    asOf: new Date(boardAsOf([sa], nowMs)).toISOString(),
    available: sa.available,
  });
}

async function handleBuses(url: URL, env: Env, ctx: ExecutionContext, nowMs: number): Promise<Response> {
  const svc = url.searchParams.get('svc')?.trim().toUpperCase() || '';
  if (!GRAPH.routes?.[svc]) return json({ error: 'unknown service', svc }, 400);
  const live = await getBuses(env, ctx, svc, nowMs).catch(() => null);
  return json(
    {
      svc,
      color: ROUTE_COLORS[svc] ?? null,
      buses: live ? await trackedBuses(GRAPH, svc, live, ctx) : [],
      asOf: new Date(live?.stale ? live.fetchedAt : nowMs).toISOString(),
      available: Boolean(live),
      stale: Boolean(live?.stale),
    },
    200,
    { 'cache-control': 'private, max-age=5' },
  );
}

function lineOut(out: number, stale: boolean): { out: number; outText: string; stale: boolean } {
  return { out, outText: out ? m().busesOut(out) : m().noneOut, stale };
}

async function handleLines(env: Env, ctx: ExecutionContext, nowMs: number): Promise<Response> {
  const svcs = Object.keys(GRAPH.routes ?? {});
  const got = await Promise.all(
    svcs.map(async (svc) => {
      const live = await getBuses(env, ctx, svc, nowMs).catch(() => null);
      if (!live) return [svc, null] as const;
      return [svc, lineOut((await trackedBuses(GRAPH, svc, live, ctx)).length, Boolean(live.stale))] as const;
    }),
  );
  return json({ lines: Object.fromEntries(got), asOf: new Date(nowMs).toISOString() }, 200, { 'cache-control': 'private, max-age=30' });
}

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
    code ? collectArrivals(env, ctx, [code], nowMs, GRAPH).then((m) => m.get(code)) : Promise.resolve(undefined),
  ]);
  const placed = live ? await trackedBuses(GRAPH, svc, live, ctx) : [];
  const ends = serviceEndsAt(GRAPH, svc, nowMs);
  const stopped = placed.length ? null : stoppedReason(GRAPH, svc, nowMs);
  const resumes = stopped ? serviceResumesAt(GRAPH, svc, nowMs) : null;
  return json(
    {
      svc,
      color: ROUTE_COLORS[svc] ?? null,
      endsAt: ends === null ? null : new Date(ends).toISOString(),
      running: stopped === null,
      stopped,
      resumesAt: resumes === null ? null : new Date(resumes).toISOString(),
      stops: lineStops(idx, svc),
      buses: busesOnLine(route.seq, route.loop, placed),
      out: live ? lineOut(placed.length, Boolean(live.stale)) : null,
      ...(code
        ? { stop: { code, index, row: boardAt(GRAPH, idx, code, sa, nowMs, { stopped: true }).find((r) => r.svc === svc) ?? null } }
        : {}),
      available: Boolean(live),
      asOf: new Date(Math.min(live?.stale ? live.fetchedAt : nowMs, code ? boardAsOf([sa], nowMs) : nowMs)).toISOString(),
    },
    200,
    { 'cache-control': 'private, max-age=5' },
  );
}

export function signInFirst(req: Request, url: URL): boolean {
  return (
    (url.pathname === '/app/' || url.pathname === '/app') && req.headers.get('sec-fetch-dest') === 'document' && !hasSessionCookie(req)
  );
}

async function sitePage(req: Request, assets: Fetcher): Promise<Response> {
  const res = await assets.fetch(req);
  if (res.status !== 404 || !(req.headers.get('accept') ?? '').includes('text/html')) return res;
  const page = await assets.fetch(new Request(new URL('/not-found/', req.url), { headers: req.headers }));
  if (!page.ok) return res;
  return new Response(page.body, { status: 404, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}

const CRON_STALE_MS = 40 * 60_000;

async function handleStatus(env: Env, nowMs: number): Promise<Response> {
  const { upstream: u, incidents, publicFeed: pub } = await statusRecords(env, nowMs);
  const iso = (ms: number | null) => (ms == null ? null : new Date(ms).toISOString());
  const f = u ? feedStatus(u) : null;
  return json(
    {
      feed: f?.feed ?? 'unknown',
      since: f ? iso(f.since) : null,
      cause: f?.cause ?? null,
      checkedAt: u ? iso(u.checkedAt) : null,
      checking: u ? nowMs - u.checkedAt <= CRON_STALE_MS : false,
      incidents: incidents.map((i) => ({ start: iso(i.start), end: iso(i.end), cause: i.cause })),
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
  const ok = (!u || answering(u)) && cronStale !== true && daysLeft > 0;
  const operator = await isOperator(env, req, nowMs);
  const probe = operator && url.searchParams.get('probe') === '1';
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
      config: {
        auth: authConfigured(env),
        proxy: fmsConfigured(env),
        publicBuses: ltaConfigured(env),
        analytics: analyticsEnabled(env),
        accounts: accountsConfigured(env),
        email: Boolean(env.EMAIL && env.EMAIL_FROM),
        alerts: Boolean(env.EMAIL && env.EMAIL_FROM && env.ALERT_EMAIL),
        pushAndroid: fcmEnabled(env),
        pushWeb: webPushEnabled(env),
        pushIos: apnsEnabled(env),
      },
      upstream: u
        ? { up: answering(u), since: new Date(answeringSince(u)).toISOString(), checkedAt: new Date(u.checkedAt).toISOString(), cronStale }
        : null,
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
    errors: found.errors,
    wouldTry: cur ? candidates(cur, { refusal: [], ...found }).map(versionString) : [],
  };
}

const ME_DEPS: MeDeps = { answerFor, collectArrivals };

const KEYED = ['/api/next', '/api/trip', '/api/arrivals', '/api/buses', '/api/lines', '/api/line', '/api/campus', '/api/stops/pairs'];

export default {
  async scheduled(_event: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    scopeCache(env);
    await runCron(env, Date.now());
  },

  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    scopeCache(env);
    const [res, written] = await withLang(langOfRequest(req), async () => [await route(req, env, ctx), lang()] as const);
    noteLegacy(env, ctx, req, res.status);
    const path = new URL(req.url).pathname;
    const out = withSecurityHeaders(res, path);
    if (path.startsWith('/api/')) out.headers.set('content-language', written === 'zh' ? 'zh-Hans' : 'en');
    return out;
  },
};

async function route(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(req.url);
  const nowMs = Date.now();

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  const moved = movedPage(req, env) ?? movedApi(req, url);
  if (moved) return moved;
  await loadCalendar(env, nowMs);

  try {
    const me = await handleMe(req, url, env, ctx, nowMs, ME_DEPS);
    if (me) return me;
    const keyed = KEYED.includes(url.pathname);
    if (
      env.RL_PUBLIC &&
      (url.pathname === '/api/health' ||
        url.pathname === '/api/status.json' ||
        url.pathname === '/api/admin/stats' ||
        url.pathname === '/api/admin/appversion' ||
        url.pathname === '/api/admin/collect' ||
        url.pathname === '/api/admin/crashes/dismiss' ||
        url.pathname === '/api/admin/reports/delete' ||
        url.pathname === '/api/errors' ||
        url.pathname.startsWith('/api/admin/passkey/') ||
        url.pathname.startsWith('/download/') ||
        url.pathname.startsWith('/api/timelapse/'))
    ) {
      const { success } = await env.RL_PUBLIC.limit({ key: `pub:${clientKey(req)}` });
      if (!success) return json({ error: 'too many requests, slow down' }, 429, { 'retry-after': '60' });
    }
    if (keyed) {
      const { caller, down } =
        url.pathname === '/api/buses'
          ? { caller: await recentCallerFor(env, req, nowMs, ctx), down: false }
          : await callerOrDown(env, req, nowMs, ctx);
      if (down) {
        logError(env, url.pathname);
        return json({ error: ACCOUNTS_DOWN }, 503, { 'retry-after': '30' });
      }
      const bucket =
        caller?.kind === 'key'
          ? { rl: env.RL_PUBLIC, key: `key:${caller.keyId}` }
          : caller?.kind === 'account'
            ? { rl: env.RL_ME, key: `acct:${caller.userId}` }
            : { rl: env.RL_PUBLIC, key: `pub:${clientKey(req)}` };
      const limited = Boolean(bucket.rl && !(await bucket.rl.limit({ key: bucket.key })).success);
      if (caller?.kind === 'key') noteKeyUse(env, ctx, caller.keyId, url.pathname, limited ? 'limited' : 'ok');
      if (limited) {
        return json({ error: caller?.kind === 'key' ? 'too many requests for this key, slow down' : 'too many requests, slow down' }, 429, {
          'retry-after': '60',
        });
      }
      if (!caller) {
        return json({ error: m().needsKey(linkOrigin(env)) }, 401, {
          'www-authenticate': 'Bearer realm="terminus"',
        });
      }
      if (caller.kind === 'account' && (await clientOutdated(env, req, nowMs))) return json(UPDATE_REQUIRED, 426);
    }
    const dl = await handleDownload(url.pathname, env, url);
    if (dl) return dl;
    const timelapse = await handleTimelapse(req, url, env, nowMs);
    if (timelapse) return timelapse;
    if (url.pathname.startsWith('/api/admin/passkey/')) return await handlePasskey(req, url, env, nowMs, holdsHealthToken(env, req));
    const map = await handleMap(req, url, env, ctx);
    if (map) return map;

    switch (url.pathname) {
      case '/docs':
        return new Response(docsPageFor(phaseAt(sgtMinute(nowMs))), {
          headers: {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'public, max-age=300',
            ...(isBeta(env) ? { 'x-robots-tag': 'noindex' } : {}),
          },
        });
      case '/robots.txt':
        return new Response(robotsTxt(env), {
          headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=3600' },
        });
      case '/.well-known/apple-app-site-association': {
        const aasa = appSiteAssociation(env);
        if (!aasa) return json({ error: 'not found' }, 404);
        return new Response(JSON.stringify(aasa), {
          headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=3600' },
        });
      }
      case '/llms.txt':
        return new Response(llmsTxt(url.origin), {
          headers: { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'public, max-age=3600' },
        });
      case '/sitemap.xml':
        if (isBeta(env)) return json({ error: 'not found' }, 404);
        return new Response(SITEMAP, {
          headers: { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, max-age=3600' },
        });
      case '/api/openapi.json':
        return new Response(openApiJson(url.origin), {
          headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=300', ...CORS },
        });
      case '/api/next':
        return await handleNext(url, env, ctx, nowMs);
      case '/api/trip':
        return await handleTrip(url, env, ctx, nowMs);
      case '/api/health':
        return await handleHealth(req, url, env, nowMs);
      case '/api/status.json':
        return await handleStatus(env, nowMs);
      case '/api/admin/stats':
        if (!(await isOperator(env, req, nowMs))) return json({ error: 'not found' }, 404);
        return json(await adminStats(env, nowMs), 200, { 'cache-control': 'no-store' });
      case '/api/admin/appversion': {
        if (!(await canReadAppVersion(env, req, nowMs))) return json({ error: 'not found' }, 404);
        const version = await appVersion(env, nowMs);
        if (!version) return json({ error: 'the NUS feed is not configured' }, 503);
        return json({ version }, 200, { 'cache-control': 'no-store' });
      }
      case '/api/admin/collect':
        return await handleCollect(req, env, nowMs);
      case '/api/admin/crashes/dismiss':
        return await handleDismissCrash(req, env, nowMs);
      case '/api/admin/reports/delete':
        return await handleDeleteReport(req, env, nowMs);
      case '/api/errors':
        return await handleAppError(req, env);
      case '/api/campus':
        return await handleCampus(req);
      case '/api/stops/pairs':
        return jsonCached((stopPairsMemo ??= stopPairs(GRAPH)), 3600, 'private');
      case '/api/arrivals':
        return await handleArrivals(url, env, ctx, nowMs);
      case '/api/buses':
        return await handleBuses(url, env, ctx, nowMs);
      case '/api/line':
        return await handleLine(url, env, ctx, nowMs);
      case '/api/lines':
        return await handleLines(env, ctx, nowMs);
      default:
        if (env.ASSETS && (req.method === 'GET' || req.method === 'HEAD')) {
          if (url.pathname === '/') return markBeta(await landingPage(req, env.ASSETS, env, nowMs, ctx), env);
          if (signInFirst(req, url))
            return new Response(null, { status: 302, headers: { location: '/account/?next=/app/', 'cache-control': 'no-store' } });
          return markBeta(await sitePage(req, env.ASSETS), env);
        }
        return json({ error: 'not found' }, 404);
    }
  } catch (err) {
    console.error('unhandled', req.method, url.pathname, err instanceof Error ? (err.stack ?? err.message) : String(err));
    logError(env, url.pathname);
    if (d1Unavailable(err)) return json({ error: ACCOUNTS_DOWN }, 503, { 'retry-after': '30' });
    return json({ error: 'something went wrong on our side' }, 500);
  }
}
