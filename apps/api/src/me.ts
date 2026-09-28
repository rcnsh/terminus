/**
 * The personal layer: sign-in, pairing, profile, and the answers that use
 * them (/me/next, /me/nearby). Everything here needs the DB binding; the
 * public routes in index.ts never do.
 */

import type { Answer, Env, Graph, ResolveInput, StopArrivals } from './types.ts';
import {
  ACCOUNT_TTL,
  type SessionInfo,
  authenticate,
  createPairCode,
  endSession,
  listDevices,
  loadProfileJson,
  normalizeEmail,
  normalizePairCode,
  redeemLink,
  redeemPairCode,
  requestLink,
  revokeDevice,
  saveProfileJson,
  sessionCookie,
} from './accounts.ts';
import { DEFAULT_PROFILE, type Profile, isResting, needsReimport, parseProfile, planFor, restDetail } from './profile.ts';
import { acadYear, parseShareUrl, resolveTrips, venueToStop } from './nusmods.ts';
import { boardAt, haversineM, indexGraph } from './resolve.ts';
import { shortStop } from './format.ts';
import { WALK } from './config.ts';
import { coordsFrom, json } from './http.ts';

export interface MeDeps {
  graph: Graph;
  answerFor: (env: Env, ctx: ExecutionContext, input: ResolveInput, label: string | null, nowMs: number) => Promise<Answer>;
  collectArrivals: (env: Env, ctx: ExecutionContext, codes: string[], nowMs: number) => Promise<Map<string, StopArrivals>>;
}

const html = (body: string, status = 200, extra: Record<string, string> = {}) =>
  new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...extra } });

