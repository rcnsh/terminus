/**
 * The personal layer: sign-in, pairing, profile, and the answers that use
 * them (/me/next, /me/nearby). Everything here needs the DB binding; the
 * public routes in index.ts never do.
 */

import { mailFeedback, parseFeedback, saveFeedback } from './feedback.ts';
import { approvable, decide, enterCode, mergeAnonymous, pollAppLogin, startAppLogin } from './applogin.ts';
import type { Answer, Env, Graph, MeAnswer, ResolveInput, StopArrivals } from './types.ts';
import {
  ACCOUNT_TTL,
  type SessionInfo,
  authenticate,
  clientFrom,
  createAnonymous,
  createPairCode,
  mailDeviceChange,
  deleteAccount,
  endAllSessions,
  exportAccount,
  verifyTurnstile,
  endSession,
  listDevices,
  loadProfileJson,
  normalizeEmail,
  normalizePairCode,
  tokenFrom,
  linkEmail,
  pairCodeOwner,
  maskEmail,
  createAnonymousWeb,
  redeemCode,
  redeemLink,
  redeemPairCode,
  renewWebSession,
  requestLink,
  revokeDevice,
  saveProfileJson,
  sessionCookie,
  PLATFORMS,
} from './accounts.ts';
import { DEFAULT_PROFILE, PROFILE_LIMITS, type Profile, classKey, classesOn, parseProfile, planChangesAt, reimportReason } from './profile.ts';
import { hour12, planned, resolveTo } from './next.ts';
import { dayPlan } from './day.ts';
import { type Boarded, type DayRecord, PLATE_WINDOW_S, SIGNALS, type TripRecord, clearTrip, isHomeKey, loadDay, markFollowed, savePlan, saveSignal, sgtDate, watchTrip } from './trip.ts';
import { nudgeUser, pushEnabled, setPushToken } from './push.ts';
import { WEB_PREFIX, parseSubscription, vapidPublicKey, webPushEnabled } from './webpush.ts';
import { NO_PREFS, type PrefKind, type TripPrefs, clearHistory, clearOutcome, historySize, listPrefs, recordOutcome, setPref, tripPrefs } from './outcomes.ts';
import { ImportInputError, parseShareUrl, resolveTrips } from './nusmods.ts';
import { termName } from './calendar.ts';
import { boardAt, indexGraph, rideStops } from './resolve.ts';
import { CORRIDOR_M, type Fix, atStopOf, departedAt, detect, fixOf, mayDetect, onRoute } from './detect.ts';
import { mayRecordRide, recordRide } from './ridetimes.ts';
import { haversineM } from './geo.ts';
import { isoSeconds } from './format.ts';
import { cardFor, nextPhaseAt } from './card.ts';
import { RIDE, WALK, sgt } from './config.ts';
import { landmark } from './landmarks.ts';
import { nearbyTwin } from './graph.ts';
import { ROUTE_COLORS } from './campus.ts';
import { residenceStops } from './residences.ts';
import { MAX_KEYS, createKey, listKeys, revokeKey } from './access.ts';
import { footM, paceSpeed } from './walk.ts';
import { clientKey, coordsFrom, json } from './http.ts';
import { siteOrigin } from './site.ts';
import { LANG_PREFS, lang, m, useProfileLang } from './i18n.ts';

export interface MeDeps {
  graph: Graph;
  answerFor: (env: Env, ctx: ExecutionContext, input: ResolveInput, label: string | null, nowMs: number) => Promise<Answer>;
  collectArrivals: (env: Env, ctx: ExecutionContext, codes: string[], nowMs: number) => Promise<Map<string, StopArrivals>>;
}

const html = (body: string, status = 200, extra: Record<string, string> = {}) =>
  new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...extra } });

/** Minimal pages served by the Worker itself, in the site's style. */
const page = (title: string, inner: string) => `<!doctype html>
<html lang="${lang() === 'zh' ? 'zh-Hans' : 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${title} · terminus</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Space+Grotesk:wght@500;600;700&display=swap">
<link rel="stylesheet" href="/assets/site.css">
<style>.box{max-width:25rem;margin:10vh auto 0;padding:32px 28px}.box img{width:44px;height:44px;margin-bottom:20px}.box h1{font-size:1.6rem;margin-bottom:8px}.box .btn{width:100%;margin-top:20px}.choices{display:flex;gap:10px;margin-top:20px}.box .choices .btn{flex:1;margin:0;font-size:1.5rem;font-variant-numeric:tabular-nums}.linkbtn{display:block;margin:18px auto 0;background:none;border:0;color:inherit;opacity:.7;text-decoration:underline;font:inherit;cursor:pointer}</style>
</head><body><main class="wrap"><div class="card box"><img src="/assets/mark.svg" alt="">${inner}</div></main></body></html>`;

/** A whole profile is a few KB; nothing legitimate comes close to this. */
const MAX_BODY_BYTES = 64 * 1024;


/**
 * Where emailed links point. The request's own origin only for local
 * development; otherwise always this Worker's site (stable or beta), whatever
 * hostname the request came in on (a workers.dev preview).
 */
function linkOrigin(url: URL, env: Env): string {
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname.endsWith('.test');
  return local ? url.origin : siteOrigin(env);
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);


const mailFailed = (e: unknown) => console.error('device email failed', e instanceof Error ? e.name : typeof e);

/**
 * A trip key a client sent: one of the profile's classes, or a trip home.
 * The key becomes stored rows (signals, outcomes, choices), so anything
 * else would let a script make as many as it likes.
 */
function knownTrip(profile: Profile, key: string): boolean {
  if (/^home:(\d{1,4}|evening)$/.test(key) || /^gap-home:[A-Za-z0-9_-]{1,24}$/.test(key)) return true;
  return [...profile.trips, ...profile.manual].some((t) => classKey(t) === key);
}

