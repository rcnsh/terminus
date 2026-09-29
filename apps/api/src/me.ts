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
  deleteAccount,
  endAllSessions,
  exportAccount,
  verifyTurnstile,
  endSession,
  listDevices,
  loadProfileJson,
  normalizeEmail,
  normalizePairCode,
  pairCodeOwner,
  maskEmail,
  redeemLink,
  redeemPairCode,
  requestLink,
  revokeDevice,
  saveProfileJson,
  sessionCookie,
} from './accounts.ts';
import { DEFAULT_PROFILE, PROFILE_LIMITS, type Profile, isResting, parseProfile, planChangesAt, planFor, reimportReason, restDetail, restLabel, timingFor } from './profile.ts';
import { type ImportedTrip, ImportInputError, parseShareUrl, resolveTrips, venueToStop } from './nusmods.ts';
import { termName } from './calendar.ts';
import { boardAt, haversineM, indexGraph } from './resolve.ts';
import { isoSeconds, shortStop } from './format.ts';
import { WALK } from './config.ts';
import { clientKey, coordsFrom, json } from './http.ts';

export interface MeDeps {
  graph: Graph;
  answerFor: (env: Env, ctx: ExecutionContext, input: ResolveInput, label: string | null, nowMs: number) => Promise<Answer>;
  collectArrivals: (env: Env, ctx: ExecutionContext, codes: string[], nowMs: number) => Promise<Map<string, StopArrivals>>;
}

const html = (body: string, status = 200, extra: Record<string, string> = {}) =>
  new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...extra } });