const page = (title: string, inner: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${title}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:28rem;margin:4rem auto;padding:0 16px;color:#1a1a1a;background:#fff}
button{font:inherit;padding:.6rem 1.2rem;border-radius:8px;border:0;background:#1a1a1a;color:#fff;cursor:pointer}
@media (prefers-color-scheme:dark){body{background:#111;color:#eee}button{background:#eee;color:#111}}</style>
</head><body>${inner}</body></html>`;

async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  if (!(req.headers.get('content-type') ?? '').includes('application/json')) return null;
  try {
    const body = await req.json();
    return typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function limited(env: Env, req: Request, scope: string): Promise<boolean> {
  if (!env.RL_AUTH) return false;
  const ip = req.headers.get('cf-connecting-ip') ?? 'unknown';
  const { success } = await env.RL_AUTH.limit({ key: `${scope}:${ip}` });
  return !success;
}

export async function getProfile(db: D1Database, userId: string, graph: Graph): Promise<Profile> {
  const raw = await loadProfileJson(db, userId);
  if (!raw) return structuredClone(DEFAULT_PROFILE);
  const idx = indexGraph(graph);
  // A stop can vanish from a new scrape. Re-validating on read would reject
  // the whole profile, so drop only what no longer resolves.
  const r = parseProfile(raw, (c) => idx.byCode.has(c));
  if (r.ok) return r.profile;
  const p = raw as Profile;
  const ok = (c: string) => idx.byCode.has(c);
  return {
    ...structuredClone(DEFAULT_PROFILE),
    gapHours: typeof p.gapHours === 'number' ? p.gapHours : DEFAULT_PROFILE.gapHours,
    home: p.home ? { ...p.home, stops: (p.home.stops ?? []).filter(ok) } : null,
    trips: (p.trips ?? []).filter((t) => ok(t.to)),
    manual: (p.manual ?? []).filter((t) => ok(t.to)),
    places: (p.places ?? []).filter((x) => ok(x.to)),
    share: p.share ?? null,
    term: p.term ?? null,
  };
}

/** Stop code, or a NUSMods venue code resolved to its nearest stop. */
function resolveTo(graph: Graph, raw: string): { to: string; label: string } | null {
  const code = raw.trim().toUpperCase();
  const stop = indexGraph(graph).byCode.get(code);
  if (stop) return { to: stop.code, label: shortStop(stop.name, 14) };
  const v = venueToStop(code);
  return v ? { to: v.stop, label: code.split('-')[0] } : null;
}

/**
 * Routes under /auth, /pair and /me. Returns null for any other path so the
 * caller can fall through to the public routes.
 */
export async function handleMe(
  req: Request,
  url: URL,
  env: Env,
  ctx: ExecutionContext,
  nowMs: number,
  deps: MeDeps,
): Promise<Response | null> {
  const path = url.pathname;
  if (!(path.startsWith('/auth/') || path === '/pair' || path === '/me' || path.startsWith('/me/'))) return null;
  const db = env.DB;
  if (!db) return json({ error: 'accounts are not configured' }, 503);

  /* ---------- sign-in ---------- */

  if (path === '/auth/login' && req.method === 'POST') {
    if (await limited(env, req, 'login')) return json({ error: 'too many attempts, try again in a minute' }, 429);
    const body = await readJson(req);
    const email = normalizeEmail(body?.email);
    if (!email) return json({ error: 'enter a valid email address' }, 400);
    try {
      await requestLink(env, db, email, url.origin, nowMs);
    } catch (err) {
      console.error('sign-in email failed', String(err));
      return json({ error: 'could not send the email, try again later' }, 502);
    }
    // Same answer whether or not the address is invited.
    return json({ ok: true, message: 'If that address has an invite, a sign-in link is on its way.' });
  }

  if (path === '/auth/verify') {
    if (req.method === 'GET') {
      // Mail scanners (Outlook Safe Links) open every link in an email. If
      // opening the link spent it, the user's own click would fail. So GET
      // only shows a button; the POST spends the token.
      const t = url.searchParams.get('t') ?? '';
      const safe = t.replace(/[^A-Za-z0-9_-]/g, '');
      return html(page('Sign in to nusbus', `<h1>Sign in to nusbus</h1>
<form method="post" action="/auth/verify"><input type="hidden" name="t" value="${safe}"><button type="submit">Sign in</button></form>`));
    }
    if (req.method === 'POST') {
      const form = await req.formData().catch(() => null);
      const t = form?.get('t');
      const token = typeof t === 'string' ? await redeemLink(db, t, nowMs) : null;
      if (!token) {
        return html(page('Link expired', '<h1>That link has expired</h1><p>Sign-in links work once, for 15 minutes. <a href="/account">Request a new one</a>.</p>'), 400);
      }
      return new Response(null, {
        status: 303,
        headers: { location: '/account', 'set-cookie': sessionCookie(token, ACCOUNT_TTL.webSessionMs / 1000), 'cache-control': 'no-store' },
      });
    }
  }

  if (path === '/pair' && req.method === 'POST') {
    if (await limited(env, req, 'pair')) return json({ error: 'too many attempts, try again in a minute' }, 429);
    const body = await readJson(req);
    const code = normalizePairCode(body?.code);
    const name = typeof body?.name === 'string' ? body.name.trim().slice(0, 40) || 'Device' : 'Device';
    if (!code) return json({ error: 'enter the 6-character code from the account page' }, 400);
    const token = await redeemPairCode(db, code, name, nowMs);
    if (!token) return json({ error: 'that code is wrong or has expired' }, 400);
    return json({ token });
  }

  /* ---------- everything below needs a session ---------- */

  const session = await authenticate(db, req, nowMs, ctx);

  if (path === '/auth/logout' && req.method === 'POST') {
    if (session) await endSession(db, session.tokenHash);
    return json({ ok: true }, 200, { 'set-cookie': sessionCookie('', 0) });
  }

  if (!session) return json({ error: 'sign in first' }, 401);
  const webOnly = (s: SessionInfo) => (s.kind === 'web' ? null : json({ error: 'manage devices from the account page' }, 403));

  if (path === '/me' && req.method === 'GET') {
    const profile = await getProfile(db, session.user.id, deps.graph);
    return json({ email: session.user.email, kind: session.kind, needsReimport: needsReimport(profile) });
  }

  if (path === '/me/profile') {
    if (req.method === 'GET') return json(await getProfile(db, session.user.id, deps.graph));
    if (req.method === 'PUT') {
      const body = await readJson(req);
      if (!body) return json({ error: 'send the profile as JSON' }, 400);
      const idx = indexGraph(deps.graph);
      const r = parseProfile(body, (c) => idx.byCode.has(c));
      if (!r.ok) return json({ error: r.error }, 400);
      await saveProfileJson(db, session.user.id, r.profile, nowMs);
      return json(r.profile);
    }
  }

  if (path === '/me/import' && req.method === 'POST') {
    const body = await readJson(req);
    const share = typeof body?.share === 'string' ? body.share : '';
    let parsed;
    try {
      parsed = parseShareUrl(share);
    } catch {
      return json({ error: 'not a valid NUSMods share link' }, 400);
    }
    if (!parsed.selections.length) return json({ error: 'no modules found in that link' }, 400);
    const { trips, unresolved } = await resolveTrips(parsed, nowMs);
    const profile = await getProfile(db, session.user.id, deps.graph);
    profile.trips = trips;
    profile.share = share;
    profile.term = { acadYear: acadYear(nowMs, parsed.semester).replace('-', '/'), semester: parsed.semester };
    await saveProfileJson(db, session.user.id, profile, nowMs);
    return json({ profile, unresolved });
  }

  if (path === '/me/pair-code' && req.method === 'POST') {
    const deny = webOnly(session);
    if (deny) return deny;
    return json(await createPairCode(db, session.user.id, nowMs));
  }

  if (path === '/me/devices' && req.method === 'GET') {
    return json({ devices: await listDevices(db, session.user.id) });
  }
  if (path.startsWith('/me/devices/') && req.method === 'DELETE') {
    const deny = webOnly(session);
    if (deny) return deny;
    const ok = await revokeDevice(db, session.user.id, path.slice('/me/devices/'.length));
    return ok ? json({ ok: true }) : json({ error: 'no such device' }, 404);
  }

  if (path === '/me/next' && req.method === 'GET') {
    return json(await nextFor(url, env, ctx, nowMs, deps, await getProfile(db, session.user.id, deps.graph)));
  }

  if (path === '/me/nearby' && req.method === 'GET') {
    const profile = await getProfile(db, session.user.id, deps.graph);
    return nearbyFor(url, env, ctx, nowMs, deps, profile);
  }

  return json({ error: 'not found' }, 404);
}

export async function nextFor(url: URL, env: Env, ctx: ExecutionContext, nowMs: number, deps: MeDeps, profile: Profile) {
  const { lat, lon } = coordsFrom(url);
  const homeStop = profile.home?.stops[0] ?? null;
  const places = profile.places.map(({ key, label }) => ({ key, label }));

  let dest: { to: string; label: string; why: string; from: string | null } | null = null;
  const placeKey = url.searchParams.get('place');
  const toRaw = url.searchParams.get('to');
  if (placeKey) {
    const pl = profile.places.find((p) => p.key === placeKey);
    if (pl) dest = { to: pl.to, label: pl.label, why: 'place', from: homeStop };
  } else if (toRaw) {
    const r = resolveTo(deps.graph, toRaw);
    if (r) dest = { ...r, why: 'place', from: homeStop };
  } else if (isResting(profile, nowMs)) {
    // Outside the user's day: no bus, and the same answer for every client.
    return {
      label: 'Done for today',
      detail: restDetail(profile, nowMs),
      alt: null,
      stop: { code: '', name: '', confidence: 0 },
      quality: 'ended',
      asOf: new Date(nowMs).toISOString(),
      arrivals: [],
      mode: 'rest',
      dest: null,
      places,
    };
  } else {
    const plan = planFor(profile, nowMs);
    if (plan) dest = { to: plan.to, label: plan.label, why: plan.why, from: plan.from };
  }

  const preferStops = profile.home?.stops ?? [];
  if (dest) {
    const input: ResolveInput = { lat, lon, to: dest.to, originCode: lat === null ? dest.from : null, preferStops };
    const answer = await deps.answerFor(env, ctx, input, dest.label, nowMs);
    return { ...answer, mode: 'trip', dest: { to: dest.to, label: dest.label, why: dest.why }, places };
  }

  // Nothing planned: what's coming at the nearest stop.
  if (lat === null && !homeStop) {
    return {
      label: 'Set up',
      detail: 'Add your timetable or home on the account page, or send your location',
      alt: null,
      stop: { code: '', name: '', confidence: 0 },
      quality: 'unknown',
      asOf: new Date(nowMs).toISOString(),
      arrivals: [],
      mode: 'nearby',
      dest: null,
      places,
    };
  }
  const input: ResolveInput = { lat, lon, to: null, originCode: lat === null ? homeStop : null, preferStops };
  const answer = await deps.answerFor(env, ctx, input, null, nowMs);
  return { ...answer, mode: 'nearby', dest: null, places };
}

async function nearbyFor(url: URL, env: Env, ctx: ExecutionContext, nowMs: number, deps: MeDeps, profile: Profile) {
  let { lat, lon } = coordsFrom(url);
  if (lat === null && profile.home) ({ lat, lon } = profile.home);
  if (lat === null || lon === null) return json({ error: 'send lat and lon, or set a home' }, 400);

  const idx = indexGraph(deps.graph);
  const ranked = deps.graph.stops
    .map((stop) => ({ stop, distM: haversineM(lat!, lon!, stop.lat, stop.lon) }))
    .sort((a, b) => a.distM - b.distM);
  const near = ranked.filter((c) => c.distM <= WALK.maxRadiusM).slice(0, WALK.maxCandidates);
  const picked = near.length ? near : ranked.slice(0, 1);

  const byStop = await deps.collectArrivals(env, ctx, picked.map((c) => c.stop.code), nowMs);
  const stops = picked.map(({ stop, distM }) => {
    const sa = byStop.get(stop.code)!;
    return {
      stop: { code: stop.code, name: stop.name },
      distM: Math.round(distM),
      walkS: Math.round(distM / WALK.speedMs),
      available: sa.available !== false,
      board: boardAt(deps.graph, idx, stop.code, sa, nowMs),
    };
  });
  return json({ stops, asOf: new Date(nowMs).toISOString() });
}