/** "Pixel 8": what the app calls itself, shown in emails and the device list. */
function deviceName(body: Record<string, unknown> | null): string {
  if (typeof body?.name !== 'string') return 'Device';
  // It goes into sign-in emails: a device's name, not a message. Letters,
  // digits and a little punctuation; no links, no line breaks.
  const name = body.name
    .replace(/[^\p{L}\p{N} ()'_-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);
  return name || 'Device';
}

/** The client header, or the platform an app names in its body when it has no header. */
function clientWith(req: Request, body: Record<string, unknown> | null) {
  const c = clientFrom(req);
  if (c.client) return c;
  const named = PLATFORMS.find((p) => p === body?.platform);
  return named ? { ...c, platform: named } : c;
}

/** "14:05, 30 Sep" in Singapore time. */
function sgtTime(ms: number): string {
  const d = new Date(ms + 8 * 3_600_000);
  const hm = `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  if (lang() === 'zh') return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日 ${hm}`;
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()];
  return `${hm}, ${d.getUTCDate()} ${month}`;
}

async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  if (!(req.headers.get('content-type') ?? '').includes('application/json')) return null;
  // Refuse a big body before reading it, not after.
  if (Number(req.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) return null;
  try {
    const text = await readCapped(req, MAX_BODY_BYTES);
    if (text === null) return null;
    const body = JSON.parse(text);
    return typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** A sign-in form: a token or two, never more than a few KB. Refused unread when bigger. */
const MAX_FORM_BYTES = 4096;
async function readForm(req: Request): Promise<URLSearchParams | null> {
  if (Number(req.headers.get('content-length') ?? 0) > MAX_FORM_BYTES) return null;
  const text = await readCapped(req, MAX_FORM_BYTES).catch(() => null);
  return text !== null ? new URLSearchParams(text) : null;
}

/**
 * The body as text, or null once it passes `max` bytes. Read in pieces, so a
 * chunked body (no content-length to refuse up front) can't fill memory.
 */
export async function readCapped(req: Request, max: number): Promise<string | null> {
  if (!req.body) return '';
  const reader = req.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    parts.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.byteLength;
  }
  return new TextDecoder().decode(all);
}

async function limited(env: Env, req: Request, scope: string): Promise<boolean> {
  if (!env.RL_AUTH) return false;
  const { success } = await env.RL_AUTH.limit({ key: `${scope}:${clientKey(req)}` });
  return !success;
}

/** The account's profile, checked against today's stops. `raw`: the saved JSON, when the caller has already read it. */
export async function getProfile(db: D1Database, userId: string, graph: Graph, raw?: unknown): Promise<Profile> {
  if (raw === undefined) raw = await loadProfileJson(db, userId);
  if (!raw) return structuredClone(DEFAULT_PROFILE);
  const idx = indexGraph(graph);
  // A stop can vanish from a new scrape. Re-validating on read would reject
  // the whole profile, so drop only what no longer resolves.
  const r = parseProfile(raw, (c) => idx.byCode.has(c), (c) => idx.byCode.has(c) || landmark(c) !== null);
  // The language the account chose wins over the device's, for the rest of this request.
  if (r.ok) {
    useProfileLang(r.profile.lang);
    return r.profile;
  }
  const p = raw as Profile;
  useProfileLang(LANG_PREFS.includes(p.lang) ? p.lang : 'auto');
  return salvageProfile(p, (c) => idx.byCode.has(c) || landmark(c) !== null);
}

/**
 * A saved profile that no longer validates whole (a stop gone from a new
 * scrape): everything that still holds, so the next save doesn't write the
 * user's hours, usual times or one-off trips back as the defaults.
 */
export function salvageProfile(p: Profile, ok: (code: string) => boolean): Profile {
  const minute = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 24 * 60;
  const hours = minute(p.dayStartMin) && minute(p.dayEndMin) && p.dayStartMin < p.dayEndMin;
  const places = (p.places ?? []).filter((x) => ok(x.to));
  const placeKeys = new Set(places.map((x) => x.key));
  return {
    ...structuredClone(DEFAULT_PROFILE),
    gapHours: typeof p.gapHours === 'number' ? p.gapHours : DEFAULT_PROFILE.gapHours,
    homeWalkMin: typeof p.homeWalkMin === 'number' ? p.homeWalkMin : DEFAULT_PROFILE.homeWalkMin,
    walkPace: p.walkPace ?? DEFAULT_PROFILE.walkPace,
    fullBusMargin: p.fullBusMargin ?? DEFAULT_PROFILE.fullBusMargin,
    ...(hours ? { dayStartMin: p.dayStartMin, dayEndMin: p.dayEndMin } : {}),
    seen: Array.isArray(p.seen) ? p.seen : [],
    home: p.home?.stops?.some(ok) ? { stops: p.home.stops.filter(ok) } : null,
    trips: (p.trips ?? []).filter((t) => ok(t.to)),
    manual: (p.manual ?? []).filter((t) => ok(t.to)),
    places,
    usual: (Array.isArray(p.usual) ? p.usual : []).filter((u) => placeKeys.has(u.place) && Number.isInteger(u.day) && u.day >= 0 && u.day <= 6 && minute(u.atMin)),
    once: (Array.isArray(p.once) ? p.once : []).filter((o) => typeof o.date === 'string' && minute(o.arriveByMin) && ok(o.to)),
    share: p.share ?? null,
    term: p.term ?? null,
    lang: LANG_PREFS.includes(p.lang) ? p.lang : 'auto',
  };
}

interface MeContext {
  req: Request;
  url: URL;
  env: Env;
  ctx: ExecutionContext;
  nowMs: number;
  deps: MeDeps;
  db: D1Database;
  session: SessionInfo;
  /** What follows a prefix path ("/me/keys/<id>"). */
  rest: string;
}

interface MeRoute {
  method: string;
  /** Exact, or a prefix when it ends in '/'. */
  path: string;
  /**
   * 'web': changes the account itself, from the account page only, never a
   * device (API keys, sign out everywhere). 'email': any session, but the
   * account needs an email, because each use emails its owner (devices).
   */
  access?: 'web' | 'email';
  run: (c: MeContext) => Promise<Response>;
}

/**
 * The plate of the `svc` bus at `stopCode` right now: the one due soonest,
 * within a few minutes (at the tap it's pulling in or just leaving). Empty
 * when the feed has no plates or no such bus is near, so the ride falls back
 * to the estimate.
 */
async function plateAt(env: Env, ctx: ExecutionContext, deps: MeDeps, stopCode: string | undefined, svc: string, nowMs: number): Promise<{ plate?: string }> {
  if (!stopCode) return {};
  try {
    const sa = (await deps.collectArrivals(env, ctx, [stopCode], nowMs)).get(stopCode);
    const near = (sa?.arrivals ?? [])
      .filter((x) => x.svc === svc && x.plate && x.etaS !== null && x.etaS <= PLATE_WINDOW_S)
      .sort((x, y) => x.etaS! - y.etaS!)[0];
    return near?.plate ? { plate: near.plate } : {};
  } catch {
    return {};
  }
}

/** A `waiting` record is written again after this, while fixes keep saying you're at the stop. */
const WAITING_REFRESH_MS = 10 * 60_000;

/**
 * After a miss at the stop, the bus a fix at speed is on: any service from
 * that stop to where the missed one went, whose road the fix is on. Its
 * departure is now and its arrival the usual time per stop from here.
 */
function nextBusFrom(graph: Graph, missed: Boarded | null, fix: Fix, nowMs: number): Boarded | null {
  if (!missed?.stopCode || !missed.alightCode) return null;
  const idx = indexGraph(graph);
  for (const svc of idx.servingStop.get(missed.stopCode) ?? []) {
    const stops = rideStops(idx, svc, missed.stopCode, missed.alightCode);
    if (!stops || stops.length < 2) continue;
    const bus: Boarded = { svc, stop: missed.stop, board: new Date(nowMs).toISOString(), arrive: new Date(nowMs + (stops.length - 1) * RIDE.secondsPerHop * 1000).toISOString(), stopCode: missed.stopCode, alightCode: missed.alightCode, ...(missed.off && svc === missed.svc ? { off: missed.off } : {}) };
    if (onRoute(graph, bus, fix, CORRIDOR_M + Math.min(fix.accM ?? 0, 60))) return bus;
  }
  return null;
}

/**
 * The plate of a bus detection just saw you board: it has left the boarding
 * stop, so it's the service's first bus due at the next stop on the ride.
 */
async function plateOnBoard(env: Env, ctx: ExecutionContext, deps: MeDeps, b: Boarded, nowMs: number): Promise<{ plate?: string }> {
  if (!b.stopCode || !b.alightCode) return {};
  const stops = rideStops(indexGraph(deps.graph), b.svc, b.stopCode, b.alightCode);
  return plateAt(env, ctx, deps, stops?.[1], b.svc, nowMs);
}

/** Everything that needs a session, by method and path. */
const ME_ROUTES: MeRoute[] = [
  {
    method: 'DELETE',
    path: '/me',
    // From the account page; an anonymous account has no page, so its app can.
    run: async ({ env, db, session }) => {
      if (session.kind !== 'web' && session.user.email !== null) return json({ error: 'delete the account from the account page' }, 403);
      await deleteAccount(db, session.user);
      await clearTrip(env, session.user.id);
      return json({ ok: true }, 200, { 'set-cookie': sessionCookie('', 0) });
    },
  },
  {
    method: 'GET',
    path: '/me/export',
    run: async ({ db, session }) => {
      return json(await exportAccount(db, session.user), 200, {
        'content-disposition': 'attachment; filename="terminus-export.json"',
      });
    },
  },
  {
    method: 'DELETE',
    path: '/me/sessions',
    access: 'web',
    run: async ({ db, session }) => {
      // Sign out everywhere, including this browser.
      const ended = await endAllSessions(db, session.user.id);
      return json({ ok: true, ended }, 200, { 'set-cookie': sessionCookie('', 0) });
    },
  },
  {
    method: 'GET',
    path: '/me',
    run: async ({ req, nowMs, deps, db, session }) => {
      // Every page load asks /me first: a web session in use keeps going.
      const token = session.kind === 'web' ? tokenFrom(req) : null;
      const renewed = token !== null && (await renewWebSession(db, session.tokenHash, nowMs));
      const saved = await loadProfileJson(db, session.user.id);
      const profile = await getProfile(db, session.user.id, deps.graph, saved);
      const reason = reimportReason(profile, nowMs);
      return json({
        email: session.user.email,
        anonymous: session.user.email === null,
        kind: session.kind,
        needsReimport: reason !== null,
        reimportReason: reason,
        term: profile.term ? termName(profile.term) : null,
        onboarding: onboardingFor(saved !== null, profile.seen),
      }, 200, renewed && token ? { 'set-cookie': sessionCookie(token, ACCOUNT_TTL.webSessionMs / 1000) } : {});
    },
  },
  {
    method: 'GET',
    path: '/me/profile',
    run: async ({ deps, db, session }) => {
      return json(await getProfile(db, session.user.id, deps.graph));
    },
  },
  {
    method: 'PUT',
    path: '/me/profile',
    run: async ({ req, nowMs, deps, db, session }) => {
      const body = await readJson(req);
      if (!body) return json({ error: 'send the profile as JSON' }, 400);
      const idx = indexGraph(deps.graph);
      const r = parseProfile(body, (c) => idx.byCode.has(c), (c) => idx.byCode.has(c) || landmark(c) !== null);
      if (!r.ok) return json({ error: r.error }, 400);
      // One-off trips are done with once their day has passed.
      r.profile.once = r.profile.once.filter((o) => o.date >= sgtDate(nowMs));
      await saveProfileJson(db, session.user.id, r.profile, nowMs);
      return json(r.profile);
    },
  },
  {
    method: 'POST',
    path: '/me/once',
    run: async ({ req, url, env, ctx, nowMs, deps, db, session }) => {
      // A one-off trip (phase 8.3): "Science library at 14:00 today". Planned
      // like a class on its day; "Not going" drops it. Answers with /me/next.
      const body = await readJson(req);
      const profile = await getProfile(db, session.user.id, deps.graph);
      // A favourite by its key, or a stop, food court or room by its code.
      const saved = typeof body?.place === 'string' ? profile.places.find((p) => p.key === body.place) : undefined;
      const dest = saved ? { to: saved.to, label: saved.label } : typeof body?.to === 'string' ? resolveTo(deps.graph, body.to) : null;
      if (!dest) return json({ error: "send place (a favourite's key) or to (a stop, place or room code)" }, 400);
      const atMin = body?.atMin;
      if (typeof atMin !== 'number' || !Number.isInteger(atMin) || atMin < 0 || atMin > 1439) return json({ error: 'atMin must be minutes past midnight, Singapore time' }, 400);
      const today = sgtDate(nowMs);
      const date = typeof body?.date === 'string' ? body.date : today;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < today || date > sgtDate(nowMs + 7 * 86_400_000)) return json({ error: 'date must be today or within the next week (YYYY-MM-DD)' }, 400);
      if (date === today && atMin <= sgt(nowMs).minutes) return json({ error: 'that time has passed today' }, 400);
      const label = typeof body?.label === 'string' && body.label.trim() ? body.label.trim().slice(0, PROFILE_LIMITS.label) : dest.label;
      const once = profile.once.filter((o) => o.date >= today && !(o.date === date && o.arriveByMin === atMin && o.to === dest.to));
      if (once.length >= PROFILE_LIMITS.once) return json({ error: m().tooManyOnce(PROFILE_LIMITS.once) }, 400);
      once.push({ date, arriveByMin: atMin, to: dest.to, label });
      once.sort((a, b) => a.date.localeCompare(b.date) || a.arriveByMin - b.arriveByMin);
      const next = { ...profile, once };
      await saveProfileJson(db, session.user.id, next, nowMs);
      const [day, prefs] = await Promise.all([tripDay(env, session.user.id, next, nowMs), prefsFor(db, session.user.id, next, nowMs)]);
      return json(await nextBody(url, env, ctx, nowMs, deps, next, day, session.user.id, prefs));
    },
  },
  {
    method: 'POST',
    path: '/me/import',
    run: async ({ env, req, nowMs, deps, db, session }) => {
      // Each import can fetch 15 modules from NUSMods: a few a minute per account, not 120.
      if (env.RL_AUTH && !(await env.RL_AUTH.limit({ key: `import:${session.user.id}` })).success) {
        return json({ error: 'too many attempts, try again in a minute' }, 429);
      }
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
        return json({ error: m().nusmodsNoAnswer(r.failed.join(', ')), failed: r.failed }, 502);
      }
      if (!r.trips.length && !r.unresolved.length) {
        const why = r.missing.length ? m().modsNoClasses(r.missing.join(', '), r.missing.length !== 1, term) : m().linkNoClasses(term);
        return json({ error: m().nothingImported(why), missing: r.missing }, 422);
      }
      const profile = await getProfile(db, session.user.id, deps.graph);
      profile.trips = r.trips.slice(0, PROFILE_LIMITS.trips);
      profile.share = share;
      profile.term = r.term;
      await saveProfileJson(db, session.user.id, profile, nowMs);
      return json({ profile, unresolved: r.unresolved, missing: r.missing, online: r.online, term });
    },
  },
  {
    method: 'POST',
    path: '/me/pair-code',
    access: 'email',
    run: async ({ nowMs, db, session }) => {
      return json(await createPairCode(db, session.user.id, nowMs));
    },
  },
  {
    method: 'GET',
    path: '/me/keys',
    run: async ({ db, session }) => {
      return json({ keys: await listKeys(db, session.user.id) });
    },
  },
  {
    method: 'POST',
    path: '/me/keys',
    access: 'web',
    run: async ({ req, nowMs, db, session }) => {
      // Made on the account page, not from a phone that happens to be paired.
      const body = await readJson(req);
      const name = typeof body?.name === 'string' ? body.name.trim().slice(0, 40) : '';
      if (!name) return json({ error: 'give the key a name, so you know what uses it' }, 400);
      const made = await createKey(db, session.user.id, name, nowMs);
      if (!made) return json({ error: m().tooManyKeys(MAX_KEYS) }, 409);
      return json(made, 201);
    },
  },
  {
    method: 'DELETE',
    path: '/me/keys/',
    access: 'web',
    run: async ({ db, session, rest }) => {
      const ok = await revokeKey(db, session.user.id, rest);
      return ok ? json({ ok: true }) : json({ error: 'no such key' }, 404);
    },
  },
  {
    method: 'GET',
    path: '/me/devices',
    run: async ({ db, session }) => {
      return json({ devices: await listDevices(db, session.user.id, session.tokenHash) });
    },
  },
  {
    method: 'DELETE',
    path: '/me/devices/',
    access: 'email',
    run: async ({ env, ctx, nowMs, db, session, rest }) => {
      const name = await revokeDevice(db, session.user.id, rest);
      if (name === null) return json({ error: 'no such device' }, 404);
      ctx.waitUntil(mailDeviceChange(env, session.user.email, 'removed', name, nowMs).catch(mailFailed));
      return json({ ok: true });
    },
  },
  {
    method: 'GET',
    path: '/me/next',
    run: async ({ url, env, ctx, nowMs, deps, db, session }) => {
      const profile = await getProfile(db, session.user.id, deps.graph);
      const [day, prefs] = await Promise.all([tripDay(env, session.user.id, profile, nowMs), prefsFor(db, session.user.id, profile, nowMs)]);
      return json(await nextBody(url, env, ctx, nowMs, deps, profile, day, session.user.id, prefs));
    },
  },
  {
    method: 'GET',
    path: '/me/day',
    run: async ({ url, env, ctx, nowMs, deps, db, session }) => {
      const profile = await getProfile(db, session.user.id, deps.graph);
      const [day, prefs] = await Promise.all([tripDay(env, session.user.id, profile, nowMs), prefsFor(db, session.user.id, profile, nowMs)]);
      return json(await dayPlan(env, ctx, nowMs, deps, profile, day, hour12(url), prefs.earlier, coordsFrom(url)));
    },
  },
  {
    method: 'POST',
    path: '/me/signal',
    run: async ({ req, url, env, ctx, nowMs, deps, db, session }) => {
      // "On the D2", "Missed it", "Not going", "I'm there", a location: what
      // actually happened, for every device. Answers with the new /me/next.
      if (!env.TRIPS) return json({ error: 'trip tracking is not available' }, 503);
      const body = await readJson(req);
      const kind = SIGNALS.find((k) => k === body?.kind);
      if (!kind) return json({ error: m().signalKinds(SIGNALS.join(', ')) }, 400);
      const profile = await getProfile(db, session.user.id, deps.graph);
      // A location travels in the body; it's used for this answer and not kept.
      const here = new URL(url);
      if (typeof body?.lat === 'number' && typeof body?.lon === 'number') {
        here.searchParams.set('lat', String(body.lat));
        here.searchParams.set('lon', String(body.lon));
      }
      const day = await loadDay(env, session.user.id, nowMs);
      if (kind === 'away' || kind === 'back') {
        // "Not on campus today" skips every trip left today (not the ones
        // already answered); "Back on campus" brings them all back. Neither is
        // an outcome: a day away says nothing about a class.
        let after = day;
        if (kind === 'away') {
          for (const c of classesOn(profile, nowMs)) {
            const k = classKey(c);
            const r = day?.trips[k];
            if (r && r.kind !== 'waiting' && r.kind !== 'undetected') continue;
            after = await saveSignal(env, session.user.id, k, { kind: 'skipped', at: nowMs, label: c.label, away: true }, nowMs);
          }
        } else {
          for (const [k, r] of Object.entries(day?.trips ?? {})) if (r.away) after = await saveSignal(env, session.user.id, k, null, nowMs);
        }
        logSignal(env, kind);
        const prefs = await prefsFor(db, session.user.id, profile, nowMs);
        const out = await nextBody(url, env, ctx, nowMs, deps, profile, after, session.user.id, prefs);
        ctx.waitUntil(nudgeUser(env, session.user.id, { phase: out.card.phase, ask: out.card.ask !== null, urgent: false, remind: out.card.remind !== false }, nowMs, session.tokenHash));
        return json(out);
      }
      const now = await planned(here, env, ctx, nowMs, deps, profile, day);
      const key = typeof body?.trip === 'string' && body.trip ? body.trip.slice(0, 80) : now.trip.key;
      if (!key) return json({ error: 'no trip in progress to say that about' }, 409);
      if (key !== now.trip.key && !knownTrip(profile, key)) return json({ error: 'no such trip today' }, 400);
      const current = key === now.trip.key;
      let followedDay: DayRecord | null = null;
      // After the planned bus has left, "On it" and "Missed it" are about that
      // bus (the plan), not the next one the answer has moved on to.
      const p = current ? now.trip.plan : null;
      const gone = p?.board ? Date.parse(p.board) <= nowMs + 60_000 : false;
      const l = current
        ? gone && p
          ? { ...now.answer.leave, svc: p.svc, stop: p.stop, board: p.board, arrive: p.arrive, off: p.off, stopCode: p.stopCode, offCode: p.alightCode }
          : now.answer.leave
        : null;
      const label = current ? (now.answer.dest?.label ?? undefined) : classesOn(profile, nowMs).find((c) => classKey(c) === key)?.label;
      let rec: TripRecord | null | undefined;
      switch (kind) {
        case 'reset':
          rec = null;
          break;
        case 'location': {
          // Only what the location means is kept, never the location (detect.ts).
          const fix = fixOf(body);
          const prev = current ? day?.trips[key] : undefined;
          // Being followed: the card stops asking what happened. Noted once a minute at most.
          if (fix && current && !(day?.followed && nowMs - day.followed < 60_000)) {
            const marked = await markFollowed(env, session.user.id, nowMs).catch(() => null);
            if (marked) followedDay = marked;
          }
          if (!current || !fix) {
            rec = undefined;
            break;
          }
          // The bus it's about: the plan; after a miss at the stop, whichever
          // bus from that stop to the same place this fix is on the road of.
          const bus: Boarded | null = prev?.kind === 'missed' && prev.atStop ? nextBusFrom(deps.graph, now.trip.plan ?? null, fix, nowMs) : (now.trip.plan ?? null);
          const seen = detect({ phase: now.trip.phase, rec: prev, bus, arrivedHere: Boolean(now.answer.arrived), fix, homeStops: profile.home?.stops ?? [], graph: deps.graph, nowMs });
          if (seen === 'arrived') {
            const onBus = prev?.kind === 'boarded' ? prev.boarded : now.trip.phase === 'riding' ? (now.trip.plan ?? undefined) : undefined;
            rec = { kind: 'arrived', at: nowMs, label, detected: true, ...(onBus ? { boarded: onBus } : {}) };
            // A ride seen from start to end: how long it really took (phase 8.2).
            if (onBus?.departed && env.DB) {
              const rides = env.DB;
              ctx.waitUntil(mayRecordRide(env, rides, session.user.id, onBus.svc, nowMs).then((ok) => (ok ? recordRide(rides, deps.graph, onBus, nowMs) : null)).catch(() => null));
            }
          } else if (seen === 'boarded' && bus) {
            rec = {
              kind: 'boarded',
              at: nowMs,
              label,
              detected: true,
              boarded: { ...bus, departed: new Date(departedAt(deps.graph, bus, fix, nowMs)).toISOString(), ...(await plateOnBoard(env, ctx, deps, bus, nowMs)) },
            };
          } else if (seen === 'missed' && (bus || prev?.boarded)) {
            // The bus it's about: the plan, or the one you were taken to be on.
            const about = prev?.kind === 'boarded' && prev.boarded ? prev.boarded : bus!;
            rec = { kind: 'missed', at: nowMs, label, detected: true, missed: about.board, ...(atStopOf(deps.graph, about, fix) ? { atStop: true } : {}) };
          } else if (prev?.kind === 'missed' && prev.detected && !prev.atStop && atStopOf(deps.graph, now.trip.plan ?? null, fix)) {
            // Missed it at home, and now at the stop: the next bus can be noticed too.
            rec = { ...prev, atStop: true };
          } else if (now.trip.phase === 'waiting' && mayDetect(prev) && prev?.kind !== 'boarded' && !(prev?.kind === 'waiting' && nowMs - prev.at < WAITING_REFRESH_MS)) {
            // At the stop: what makes a fast fix later count as the bus.
            // Written again only now and then: the phone sends a fix every 20 s.
            rec = { kind: 'waiting', at: nowMs, label };
          } else {
            rec = undefined;
          }
          break;
        }
        case 'undetected': {
          // "Not on the bus", "Didn't miss it", "Not there yet": detection got
          // it wrong. A detected arrival goes back to the ride it ended, and
          // detection leaves the trip alone from now on.
          const prev = day?.trips[key];
          rec =
            prev?.kind === 'arrived' && prev.boarded
              ? { kind: 'boarded', at: nowMs, label: prev.label ?? label, boarded: prev.boarded, noDetect: true }
              : { kind: 'undetected', at: nowMs, label: prev?.label ?? label };
          break;
        }
        case 'boarded':
          // No bus to be on (a walk, or an old card): you've set off.
          if (!l?.svc) {
            rec = { kind: 'left', at: nowMs, label };
            break;
          }
          rec = {
            kind,
            at: nowMs,
            label,
            boarded: {
              svc: l.svc,
              stop: l.stop ?? '',
              board: l.board,
              arrive: l.arrive,
              ...(l.off ? { off: l.off } : {}),
              ...(l.stopCode ? { stopCode: l.stopCode } : {}),
              ...(now.answer.dest?.to ? { alightCode: l.offCode ?? now.answer.dest.to } : {}),
              ...(await plateAt(env, ctx, deps, l.stopCode, l.svc, nowMs)),
            },
          };
          break;
        case 'missed':
          rec = { kind, at: nowMs, label, missed: l?.board ?? null };
          break;
        default:
          rec = { kind, at: nowMs, label };
      }
      const next = rec === undefined ? (followedDay ?? day) : await saveSignal(env, session.user.id, key, rec, nowMs);
      logSignal(env, rec?.detected ? `detected:${rec.kind}` : kind);
      // What happened to the trip, for what terminus learns (outcomes.ts).
      const outcome = rec ? OUTCOME_OF[rec.kind] : undefined;
      if (rec === null || rec?.kind === 'undetected') await clearOutcome(db, session.user.id, key, nowMs);
      // A trip home isn't a class: nothing to learn from skipping it.
      else if (outcome && !/^(gap-)?home:/.test(key)) await recordOutcome(db, session.user.id, key, outcome, nowMs);
      const prefs = await prefsFor(db, session.user.id, profile, nowMs);
      const out = await nextBody(url, env, ctx, nowMs, deps, profile, next, session.user.id, prefs);
      // A tap here changes the other phones' cards now, not at their next refresh.
      // Being at the stop isn't worth waking them for.
      if (rec !== undefined && rec?.kind !== 'waiting') {
        ctx.waitUntil(nudgeUser(env, session.user.id, { phase: out.card.phase, ask: out.card.ask !== null, urgent: false, remind: out.card.remind !== false }, nowMs, session.tokenHash));
      }
      return json(out);
    },
  },
  {
    method: 'POST',
    path: '/me/push',
    run: async ({ req, env, db, session }) => {
      // This device's push address: the Trip object nudges it when the card
      // changes. An app sends its Firebase token; the web app its Web Push
      // subscription (PushSubscription.toJSON()).
      const body = await readJson(req);
      if (body?.subscription !== undefined) {
        if (!webPushEnabled(env)) return json({ error: 'web push is not set up on this server' }, 503);
        const sub = parseSubscription(body.subscription);
        if (!sub) return json({ error: 'send subscription: an https endpoint with keys.p256dh and keys.auth' }, 400);
        await setPushToken(db, session.tokenHash, WEB_PREFIX + JSON.stringify(sub));
        return json({ ok: true });
      }
      const token = typeof body?.token === 'string' ? body.token.trim() : '';
      if (!token || token.length > 4096 || token.startsWith(WEB_PREFIX)) return json({ error: 'send token (the FCM registration token) or subscription' }, 400);
      await setPushToken(db, session.tokenHash, token);
      return json({ ok: true });
    },
  },
  {
    method: 'GET',
    path: '/me/push/key',
    run: async ({ env }) => {
      // What the web app subscribes with (applicationServerKey).
      const key = vapidPublicKey(env);
      return key ? json({ key }) : json({ error: 'web push is not set up on this server' }, 503);
    },
  },
  {
    method: 'DELETE',
    path: '/me/push',
    run: async ({ db, session }) => {
      await setPushToken(db, session.tokenHash, null);
      return json({ ok: true });
    },
  },
  {
    method: 'POST',
    path: '/me/choice',
    run: async ({ req, nowMs, deps, db, session }) => {
      // A suggestion accepted or turned down ({id, choice}), or an accepted
      // one undone from settings ({trip, pref, choice: 'undo'}).
      const body = await readJson(req);
      const choice = CHOICES.find((c) => c === body?.choice);
      const [pref, trip] =
        typeof body?.id === 'string' && body.id.includes(':')
          ? [body.id.slice(0, body.id.indexOf(':')), body.id.slice(body.id.indexOf(':') + 1)]
          : [body?.pref, body?.trip];
      if (!choice || (pref !== 'earlier' && pref !== 'quiet') || typeof trip !== 'string' || !trip || trip.length > 80) {
        return json({ error: "send id (from card.suggestion) or trip and pref ('earlier' or 'quiet'), and choice: accept, dismiss or undo" }, 400);
      }
      const profile = await getProfile(db, session.user.id, deps.graph);
      if (!knownTrip(profile, trip)) return json({ error: 'no such trip today' }, 400);
      const label = [...profile.trips, ...profile.manual].find((t) => classKey(t) === trip)?.label ?? null;
      await setPref(db, session.user.id, trip, pref as PrefKind, choice, label, nowMs);
      return json({ ok: true, choices: await listPrefs(db, session.user.id) });
    },
  },
  {
    method: 'GET',
    path: '/me/choices',
    run: async ({ db, session }) => {
      // askMuted: always false now that nothing is asked; kept for older apps.
      return json({ choices: await listPrefs(db, session.user.id), askMuted: false, history: await historySize(db, session.user.id) });
    },
  },
  {
    method: 'DELETE',
    path: '/me/history',
    run: async ({ db, session }) => {
      // "Clear trip history": the outcomes go, the choices made from them stay.
      const cleared = await clearHistory(db, session.user.id);
      return json({ ok: true, cleared });
    },
  },
  {
    method: 'POST',
    path: '/me/ask',
    run: async () => {
      // "Ask if I caught the bus" back on, from older apps. Nothing is asked
      // any more (the trip follows the plan and the phone's location), so
      // there's nothing to turn on.
      return json({ ok: true, askMuted: false });
    },
  },
  {
    method: 'POST',
    path: '/me/feedback',
    run: async ({ req, env, ctx, nowMs, db, session }) => {
      const parsed = parseFeedback(await readJson(req));
      if (!parsed.ok) return json({ error: parsed.error }, 400);
      const id = await saveFeedback(db, session.user.id, parsed.value, nowMs);
      if (!id) return json({ error: "that's a lot of reports for one day; thanks, try again tomorrow" }, 429);
      ctx.waitUntil(
        mailFeedback(env, id, session.user.email ?? 'an anonymous account', parsed.value, nowMs).catch((e) =>
          console.error('feedback email failed', e instanceof Error ? e.name : typeof e),
        ),
      );
      return json({ ok: true, id }, 201);
    },
  },
  {
    method: 'GET',
    path: '/me/nearby',
    run: async ({ url, env, ctx, nowMs, deps, db, session }) => {
      const profile = await getProfile(db, session.user.id, deps.graph);
      return nearbyFor(url, env, ctx, nowMs, deps, profile);
    },
  },
];