/** Minimal pages served by the Worker itself, in the site's style. */
const page = (title: string, inner: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${title} · terminus</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Space+Grotesk:wght@500;600;700&display=swap">
<link rel="stylesheet" href="/assets/site.css">
<style>.box{max-width:25rem;margin:10vh auto 0;padding:32px 28px}.box img{width:44px;height:44px;margin-bottom:20px}.box h1{font-size:1.6rem;margin-bottom:8px}.box .btn{width:100%;margin-top:20px}</style>
</head><body><main class="wrap"><div class="card box"><img src="/assets/mark.svg" alt="">${inner}</div></main></body></html>`;

/** A whole profile is a few KB; nothing legitimate comes close to this. */
const MAX_BODY_BYTES = 64 * 1024;

async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  if (!(req.headers.get('content-type') ?? '').includes('application/json')) return null;
  try {
    const text = await req.text();
    if (text.length > MAX_BODY_BYTES) return null;
    const body = JSON.parse(text);
    return typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function limited(env: Env, req: Request, scope: string): Promise<boolean> {
  if (!env.RL_AUTH) return false;
  const { success } = await env.RL_AUTH.limit({ key: `${scope}:${clientKey(req)}` });
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
    home: p.home?.stops?.some(ok) ? { stops: p.home.stops.filter(ok) } : null,
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
  if (!(path.startsWith('/auth/') || path === '/pair' || path === '/pair/check' || path === '/me' || path.startsWith('/me/'))) return null;
  const db = env.DB;
  if (!db) return json({ error: 'accounts are not configured' }, 503);

  /* ---------- sign-in ---------- */

  // Pages and lookups that cost a D1 read but need no session.
  if ((path === '/auth/verify' || path === '/auth/config') && env.RL_PUBLIC) {
    if (!(await env.RL_PUBLIC.limit({ key: `pub:${clientKey(req)}` })).success) return json({ error: 'too many requests, slow down' }, 429);
  }

  if (path === '/auth/config' && req.method === 'GET') {
    // What the sign-in form needs to render. Public by design.
    return json({ turnstileSiteKey: env.TURNSTILE_SECRET ? (env.TURNSTILE_SITE_KEY ?? null) : null });
  }

  if (path === '/auth/login' && req.method === 'POST') {
    if (await limited(env, req, 'login')) return json({ error: 'too many attempts, try again in a minute' }, 429);
    const body = await readJson(req);
    const email = normalizeEmail(body?.email);
    if (!email) return json({ error: 'enter a valid email address' }, 400);
    if (!(await verifyTurnstile(env, body?.turnstile, req.headers.get('cf-connecting-ip')))) {
      return json({ error: 'the human check failed, try again' }, 400);
    }
    // One ceiling for everyone: a botnet past Turnstile must not be able to
    // spend the whole email quota or the sender's reputation.
    if (env.RL_MAIL && !(await env.RL_MAIL.limit({ key: 'mail:global' })).success) {
      return json({ error: 'sign-in is busy, try again in a minute' }, 429, { 'retry-after': '60' });
    }
    try {
      await requestLink(env, db, email, url.origin, nowMs);
    } catch (err) {
      // The error text can carry the recipient: log its kind only.
      console.error('sign-in email failed', err instanceof Error ? err.name : typeof err);
      return json({ error: 'could not send the email, try again later' }, 502);
    }
    // Same answer whether or not the address is blocked or already has an account.
    return json({ ok: true, message: 'Check your email for a sign-in link.' });
  }

  if (path === '/auth/verify') {
    if (req.method === 'GET') {
      // Mail scanners (Outlook Safe Links) open every link in an email. If
      // opening the link spent it, the user's own click would fail. So GET
      // only shows a button; the POST spends the token.
      const t = url.searchParams.get('t') ?? '';
      const safe = t.replace(/[^A-Za-z0-9_-]/g, '');
      return html(page('Sign in', `<h1>Sign in to terminus</h1>
<p class="hint">Continue to sign in on this device.</p>
<form method="post" action="/auth/verify"><input type="hidden" name="t" value="${safe}"><button type="submit" class="btn accent">Sign in</button></form>`));
    }
    if (req.method === 'POST') {
      const form = await req.formData().catch(() => null);
      const t = form?.get('t');
      const token = typeof t === 'string' ? await redeemLink(db, t, nowMs) : null;
      if (!token) {
        return html(page('Link expired', '<h1>That link has expired</h1><p class="hint">Sign-in links work once, for 15 minutes.</p><a class="btn accent" href="/account">Get a new link</a>'), 400);
      }
      return new Response(null, {
        status: 303,
        headers: { location: '/account', 'set-cookie': sessionCookie(token, ACCOUNT_TTL.webSessionMs / 1000), 'cache-control': 'no-store' },
      });
    }
  }

  if (path === '/pair/check' && req.method === 'POST') {
    // Lets an app show whose account a code belongs to before spending it,
    // so a link someone sent you cannot quietly pair your phone to theirs.
    if (await limited(env, req, 'pair')) return json({ error: 'too many attempts, try again in a minute' }, 429);
    const body = await readJson(req);
    const code = normalizePairCode(body?.code);
    const owner = code ? await pairCodeOwner(db, code, nowMs) : null;
    if (!owner) return json({ error: 'that code is wrong or has expired' }, 400);
    return json({ account: maskEmail(owner) });
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

  if (!session) {
    // Each bad token costs a D1 read, so guessing is capped per address.
    if (await limited(env, req, 'badtoken')) return json({ error: 'too many attempts, try again in a minute' }, 429);
    return json({ error: 'sign in first' }, 401);
  }

  // Per account: generous for a widget, an app and a browser tab together.
  if (env.RL_ME) {
    const { success } = await env.RL_ME.limit({ key: `me:${session.user.id}` });
    if (!success) return json({ error: 'too many requests, slow down' }, 429);
  }
  const webOnly = (s: SessionInfo) => (s.kind === 'web' ? null : json({ error: 'manage devices from the account page' }, 403));

  if (path === '/me' && req.method === 'DELETE') {
    const deny = webOnly(session);
    if (deny) return deny;
    await deleteAccount(db, session.user);
    return json({ ok: true }, 200, { 'set-cookie': sessionCookie('', 0) });
  }

  if (path === '/me/export' && req.method === 'GET') {
    return json(await exportAccount(db, session.user), 200, {
      'content-disposition': 'attachment; filename="terminus-export.json"',
    });
  }

  if (path === '/me/sessions' && req.method === 'DELETE') {
    // Sign out everywhere, including this browser.
    const deny = webOnly(session);
    if (deny) return deny;
    const ended = await endAllSessions(db, session.user.id);
    return json({ ok: true, ended }, 200, { 'set-cookie': sessionCookie('', 0) });
  }

  if (path === '/me' && req.method === 'GET') {
    const profile = await getProfile(db, session.user.id, deps.graph);
    const reason = reimportReason(profile, nowMs);
    return json({
      email: session.user.email,
      kind: session.kind,
      needsReimport: reason !== null,
      reimportReason: reason,
      term: profile.term ? termName(profile.term) : null,
    });
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
    const share = typeof body?.share === 'string' ? body.share.trim() : '';
    let parsed;
    try {
      parsed = parseShareUrl(share);
    } catch {
      return json({ error: 'not a valid NUSMods share link' }, 400);
    }
    if (!parsed.selections.length) return json({ error: 'no modules found in that link' }, 400);
    let r;
    try {
      r = await resolveTrips(parsed, nowMs);
    } catch (err) {
      if (err instanceof ImportInputError) return json({ error: err.message }, 400);
      throw err;
    }
    const term = termName(r.term);
    // An incomplete import must never replace a timetable that works.
    if (r.failed.length) {
      return json({ error: `NUSMods didn't answer for ${r.failed.join(', ')}. Nothing was changed; try again in a minute.`, failed: r.failed }, 502);
    }
    if (!r.trips.length && !r.unresolved.length) {
      const why = r.missing.length ? `${r.missing.join(', ')} ${r.missing.length === 1 ? 'has' : 'have'} no classes in ${term}` : `no classes in that link run in ${term}`;
      return json({ error: `Nothing imported: ${why}. Your timetable was not changed.`, missing: r.missing }, 422);
    }
    const profile = await getProfile(db, session.user.id, deps.graph);
    profile.trips = r.trips.slice(0, PROFILE_LIMITS.trips);
    profile.share = share;
    profile.term = r.term;
    await saveProfileJson(db, session.user.id, profile, nowMs);
    return json({ profile, unresolved: r.unresolved, missing: r.missing, online: r.online, term });
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
    const profile = await getProfile(db, session.user.id, deps.graph);
    const answer = await nextFor(url, env, ctx, nowMs, deps, profile);
    // When the plan itself moves on (class starts, day ends). Only the planned
    // answer has one; a place or a stop never changes by itself.
    const planned = !url.searchParams.get('place') && !url.searchParams.get('to');
    return json(planned ? { ...answer, refreshAt: isoSeconds(planChangesAt(profile, nowMs)) } : answer);
  }

  if (path === '/me/nearby' && req.method === 'GET') {
    const profile = await getProfile(db, session.user.id, deps.graph);
    return nearbyFor(url, env, ctx, nowMs, deps, profile);
  }

  return json({ error: 'not found' }, 404);
}