/** The browser's own account without an email, when its session is one: a sign-in from it adds the email there. */
async function browserAnon(db: D1Database, req: Request, nowMs: number): Promise<string | null> {
  const s = await authenticate(db, req, nowMs);
  return s?.kind === 'web' && s.user.email === null ? s.user.id : null;
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
  // GET /pair is the page the pairing QR code opens (a phone without the
  // app); only the POST is the API.
  if (!(path.startsWith('/auth/') || (path === '/pair' && req.method === 'POST') || path === '/pair/check' || path === '/me' || path.startsWith('/me/'))) return null;
  const db = env.DB;
  if (!db) return json({ error: 'accounts are not configured' }, 503);
  // Form posts that set or end the browser's session come from our own pages.
  // Without this, another site could post a sign-in link it holds and sign
  // the visitor in to its account, or sign them out. Apps send no such header.
  const fetchSite = req.headers.get('sec-fetch-site');
  if (req.method === 'POST' && (path === '/auth/verify' || path === '/auth/approve' || path === '/auth/logout') && fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') {
    return json({ error: 'that request came from another site' }, 403);
  }

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
      await requestLink(env, db, email, linkOrigin(url, env), nowMs, body?.next === '/app/');
    } catch (err) {
      // The error text can carry the recipient: log its kind only.
      console.error('sign-in email failed', err instanceof Error ? err.name : typeof err);
      return json({ error: 'could not send the email, try again later' }, 502);
    }
    // Same answer whether or not the address is blocked or already has an account.
    return json({ ok: true, message: m().checkEmail });
  }

  if (path === '/auth/code' && req.method === 'POST') {
    // The emailed code, typed on the page that asked for it.
    if (await limited(env, req, 'code')) return json({ error: 'too many attempts, try again in a minute' }, 429);
    const body = await readJson(req);
    const email = normalizeEmail(body?.email);
    const code = normalizePairCode(body?.code);
    if (!email || !code) return json({ error: 'enter the 6-character code from the email' }, 400);
    const done = await redeemCode(env, db, email, code, nowMs, await browserAnon(db, req, nowMs));
    if (!done) return json({ error: 'that code is wrong or has expired' }, 400);
    if (done.removed) await clearTrip(env, done.removed);
    return json({ ok: true }, 200, { 'set-cookie': sessionCookie(done.token, ACCOUNT_TTL.webSessionMs / 1000), 'cache-control': 'no-store' });
  }

  if (path === '/auth/verify') {
    if (req.method === 'GET') {
      // Mail scanners (Outlook Safe Links) open every link in an email. If
      // opening the link spent it, the user's own click would fail. So GET
      // only shows a button; the POST spends the token.
      const t = url.searchParams.get('t') ?? '';
      const safe = t.replace(/[^A-Za-z0-9_-]/g, '');
      // Name the account, so a link someone else requested can't sign you in
      // to their account without you noticing. A dead link says so now.
      const email = safe ? await linkEmail(db, safe, nowMs) : null;
      if (!email) return html(page(m().pageLinkExpired, m().linkExpiredHtml), 400);
      return html(page(m().pageSignIn, `<h1>${m().signInTitle}</h1>
<p class="hint">${m().continueAs(escapeHtml(maskEmail(email)))}</p>
<form method="post" action="/auth/verify"><input type="hidden" name="t" value="${safe}">${url.searchParams.get('next') === 'app' ? '<input type="hidden" name="next" value="app">' : ''}<button type="submit" class="btn accent">${m().signInButton}</button></form>`));
    }
    if (req.method === 'POST') {
      const form = await readForm(req);
      const t = form?.get('t');
      const done = typeof t === 'string' ? await redeemLink(db, t, nowMs, await browserAnon(db, req, nowMs)) : null;
      if (done?.removed) await clearTrip(env, done.removed);
      const token = done?.token;
      if (!token) {
        return html(page(m().pageLinkExpired, m().linkExpiredHtml), 400);
      }
      // Only ever one of two places: the account page, or (by way of it, for
      // first-time setup) the web app.
      const location = form?.get('next') === 'app' ? '/account/?next=/app/' : '/account';
      return new Response(null, {
        status: 303,
        headers: { location, 'set-cookie': sessionCookie(token, ACCOUNT_TTL.webSessionMs / 1000), 'cache-control': 'no-store' },
      });
    }
  }

  if (path === '/auth/anon' && req.method === 'POST') {
    // An app's first launch: an account with no email, so it's useful
    // before any sign-in. Apps can't run Turnstile, so: per IP, one global
    // ceiling, and the cron deletes the ones left unused.
    if (await limited(env, req, 'anon')) return json({ error: 'too many attempts, try again in a minute' }, 429);
    if (env.RL_ANON && !(await env.RL_ANON.limit({ key: 'anon:global' })).success) {
      return json({ error: 'terminus is busy, try again in a minute' }, 429, { 'retry-after': '60' });
    }
    const body = await readJson(req);
    const token = await createAnonymous(db, deviceName(body), clientWith(req, body), nowMs);
    return json({ token }, 201);
  }

  if (path === '/auth/anon/web' && req.method === 'POST') {
    // "Use terminus without an email" on the website (an iPhone has no app):
    // the same account as an app's first launch, as a web session. A browser
    // can run Turnstile, so it does, on top of the app's limits.
    if (await limited(env, req, 'anon')) return json({ error: 'too many attempts, try again in a minute' }, 429);
    const body = await readJson(req);
    if (!(await verifyTurnstile(env, body?.turnstile, req.headers.get('cf-connecting-ip')))) {
      return json({ error: 'the human check failed, try again' }, 400);
    }
    if (env.RL_ANON && !(await env.RL_ANON.limit({ key: 'anon:global' })).success) {
      return json({ error: 'terminus is busy, try again in a minute' }, 429, { 'retry-after': '60' });
    }
    const token = await createAnonymousWeb(db, nowMs);
    return json({ ok: true }, 201, { 'set-cookie': sessionCookie(token, ACCOUNT_TTL.webSessionMs / 1000), 'cache-control': 'no-store' });
  }

  if (path === '/auth/app/start' && req.method === 'POST') {
    if (await limited(env, req, 'appstart')) return json({ error: 'too many attempts, try again in a minute' }, 429);
    const body = await readJson(req);
    const email = normalizeEmail(body?.email);
    if (!email) return json({ error: 'enter a valid email address' }, 400);
    // The app's anonymous account, if it sends its token: it's either kept
    // (with the email added) or folded into the account the email has.
    const current = tokenFrom(req) ? await authenticate(db, req, nowMs) : null;
    if (current?.user.email) return json({ error: 'this device is already signed in' }, 409);
    if (env.RL_MAIL && !(await env.RL_MAIL.limit({ key: 'mail:global' })).success) {
      return json({ error: 'sign-in is busy, try again in a minute' }, 429, { 'retry-after': '60' });
    }
    let started;
    try {
      started = await startAppLogin(env, db, { email, name: deviceName(body), client: clientWith(req, body), anonUserId: current?.user.id ?? null }, linkOrigin(url, env), nowMs);
    } catch (err) {
      console.error('sign-in email failed', err instanceof Error ? err.name : typeof err);
      return json({ error: 'could not send the email, try again later' }, 502);
    }
    if (started === 'cooldown') return json({ error: 'an email was sent to that address a moment ago; wait a minute and try again' }, 429, { 'retry-after': '60' });
    return json({ ...started, expires: new Date(started.expires).toISOString() }, 201);
  }

  if ((path === '/auth/app/poll' || path === '/auth/app/code') && req.method === 'POST') {
    // Every 3 seconds while the app is waiting: a per-IP ceiling of its own.
    // A typed code is a guess, so it counts against the sign-in limit too.
    if (env.RL_PUBLIC && !(await env.RL_PUBLIC.limit({ key: `poll:${clientKey(req)}` })).success) {
      return json({ error: 'too many requests, slow down' }, 429, { 'retry-after': '10' });
    }
    if (path === '/auth/app/code' && (await limited(env, req, 'appcode'))) return json({ error: 'too many attempts, try again in a minute' }, 429);
    const body = await readJson(req);
    if (typeof body?.request !== 'string' || typeof body?.poll !== 'string') return json({ error: 'send request and poll' }, 400);
    if (path === '/auth/app/code') {
      const code = normalizePairCode(body.code);
      const entered = code ? await enterCode(db, body.request, body.poll, code, nowMs) : 'wrong';
      if (entered === 'wrong') return json({ status: 'pending', error: "that code isn't right; check the email and try again" }, 400);
      if (entered !== 'approved') return json({ status: entered, error: entered === 'denied' ? 'too many wrong codes; start again' : 'that request expired; start again' }, 400);
    }
    const r = await pollAppLogin(db, body.request, body.poll, clientWith(req, body), nowMs);
    if (r.status !== 'approved') return json({ status: r.status });
    if (r.removed) await clearTrip(env, r.removed);
    // A device added to an account that already had an email: tell its owner.
    if (r.outcome !== 'created' && r.outcome !== 'added-email') {
      ctx.waitUntil(mailDeviceChange(env, r.email, 'added', r.device, nowMs).catch(mailFailed));
    }
    return json({ status: 'approved', token: r.token, email: r.email, outcome: r.outcome });
  }

  if (path === '/auth/approve') {
    if (req.method === 'GET') {
      if (env.RL_PUBLIC && !(await env.RL_PUBLIC.limit({ key: `pub:${clientKey(req)}` })).success) return json({ error: 'too many requests, slow down' }, 429);
      // Like /auth/verify: GET only shows the page (mail scanners open every
      // link); the POST decides.
      const link = (url.searchParams.get('r') ?? '').replace(/[^A-Za-z0-9_-]/g, '');
      const a = link ? await approvable(db, link, nowMs) : null;
      if (!a) return html(page(m().pageRequestExpired, m().approveExpiredHtml), 400);
      const device = escapeHtml(a.device);
      const buttons = a.choices
        .map((n) => `<button type="submit" name="n" value="${n}" class="btn">${n}</button>`)
        .join('');
      return html(page(m().pageApprove, `<h1>${m().approveTitle(device)}</h1>
<p class="hint">${m().approveHint(escapeHtml(sgtTime(a.created)), device)}</p>
<form method="post" action="/auth/approve"><input type="hidden" name="r" value="${link}"><div class="choices">${buttons}</div></form>
<form method="post" action="/auth/approve"><input type="hidden" name="r" value="${link}"><button type="submit" name="n" value="none" class="linkbtn">${m().notMe}</button></form>`));
    }
    if (req.method === 'POST') {
      if (await limited(env, req, 'approve')) return json({ error: 'too many attempts, try again in a minute' }, 429);
      const form = await readForm(req);
      const r = form?.get('r');
      const n = Number(form?.get('n'));
      const out = typeof r === 'string' ? await decide(db, r, Number.isInteger(n) ? n : null, nowMs) : 'expired';
      if (out === 'approved') return html(page(m().pageApproved, m().approvedHtml));
      if (out === 'denied') {
        const picked = form?.get('n') !== 'none';
        return html(
          page(m().pageCancelled, m().cancelledHtml(picked)),
          picked ? 400 : 200,
        );
      }
      return html(page(m().pageRequestExpired, m().approveExpiredHtml), 400);
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
    // It goes into the email to the account's owner: cleaned as at /auth/app/start.
    const name = deviceName(body);
    if (!code) return json({ error: 'enter the 6-character code from the account page' }, 400);
    const paired = await redeemPairCode(db, code, name, nowMs, clientFrom(req));
    if (!paired) return json({ error: 'that code is wrong or has expired' }, 400);
    ctx.waitUntil(mailDeviceChange(env, paired.email, 'added', name, nowMs).catch(mailFailed));
    return json({ token: paired.token });
  }

  /* ---------- everything below needs a session ---------- */

  const session = await authenticate(db, req, nowMs, ctx);

  if (path === '/auth/logout' && req.method === 'POST') {
    if (session) await endSession(db, session.tokenHash);
    return json({ ok: true }, 200, { 'set-cookie': sessionCookie('', 0) });
  }

  if (path === '/auth/app/merge' && req.method === 'POST' && session) {
    // After a sign-in where both the device and the account had a setup.
    const body = await readJson(req);
    const keep = body?.keep === 'device' ? 'device' : body?.keep === 'account' ? 'account' : null;
    if (!keep || typeof body?.anon !== 'string') return json({ error: "send anon (the device's old token) and keep: 'account' or 'device'" }, 400);
    const r = await mergeAnonymous(db, session.user.id, body.anon, keep, nowMs);
    if (r === 'not-anonymous') return json({ error: 'that token is not an anonymous account' }, 400);
    await clearTrip(env, r.removed);
    return json({ ok: true, profile: await getProfile(db, session.user.id, deps.graph) });
  }

  if (!session) {
    // Each bad token costs a D1 read, so guessing is capped per address.
    // No token at all is just "signed out" (the homepage asks), not a guess.
    if (tokenFrom(req) && (await limited(env, req, 'badtoken'))) return json({ error: 'too many attempts, try again in a minute' }, 429);
    return json({ error: 'sign in first' }, 401);
  }

  // Per account: generous for a widget, an app and a browser tab together.
  if (env.RL_ME) {
    const { success } = await env.RL_ME.limit({ key: `me:${session.user.id}` });
    if (!success) return json({ error: 'too many requests, slow down' }, 429);
  }
  for (const r of ME_ROUTES) {
    if (r.method !== req.method) continue;
    const prefix = r.path.endsWith('/');
    if (prefix ? !path.startsWith(r.path) : path !== r.path) continue;
    if (r.access === 'web' && session.kind !== 'web') return json({ error: 'do this from the account page' }, 403);
    if (r.access === 'email' && !session.user.email) return json({ error: 'add an email to this account first' }, 403);
    return r.run({ req, url, env, ctx, nowMs, deps, db, session, rest: prefix ? path.slice(r.path.length) : '' });
  }

  return json({ error: 'not found' }, 404);
}

/** Today's trip signals, looked up only when there's a trip to track today. */
async function tripDay(env: Env, userId: string, profile: Profile, nowMs: number): Promise<DayRecord | null> {
  if (!env.TRIPS || !classesOn(profile, nowMs).length) return null;
  return loadDay(env, userId, nowMs);
}

/** /me/next's body: the answer, when it changes by itself, and the card. */
async function nextBody(...args: Parameters<typeof nextWithTrip>) {
  return (await nextWithTrip(...args)).body;
}

async function nextWithTrip(
  url: URL,
  env: Env,
  ctx: ExecutionContext,
  nowMs: number,
  deps: MeDeps,
  profile: Profile,
  day: DayRecord | null,
  userId: string,
  prefs: TripPrefs = NO_PREFS,
  /** Inside the Trip object itself: write plans there, and don't ask it to watch. */
  local?: { savePlan: (key: string, plan: Boarded) => Promise<void> },
) {
  const { answer, trip } = await planned(url, env, ctx, nowMs, deps, profile, day, prefs);
  const keepPlan = local ? local.savePlan : (key: string, plan: Boarded) => savePlan(env, userId, key, plan, nowMs);
  // At home (this request's location): the trip home is over, for every device.
  // At the destination, or home (this request's location): that trip is over, for every device.
  if (trip.reached && !local) {
    const label = isHomeKey(trip.reached) ? 'Home' : (answer.dest?.label ?? undefined);
    const onBus = day?.trips[trip.reached]?.kind === 'boarded' ? day.trips[trip.reached].boarded : undefined;
    ctx.waitUntil(saveSignal(env, userId, trip.reached, { kind: 'arrived', at: nowMs, label, detected: true, ...(onBus ? { boarded: onBus } : {}) }, nowMs).then(() => undefined).catch(outcomeFailed));
  }
  // Remember which bus the trip is for, so every device says it and detection
  // watches it: from when it's due, or before then when it was planned from
  // where the phone is (the widget and the Mac would otherwise each plan
  // from where the timetable puts you). Written only when the plan changes.
  if (trip.planChanged && trip.key && trip.plan && (trip.phase !== 'idle' || trip.plan.located)) ctx.waitUntil(keepPlan(trip.key, trip.plan));
  // When the plan itself moves on (class starts, day ends). Only the planned
  // answer has one; a place or a stop never changes by itself.
  const isPlan = !url.searchParams.get('place') && !url.searchParams.get('to');
  const full: MeAnswer = isPlan ? { ...answer, refreshAt: isoSeconds(planChangesAt(profile, nowMs)) } : answer;
  // The display-ready card, in the client's 12- or 24-hour style.
  const card = cardFor(full, hour12(url), trip);
  // Push: have the Trip object wake when this card next changes, to tell the phones.
  const at = nextPhaseAt(full, trip, nowMs);
  if (!local && at !== null && pushEnabled(env) && day?.watch !== at && classesOn(profile, nowMs).length) {
    ctx.waitUntil(watchTrip(env, userId, at, nowMs));
  }
  // The user's walking speed, for walk times the apps show themselves (search).
  return { body: { ...full, walkSpeedMs: paceSpeed(profile.walkPace), card }, trip };
}