function setupAnswer(nowMs: number, label: string, detail: string): Answer {
  return { label, detail, alt: null, stop: { code: '', name: '', confidence: 0 }, quality: 'unknown', asOf: new Date(nowMs).toISOString(), arrivals: [] };
}

export async function nextFor(url: URL, env: Env, ctx: ExecutionContext, nowMs: number, deps: MeDeps, profile: Profile) {
  const { lat, lon } = coordsFrom(url);
  const homeStop = profile.home?.stops[0] ?? null;
  const places = profile.places.map(({ key, label }) => ({ key, label }));

  let dest: { to: string; label: string; why: string; from: string | null; trip?: ImportedTrip | null } | null = null;
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
      label: restLabel(profile, nowMs),
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
    if (plan) dest = { to: plan.to, label: plan.label, why: plan.why, from: plan.from, trip: plan.trip };
  }

  const preferStops = profile.home?.stops ?? [];
  // A class to go to but nowhere to start from: without this the resolver
  // has no stop to check and says "Services ended" at 9 am.
  if (dest && lat === null && !dest.from) {
    return {
      ...setupAnswer(nowMs, 'Add a home stop', 'Pick where your day starts on the account page, or turn on location'),
      mode: 'trip',
      dest: { to: dest.to, label: dest.label, why: dest.why },
      places,
    };
  }
  if (dest) {
    const input: ResolveInput = { lat, lon, to: dest.to, originCode: lat === null ? dest.from : null, preferStops };
    const answer = await deps.answerFor(env, ctx, input, dest.label, nowMs);
    // For a class, say whether you'll make it: stop arrival plus the walk
    // from the stop to the venue, against the start time.
    const venueM = dest.trip?.venue ? (venueToStop(dest.trip.venue)?.m ?? 0) : 0;
    const timing = dest.trip ? timingFor(answer.arriveAt, dest.trip, Math.round(venueM / WALK.speedMs), nowMs) : null;
    return { ...answer, mode: 'trip', dest: { to: dest.to, label: dest.label, why: dest.why }, timing, places };
  }

  // Nothing planned: what's coming at the nearest stop.
  if (lat === null && !homeStop) {
    return { ...setupAnswer(nowMs, 'Set up', 'Add your timetable or home on the account page, or send your location'), mode: 'nearby', dest: null, places };
  }
  const input: ResolveInput = { lat, lon, to: null, originCode: lat === null ? homeStop : null, preferStops };
  const answer = await deps.answerFor(env, ctx, input, null, nowMs);
  return { ...answer, mode: 'nearby', dest: null, places };
}

async function nearbyFor(url: URL, env: Env, ctx: ExecutionContext, nowMs: number, deps: MeDeps, profile: Profile) {
  let { lat, lon } = coordsFrom(url);
  // Without a location, start from the first home stop.
  const homeStop = profile.home ? indexGraph(deps.graph).byCode.get(profile.home.stops[0]) : undefined;
  if (lat === null && homeStop) ({ lat, lon } = homeStop);
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