/**
 * The card as a request would get it, for the Trip object when it wakes:
 * which trip, its phase, whether there's a question, when it next changes.
 */
export async function tripCardFor(
  env: Env,
  ctx: ExecutionContext,
  deps: MeDeps,
  userId: string,
  day: DayRecord | null,
  nowMs: number,
  savePlanLocal: (key: string, plan: Boarded) => Promise<void>,
): Promise<{ key: string | null; phase: string; ask: boolean; remind: boolean; wakeAt: number | null } | null> {
  if (!env.DB) return null;
  const profile = await getProfile(env.DB, userId, deps.graph);
  if (!classesOn(profile, nowMs).length) return null;
  const prefs = await prefsFor(env.DB, userId, profile, nowMs);
  const url = new URL('https://terminus.internal/me/next');
  const { body, trip } = await nextWithTrip(url, env, ctx, nowMs, deps, profile, day, userId, prefs, { savePlan: savePlanLocal });
  return { key: trip.key, phase: body.card.phase, ask: body.card.ask !== null, remind: body.card.remind !== false, wakeAt: nextPhaseAt(body, trip, nowMs) };
}

const CHOICES = ['accept', 'dismiss', 'undo'] as const;

/** The outcome a signal records; the others (a location, "waiting") say nothing about it. */
const OUTCOME_OF: Partial<Record<TripRecord['kind'], 'boarded' | 'missed' | 'skipped' | 'arrived'>> = {
  boarded: 'boarded',
  left: 'boarded',
  missed: 'missed',
  skipped: 'skipped',
  arrived: 'arrived',
};

const outcomeFailed = (e: unknown) => console.error('trip outcome not saved', e instanceof Error ? e.message : typeof e);

/** The user's trip choices and what terminus has learned, or none if D1 can't say. */
async function prefsFor(db: D1Database, userId: string, profile: Profile, nowMs: number): Promise<TripPrefs> {
  const all = [...profile.trips, ...profile.manual];
  if (!all.length) return NO_PREFS;
  try {
    return await tripPrefs(db, userId, nowMs, (key) => all.find((t) => classKey(t) === key)?.label ?? null);
  } catch (err) {
    outcomeFailed(err);
    return NO_PREFS;
  }
}

/** Counts only: which signals people send, never who or where. */
function logSignal(env: Env, kind: string): void {
  try {
    env.AE?.writeDataPoint({ blobs: ['signal', kind], doubles: [1], indexes: ['signal'] });
  } catch {
    // Analytics must never break an answer.
  }
}

/**
 * Whether the account page should walk someone through setup first: an
 * account that has never saved anything and hasn't been through it.
 */
export function onboardingFor(hasProfile: boolean, seen: string[]): 'full' | null {
  return !hasProfile && !seen.includes('onboarding') ? 'full' : null;
}

async function nearbyFor(url: URL, env: Env, ctx: ExecutionContext, nowMs: number, deps: MeDeps, profile: Profile) {
  let { lat, lon } = coordsFrom(url);
  // Without a location, start from the first home stop.
  const homeStop = profile.home ? indexGraph(deps.graph).byCode.get(profile.home.stops[0]) : undefined;
  if (lat === null && homeStop) ({ lat, lon } = homeStop);
  if (lat === null || lon === null) return json({ error: 'send lat and lon, or set a home' }, 400);

  const idx = indexGraph(deps.graph);
  const ranked = deps.graph.stops
    .map((stop) => ({ stop, distM: haversineM(lat!, lon!, stop.lat, stop.lon), footM: footM(lat!, lon!, stop) }))
    .sort((a, b) => a.distM - b.distM);
  const near = ranked.filter((c) => c.distM <= WALK.maxRadiusM).slice(0, WALK.maxCandidates);
  // In a residence: its own stops, walked by the paths, like /me/next.
  const picked = residenceStops(lat, lon, idx.byCode)?.slice(0, WALK.maxCandidates) ?? (near.length ? near : ranked.slice(0, 1));
  // The nearest stop's twin (across the road, or PGP and PGP Foyer), always:
  // a location a few metres out puts you at the wrong one, and the widget
  // offers the other.
  const twinCode = picked[0] ? nearbyTwin(picked[0].stop) : null;
  const twin = twinCode ? ranked.find((c) => c.stop.code === twinCode) : undefined;
  if (twin && !picked.some((c) => c.stop.code === twin.stop.code)) picked.push(twin);

  const byStop = await deps.collectArrivals(env, ctx, picked.map((c) => c.stop.code), nowMs);
  const stops = picked.map(({ stop, distM, footM: foot }) => {
    const sa = byStop.get(stop.code)!;
    return {
      stop: { code: stop.code, name: stop.name },
      opposite: nearbyTwin(stop),
      distM: Math.round(distM),
      walkS: Math.round(foot / paceSpeed(profile.walkPace)),
      available: sa.available !== false,
      // Each service in its colour, as on the buses and the map.
      board: boardAt(deps.graph, idx, stop.code, sa, nowMs).map((r) => ({ ...r, color: ROUTE_COLORS[r.svc] ?? null })),
    };
  });
  return json({ stops, asOf: new Date(nowMs).toISOString() });
}
