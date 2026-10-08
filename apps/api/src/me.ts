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
  mailDeviceAdded,
  deleteAccount,
  forgetSignInCode,
  endAllSessions,
  exportAccount,
  checkTurnstile,
  endSession,
  listDevices,
  loadProfileJson,
  loadProfileRow,
  normalizeEmail,
  normalizePairCode,
  tokenFrom,
  hasSessionCookie,
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
  saveProfileIf,
  sessionCookie,
  PLATFORMS,
} from './accounts.ts';
import { CLOCK_PREFS, DEFAULT_PROFILE, PROFILE_LIMITS, type Profile, profileLimits, classKey, classesOn, parseProfile, planChangesAt, reimportReason } from './profile.ts';
import { type Planned, hour12, planned, resolveTo } from './next.ts';
import { dayPlan } from './day.ts';
import { unlogged } from './answer.ts';
import { type Boarded, type DayRecord, PLATE_WINDOW_S, SIGNALS, type TripRecord, type TripUpdate, clearTrip, isHomeKey, loadDay, needsWatch, saveSignals, sgtDate, updateTrip } from './trip.ts';
import { nudgeUser, pushEnabled, setPushToken } from './push.ts';
import { WEB_PREFIX, parseSubscription, vapidPublicKey, webPushEnabled } from './webpush.ts';
import { NO_PREFS, type PrefKind, type TripPrefs, clearHistory, clearOutcome, historySize, listPrefs, recordOutcome, setPref, tripPrefs } from './outcomes.ts';
import { ImportInputError, parseShareUrl, resolveTrips } from './nusmods.ts';
import { termName } from './calendar.ts';
import { boardAsOf, boardAt, displayName, indexGraph, rideStops } from './resolve.ts';
import { CORRIDOR_M, type Fix, atStopOf, departedAt, detect, fixOf, mayDetect, onRoute } from './detect.ts';
import { mayRecordRide, recordRide } from './ridetimes.ts';
import { haversineM } from './geo.ts';
import { isoSeconds } from './format.ts';
import { cardFor, nextPhaseAt } from './card.ts';
import { feedDownSince, termNoticeFor } from './monitor.ts';
import { RIDE, WALK, sgt } from './config.ts';
import { landmark } from './landmarks.ts';
import { GRAPH_PUBLIC, nearbyTwin, twinOf } from './graph.ts';
import { residenceStops } from './residences.ts';
import { MAX_KEYS, createKey, listKeys, revokeKey } from './access.ts';
import { footM, paceSpeed } from './walk.ts';
import { clientKey, coordsFrom, json } from './http.ts';
import { siteOrigin } from './site.ts';
import { LANG_PREFS, lang, m, useProfileLang } from './i18n.ts';
import { bandCss, bandHtml, phaseAt, sgtMinute } from './pagesky.ts';

export interface MeDeps {
  graph: Graph;
  /** The graph with the public buses in it, for accounts that turned them on. Absent: `graph`. */
  publicGraph?: Graph;
  answerFor: (env: Env, ctx: ExecutionContext, input: ResolveInput, label: string | null, nowMs: number) => Promise<Answer>;
  collectArrivals: (env: Env, ctx: ExecutionContext, codes: string[], nowMs: number, graph?: Graph) => Promise<Map<string, StopArrivals>>;
}

const html = (body: string, status = 200, extra: Record<string, string> = {}) =>
  new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...extra } });

/**
 * Minimal pages served by the Worker itself, in the site's style: a card
 * with a band of the hour's sky across its top, the mark in it, as
 * Settings' pages have in the apps (pagesky.ts).
 */
const page = (title: string, inner: string) => {
  const phase = phaseAt(sgtMinute(Date.now()));
  return `<!doctype html>
<html lang="${lang() === 'zh' ? 'zh-Hans' : 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${title} · terminus</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="preload" href="/assets/fonts/inter-latin.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/assets/fonts/space-grotesk-latin.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/assets/fonts.css">
<link rel="stylesheet" href="/assets/site.css">
<style>.box{max-width:25rem;margin:10vh auto 0;padding:32px 28px;overflow:hidden}.band .brand img{width:28px;height:28px}.box h1{font-size:1.6rem;margin-bottom:8px}.box .btn{width:100%;margin-top:20px}
.when{color:var(--muted)}.box .eyebrow{display:block;margin:24px 4px 8px;line-height:1.4}.box .hint.after{margin:8px 4px 0;font-size:.85rem}.box .hint.center{margin-top:4px;text-align:center;font-size:.85rem}
.choices{display:flex;gap:8px;padding:10px;border:1px solid var(--line);border-radius:16px;background:var(--bg)}
.box .choices .btn{flex:1;margin:0;min-height:60px;padding:0;border-radius:12px;background:var(--surface-2);color:var(--ink);border-color:var(--line);font:700 1.6rem/1 var(--display);font-variant-numeric:tabular-nums}
.box .choices .btn:hover,.box .choices .btn:focus-visible{transform:none;border-color:var(--ink);box-shadow:inset 0 0 0 1px var(--ink)}
.linkbtn{display:block;margin:22px auto 0;background:none;border:0;color:var(--ink);text-decoration:underline;text-underline-offset:3px;text-decoration-color:var(--muted);font:500 .95rem var(--font);cursor:pointer}
${bandCss(phase)}</style>
</head><body><main class="wrap"><div class="card box">${bandHtml(phase)}${inner}</div></main></body></html>`;
};

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
 * A trip key a client sent: one of the profile's classes, today's usual
 * times and one-off trips, or a trip home. The key becomes stored rows
 * (signals, outcomes, choices), so anything else would let a script make as
 * many as it likes.
 */
function knownTrip(profile: Profile, key: string, nowMs: number): boolean {
  if (/^home:(\d{1,4}|evening)$/.test(key) || /^gap-home:[A-Za-z0-9_-]{1,24}$/.test(key)) return true;
  return [...profile.trips, ...profile.manual, ...classesOn(profile, nowMs)].some((t) => classKey(t) === key);
}

/**
 * "Pixel 8": what the app calls itself, shown in emails and the device list.
 * '' when it gives no name: the emails then say "a device", and the device
 * list shows each app's own word for one.
 */
function deviceName(body: Record<string, unknown> | null): string {
  if (typeof body?.name !== 'string') return '';
  // It goes into sign-in emails: a device's name, not a message. Letters,
  // digits and a little punctuation; no links, no line breaks.
  const name = body.name
    .replace(/[^\p{L}\p{N} ()'_-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);
  return name;
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
  // The exact type, not one that merely mentions it: `text/plain;
  // x=application/json` is a type a page on another site can send without
  // asking first, cookie and all.
  const type = (req.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') return null;
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

/** The header every 429 carries, saying when to try again: [seconds], by
 *  default the window of the per-minute limiters (RL_*) and the sign-in
 *  cooldowns. Clients wait this long rather than guessing. */
const retryAfter = (seconds = 60): Record<string, string> => ({ 'retry-after': String(seconds) });

async function limited(env: Env, req: Request, scope: string): Promise<boolean> {
  if (!env.RL_AUTH) return false;
  const { success } = await env.RL_AUTH.limit({ key: `${scope}:${clientKey(req)}` });
  return !success;
}

/** The global ceiling on pairing-code lookups (both /pair and /pair/check). */
async function pairBusy(env: Env): Promise<boolean> {
  if (!env.RL_PAIR) return false;
  return !(await env.RL_PAIR.limit({ key: 'pair:global' })).success;
}

/** The account's profile, checked against today's stops. `raw`: the saved JSON, when the caller has already read it. */
export async function getProfile(db: D1Database, userId: string, graph: Graph, raw?: unknown): Promise<Profile> {
  if (raw === undefined) raw = await loadProfileJson(db, userId);
  if (!raw) return structuredClone(DEFAULT_PROFILE);
  const idx = indexGraph(graph);
  // A stop can vanish from a new scrape. Re-validating on read would reject
  // the whole profile, so drop only what no longer resolves.
  const r = parseProfile(raw, (c) => idx.byCode.has(c), (c) => idx.byCode.has(c) || landmark(c) !== null, pinnable(graph));
  // The language the account chose wins over the device's, for the rest of this request.
  if (r.ok) {
    useProfileLang(r.profile.lang);
    return r.profile;
  }
  const p = raw as Profile;
  useProfileLang(LANG_PREFS.includes(p.lang) ? p.lang : 'auto');
  return salvageProfile(p, (c) => idx.byCode.has(c) || landmark(c) !== null, pinnable(graph));
}

/** Tries before a read-modify-write of the profile gives up to another device's writes. */
const PROFILE_TRIES = 3;
const PROFILE_CHANGED = 'your settings were changed on another device; try again';

/**
 * A change to the saved profile that can't lose another device's write made
 * meanwhile: it saves only if nothing was saved since it read, and otherwise
 * reads again and redoes the change. `change` returns the new profile, or a
 * Response to answer with instead (a refusal).
 */
async function changeProfile(
  db: D1Database,
  userId: string,
  graph: Graph,
  nowMs: number,
  change: (p: Profile) => Profile | Response,
): Promise<{ profile: Profile; version: number } | Response> {
  for (let i = 0; i < PROFILE_TRIES; i++) {
    const row = await loadProfileRow(db, userId);
    const next = change(await getProfile(db, userId, graph, row?.json ?? null));
    if (next instanceof Response) return next;
    const version = await saveProfileIf(db, userId, next, nowMs, row?.updated ?? null);
    if (version !== null) return { profile: next, version };
  }
  return json({ error: PROFILE_CHANGED }, 409);
}

/** The version in an If-Match header (`"123"`, or weakened by compression,
 *  `W/"123"`; `"0"` for a profile never saved); undefined when there is none
 *  to go by, and the write is unconditional as before. */
export function ifMatchVersion(req: Request): number | null | undefined {
  const m = /^\s*(?:W\/)?"(\d{1,16})"\s*$/.exec(req.headers.get('if-match') ?? '');
  if (!m) return undefined;
  const v = Number(m[1]);
  return v === 0 ? null : v;
}

const versionTag = (v: number | null | undefined) => `"${v ?? 0}"`;

/** A stop a pin may name: one of `graph`'s, or a public bus's stop of its own. */
function pinnable(graph: Graph): (code: string) => boolean {
  const idx = indexGraph(graph);
  const pub = indexGraph(GRAPH_PUBLIC);
  return (c) => idx.byCode.has(c) || pub.byCode.has(c);
}

/**
 * A saved profile that no longer validates whole (a stop gone from a new
 * scrape): everything that still holds, so the next save doesn't write the
 * user's hours, usual times or one-off trips back as the defaults.
 */
export function salvageProfile(p: Profile, ok: (code: string) => boolean, pinnable: (code: string) => boolean = ok): Profile {
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
    publicBuses: p.publicBuses === true,
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
    clock: CLOCK_PREFS.includes(p.clock) ? p.clock : 'auto',
    pinnedStops: (Array.isArray(p.pinnedStops) ? p.pinnedStops : []).filter((c) => typeof c === 'string' && pinnable(c)).slice(0, PROFILE_LIMITS.pinnedStops),
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
   * account needs an email (devices: one without has only the device asking,
   * and a pairing code emails its owner when it's used).
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

/**
 * What a location means for the trip in progress, as a record to save, or
 * undefined when it says nothing new (detect.ts decides; this builds the
 * record). A ride seen from start to end is measured on the way.
 */
async function recordFromFix(x: {
  env: Env;
  ctx: ExecutionContext;
  deps: MeDeps;
  userId: string;
  now: Planned;
  prev: TripRecord | undefined;
  label: string | undefined;
  fix: Fix;
  homeStops: string[];
  nowMs: number;
}): Promise<TripRecord | undefined> {
  const { env, ctx, deps, now, prev, label, fix, nowMs } = x;
  // The bus it's about: the plan; after a miss at the stop, whichever
  // bus from that stop to the same place this fix is on the road of.
  const bus: Boarded | null = prev?.kind === 'missed' && prev.atStop ? nextBusFrom(deps.graph, now.trip.plan ?? null, fix, nowMs) : (now.trip.plan ?? null);
  // A public bus's route is only in the public graph.
  const graph = bus?.paid ? (deps.publicGraph ?? deps.graph) : deps.graph;
  const seen = detect({ phase: now.trip.phase, rec: prev, bus, arrivedHere: Boolean(now.answer.arrived), fix, homeStops: x.homeStops, graph, nowMs });
  if (seen === 'arrived') {
    const onBus = prev?.kind === 'boarded' ? prev.boarded : now.trip.phase === 'riding' ? (now.trip.plan ?? undefined) : undefined;
    // A ride seen from start to end: how long it really took (phase 8.2).
    if (onBus?.departed && env.DB) {
      const rides = env.DB;
      ctx.waitUntil(mayRecordRide(env, rides, x.userId, onBus.svc, nowMs).then((ok) => (ok ? recordRide(rides, deps.graph, onBus, nowMs) : null)).catch(() => null));
    }
    return { kind: 'arrived', at: nowMs, label, detected: true, ...(onBus ? { boarded: onBus } : {}) };
  }
  if (seen === 'boarded' && bus) {
    return {
      kind: 'boarded',
      at: nowMs,
      label,
      detected: true,
      boarded: { ...bus, departed: new Date(departedAt(deps.graph, bus, fix, nowMs)).toISOString(), ...(await plateOnBoard(env, ctx, deps, bus, nowMs)) },
    };
  }
  if (seen === 'missed' && (bus || prev?.boarded)) {
    // The bus it's about: the plan, or the one you were taken to be on.
    const about = prev?.kind === 'boarded' && prev.boarded ? prev.boarded : bus!;
    return { kind: 'missed', at: nowMs, label, detected: true, missed: about.board, ...(atStopOf(deps.graph, about, fix) ? { atStop: true } : {}) };
  }
  if (prev?.kind === 'missed' && prev.detected && !prev.atStop && atStopOf(deps.graph, now.trip.plan ?? null, fix)) {
    // Missed it at home, and now at the stop: the next bus can be noticed too.
    return { ...prev, atStop: true };
  }
  if (now.trip.phase === 'waiting' && mayDetect(prev) && prev?.kind !== 'boarded' && !(prev?.kind === 'waiting' && nowMs - prev.at < WAITING_REFRESH_MS)) {
    // At the stop: what makes a fast fix later count as the bus.
    // Written again only now and then: the phone sends a fix every 20 s.
    return { kind: 'waiting', at: nowMs, label };
  }
  return undefined;
}

/** Everything that needs a session, by method and path. */
export const ME_ROUTES: MeRoute[] = [
  {
    method: 'DELETE',
    path: '/me',
    // From the account page; an anonymous account has no page, so its app can.
    run: async ({ env, db, session }) => {
      if (session.kind !== 'web' && session.user.email !== null) return json({ error: 'delete the account from the account page' }, 403);
      await deleteAccount(db, session.user);
      await clearTrip(env, session.user.id);
      if (session.user.email) await forgetSignInCode(env, session.user.email);
      return json({ ok: true }, 200, { 'set-cookie': sessionCookie('', 0) });
    },
  },
  {
    method: 'GET',
    path: '/me/export',
    run: async ({ env, db, session, nowMs }) => {
      return json(await exportAccount(db, session.user, await loadDay(env, session.user.id, nowMs)), 200, {
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
      const ended = await endAllSessions(db, session.user);
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
      // The limits ride along, so clients needn't hard-code them; a client
      // that sends the whole profile back sends them too, and they're ignored.
      // The version goes in the ETag, not the body, for the same reason: a
      // client that sends it back as If-Match has asked for the check.
      const row = await loadProfileRow(db, session.user.id);
      const profile = await getProfile(db, session.user.id, deps.graph, row?.json ?? null);
      return json({ ...profile, limits: profileLimits() }, 200, { etag: versionTag(row?.updated) });
    },
  },
  {
    method: 'PUT',
    path: '/me/profile',
    run: async ({ req, nowMs, deps, db, session }) => {
      const body = await readJson(req);
      if (!body) return json({ error: 'send the profile as JSON' }, 400);
      const idx = indexGraph(deps.graph);
      const r = parseProfile(body, (c) => idx.byCode.has(c), (c) => idx.byCode.has(c) || landmark(c) !== null, pinnable(deps.graph));
      if (!r.ok) return json({ error: r.error }, 400);
      // One-off trips are done with once their day has passed.
      r.profile.once = r.profile.once.filter((o) => o.date >= sgtDate(nowMs));
      // With If-Match (the ETag of the profile it started from), the save
      // happens only if no other device saved since; without, as before.
      const from = ifMatchVersion(req);
      const version = from === undefined ? await saveProfileJson(db, session.user.id, r.profile, nowMs) : await saveProfileIf(db, session.user.id, r.profile, nowMs, from);
      if (version === null) return json({ error: PROFILE_CHANGED }, 412);
      return json({ ...r.profile, limits: profileLimits() }, 200, { etag: versionTag(version) });
    },
  },
  {
    method: 'POST',
    path: '/me/once',
    run: async ({ req, url, env, ctx, nowMs, deps, db, session }) => {
      // A one-off trip (phase 8.3): "Science library at 14:00 today". Planned
      // like a class on its day; "Not going" drops it. Answers with /me/next.
      const body = await readJson(req);
      // Read, changed and saved again if another device saved meanwhile, so
      // neither write is lost.
      const changed = await changeProfile(db, session.user.id, deps.graph, nowMs, (profile) => {
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
        return { ...profile, once };
      });
      if (changed instanceof Response) return changed;
      const next = changed.profile;
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
        return json({ error: 'too many attempts, try again in a minute' }, 429, retryAfter());
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
      // The timetable replaces the old one; the rest of the profile is read
      // again if another device saved it meanwhile, so that write isn't lost.
      const changed = await changeProfile(db, session.user.id, deps.graph, nowMs, (profile) => ({
        ...profile,
        trips: r.trips.slice(0, PROFILE_LIMITS.trips),
        share,
        term: r.term,
      }));
      if (changed instanceof Response) return changed;
      const { profile } = changed;
      return json({ profile: { ...profile, limits: profileLimits() }, unresolved: r.unresolved, missing: r.missing, online: r.online, term }, 200, { etag: versionTag(changed.version) });
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
    run: async ({ db, session, rest }) => {
      const name = await revokeDevice(db, session.user.id, rest);
      if (name === null) return json({ error: 'no such device' }, 404);
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
      const here = coordsFrom(url);
      const plan = () => dayPlan(env, ctx, nowMs, deps, profile, day, hour12(url, profile), prefs.earlier, here);
      return json(await dayCached(ctx, nowMs, [session.user.id, profile, day, hour12(url, profile), [...prefs.earlier], here, lang()], plan));
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
        const items: { key: string; rec: TripRecord | null }[] =
          kind === 'away'
            ? classesOn(profile, nowMs)
                .filter((c) => (day?.trips[classKey(c)]?.kind ?? 'waiting') === 'waiting')
                .map((c) => ({ key: classKey(c), rec: { kind: 'skipped', at: nowMs, label: c.label, away: true } }))
            : Object.entries(day?.trips ?? {}).filter(([, r]) => r.away).map(([key]) => ({ key, rec: null }));
        // One call to the Trip object, however many classes.
        const after = items.length ? await saveSignals(env, session.user.id, items, nowMs) : day;
        logSignal(env, kind);
        const prefs = await prefsFor(db, session.user.id, profile, nowMs);
        const out = await nextBody(url, env, ctx, nowMs, deps, profile, after, session.user.id, prefs);
        ctx.waitUntil(nudgeUser(env, session.user.id, { phase: out.card.phase, urgent: false, remind: out.card.remind !== false }, nowMs, session.tokenHash));
        return json(out);
      }
      const now = await planned(here, env, ctx, nowMs, deps, profile, day);
      const key = typeof body?.trip === 'string' && body.trip ? body.trip.slice(0, 80) : now.trip.key;
      if (!key) return json({ error: 'no trip in progress to say that about' }, 409);
      if (key !== now.trip.key && !knownTrip(profile, key, nowMs)) return json({ error: 'no such trip today' }, 400);
      const current = key === now.trip.key;
      // Being followed: the card stops asking what happened (see DayRecord.followed).
      let followed: number | undefined;
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
          // Noted once a minute at most, with the signal when there is one.
          if (fix && current && !(day?.followed && nowMs - day.followed < 60_000)) followed = nowMs;
          rec = current && fix ? await recordFromFix({ env, ctx, deps, userId: session.user.id, now, prev: day?.trips[key], label, fix, homeStops: profile.home?.stops ?? [], nowMs }) : undefined;
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
      // One request to the Trip object for the signal and being followed.
      // Only the signal must be kept: being followed alone is let go on a failure.
      const next =
        rec !== undefined
          ? await updateTrip(env, session.user.id, { items: [{ key, rec }], followed }, nowMs)
          : followed !== undefined
            ? ((await updateTrip(env, session.user.id, { followed }, nowMs).catch(() => null)) ?? day)
            : day;
      logSignal(env, rec?.detected ? `detected:${rec.kind}` : kind);
      // What happened to the trip, for what terminus learns (outcomes.ts).
      const outcome = rec ? OUTCOME_OF[rec.kind] : undefined;
      if (rec === null) await clearOutcome(db, session.user.id, key, nowMs);
      // A trip home isn't a class: nothing to learn from skipping it.
      else if (outcome && !/^(gap-)?home:/.test(key)) await recordOutcome(db, session.user.id, key, outcome, nowMs);
      const prefs = await prefsFor(db, session.user.id, profile, nowMs);
      const out = await nextBody(url, env, ctx, nowMs, deps, profile, next, session.user.id, prefs);
      // A tap here changes the other phones' cards now, not at their next refresh.
      // Being at the stop isn't worth waking them for.
      if (rec !== undefined && rec?.kind !== 'waiting') {
        ctx.waitUntil(nudgeUser(env, session.user.id, { phase: out.card.phase, urgent: false, remind: out.card.remind !== false }, nowMs, session.tokenHash));
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
      if (!knownTrip(profile, trip, nowMs)) return json({ error: 'no such trip today' }, 400);
      const label = [...profile.trips, ...profile.manual].find((t) => classKey(t) === trip)?.label ?? null;
      await setPref(db, session.user.id, trip, pref as PrefKind, choice, label, nowMs);
      return json({ ok: true, choices: await listPrefs(db, session.user.id) });
    },
  },
  {
    method: 'GET',
    path: '/me/notice',
    // The new semester's reminder, for an app that was pushed only its kind (push.ts).
    run: async ({ db, session, nowMs }) => {
      return json({ notice: termNoticeFor((await loadProfileJson(db, session.user.id)) as Parameters<typeof termNoticeFor>[0], nowMs) });
    },
  },
  {
    method: 'GET',
    path: '/me/choices',
    run: async ({ db, session }) => {
      return json({ choices: await listPrefs(db, session.user.id), history: await historySize(db, session.user.id) });
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
    path: '/me/feedback',
    run: async ({ req, env, ctx, nowMs, db, session }) => {
      // Anonymous accounts are free to make, so reports come only from a known address.
      const email = session.user.email;
      if (!email) return json({ error: 'sign in to send feedback' }, 403);
      const parsed = parseFeedback(await readJson(req));
      if (!parsed.ok) return json({ error: parsed.error }, 400);
      const id = await saveFeedback(db, session.user.id, parsed.value, nowMs);
      // The cap counts the last 24 hours, but every client holds back all
      // its requests until Retry-After is up (at most 5 minutes), so a day
      // here would stall the whole app for a capped report: one minute,
      // and the message says when to try again.
      if (!id) return json({ error: "that's a lot of reports for one day; thanks, try again tomorrow" }, 429, retryAfter());
      ctx.waitUntil(
        mailFeedback(env, id, parsed.value, nowMs).catch((e) =>
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
  // Changes made with the browser's session, or that start one, come from our
  // own pages. Without this, another site could post a sign-in link or code
  // it holds and sign the visitor in to its account, or sign them out. A page
  // on another subdomain of the same site (the beta, say) gets the Lax cookie
  // sent with its POSTs, so this also covers every request carrying it.
  // Apps send no such header; a bearer token isn't sent by a browser on its own.
  const fetchSite = req.headers.get('sec-fetch-site');
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS' && fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') {
    const setsSession = path === '/auth/verify' || path === '/auth/approve' || path === '/auth/logout' || path === '/auth/code' || path === '/auth/anon/web';
    const bearer = req.headers.get('authorization')?.startsWith('Bearer ') || req.headers.has('x-api-key');
    if (setsSession || (!bearer && hasSessionCookie(req))) return json({ error: 'that request came from another site' }, 403);
  }

  /* ---------- sign-in ---------- */

  // Pages and lookups that cost a D1 read but need no session.
  if ((path === '/auth/verify' || path === '/auth/config') && env.RL_PUBLIC) {
    if (!(await env.RL_PUBLIC.limit({ key: `pub:${clientKey(req)}` })).success) return json({ error: 'too many requests, slow down' }, 429, retryAfter());
  }

  if (path === '/auth/config' && req.method === 'GET') {
    // What the sign-in form needs to render. Public by design.
    return json({ turnstileSiteKey: env.TURNSTILE_SECRET ? (env.TURNSTILE_SITE_KEY ?? null) : null });
  }

  if (path === '/auth/login' && req.method === 'POST') {
    if (await limited(env, req, 'login')) return json({ error: 'too many attempts, try again in a minute' }, 429, retryAfter());
    const body = await readJson(req);
    const email = normalizeEmail(body?.email);
    if (!email) return json({ error: 'enter a valid email address' }, 400);
    const human = await checkTurnstile(env, body?.turnstile, req.headers.get('cf-connecting-ip'));
    // Turnstile itself not answering isn't the visitor's fault: say so, and when to try again.
    if (human === 'unavailable') return json({ error: 'the human check is not answering, try again in a minute' }, 503, { 'retry-after': '60' });
    if (human === 'failed') return json({ error: 'the human check failed, try again' }, 400);
    let outcome;
    try {
      outcome = await requestLink(env, db, email, linkOrigin(url, env), nowMs, body?.next === '/app/');
    } catch (err) {
      // The error text can carry the recipient: log its kind only.
      console.error('sign-in email failed', err instanceof Error ? err.name : typeof err);
      return json({ error: 'could not send the email, try again later' }, 502);
    }
    if (outcome === 'busy') return json({ error: 'sign-in is busy, try again in a minute' }, 429, retryAfter());
    // Same answer whether or not the address is blocked or already has an account.
    return json({ ok: true, message: m().checkEmail });
  }

  if (path === '/auth/code' && req.method === 'POST') {
    // The emailed code, typed on the page that asked for it.
    if (await limited(env, req, 'code')) return json({ error: 'too many attempts, try again in a minute' }, 429, retryAfter());
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
<p class="hint">${m().continueAs(escapeHtml(email))}</p>
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
    if (await limited(env, req, 'anon')) return json({ error: 'too many attempts, try again in a minute' }, 429, retryAfter());
    if (env.RL_ANON && !(await env.RL_ANON.limit({ key: 'anon:global' })).success) {
      return json({ error: 'terminus is busy, try again in a minute' }, 429, retryAfter());
    }
    const body = await readJson(req);
    const token = await createAnonymous(db, deviceName(body), clientWith(req, body), nowMs);
    return json({ token }, 201);
  }

  if (path === '/auth/anon/web' && req.method === 'POST') {
    // "Use terminus without an email" on the website (an iPhone has no app):
    // the same account as an app's first launch, as a web session. A browser
    // can run Turnstile, so it does, on top of the app's limits.
    if (await limited(env, req, 'anon')) return json({ error: 'too many attempts, try again in a minute' }, 429, retryAfter());
    const body = await readJson(req);
    const human = await checkTurnstile(env, body?.turnstile, req.headers.get('cf-connecting-ip'));
    // Turnstile itself not answering isn't the visitor's fault: say so, and when to try again.
    if (human === 'unavailable') return json({ error: 'the human check is not answering, try again in a minute' }, 503, { 'retry-after': '60' });
    if (human === 'failed') return json({ error: 'the human check failed, try again' }, 400);
    if (env.RL_ANON && !(await env.RL_ANON.limit({ key: 'anon:global' })).success) {
      return json({ error: 'terminus is busy, try again in a minute' }, 429, retryAfter());
    }
    const token = await createAnonymousWeb(db, nowMs);
    return json({ ok: true }, 201, { 'set-cookie': sessionCookie(token, ACCOUNT_TTL.webSessionMs / 1000), 'cache-control': 'no-store' });
  }

  if (path === '/auth/app/start' && req.method === 'POST') {
    if (await limited(env, req, 'appstart')) return json({ error: 'too many attempts, try again in a minute' }, 429, retryAfter());
    const body = await readJson(req);
    const email = normalizeEmail(body?.email);
    if (!email) return json({ error: 'enter a valid email address' }, 400);
    // The app's anonymous account, if it sends its token: it's either kept
    // (with the email added) or folded into the account the email has.
    const current = tokenFrom(req) ? await authenticate(db, req, nowMs) : null;
    if (current?.user.email) return json({ error: 'this device is already signed in' }, 409);
    let started;
    try {
      started = await startAppLogin(env, db, { email, name: deviceName(body), client: clientWith(req, body), anonUserId: current?.user.id ?? null }, linkOrigin(url, env), nowMs);
    } catch (err) {
      console.error('sign-in email failed', err instanceof Error ? err.name : typeof err);
      return json({ error: 'could not send the email, try again later' }, 502);
    }
    if (started === 'cooldown') return json({ error: 'an email was sent to that address a moment ago; wait a minute and try again' }, 429, retryAfter());
    if (started === 'busy') return json({ error: 'sign-in is busy, try again in a minute' }, 429, retryAfter());
    return json({ ...started, expires: new Date(started.expires).toISOString() }, 201);
  }

  if ((path === '/auth/app/poll' || path === '/auth/app/code') && req.method === 'POST') {
    // Every 3 seconds while the app is waiting: a per-IP ceiling of its own.
    // A typed code is a guess, so it counts against the sign-in limit too.
    if (env.RL_PUBLIC && !(await env.RL_PUBLIC.limit({ key: `poll:${clientKey(req)}` })).success) {
      return json({ error: 'too many requests, slow down' }, 429, retryAfter(10));
    }
    if (path === '/auth/app/code' && (await limited(env, req, 'appcode'))) return json({ error: 'too many attempts, try again in a minute' }, 429, retryAfter());
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
    return json({ status: 'approved', token: r.token, email: r.email, outcome: r.outcome });
  }

  if (path === '/auth/approve') {
    if (req.method === 'GET') {
      if (env.RL_PUBLIC && !(await env.RL_PUBLIC.limit({ key: `pub:${clientKey(req)}` })).success) return json({ error: 'too many requests, slow down' }, 429, retryAfter());
      // Like /auth/verify: GET only shows the page (mail scanners open every
      // link); the POST decides.
      const link = (url.searchParams.get('r') ?? '').replace(/[^A-Za-z0-9_-]/g, '');
      const a = link ? await approvable(db, link, nowMs) : null;
      if (!a) return html(page(m().pageRequestExpired, m().approveExpiredHtml), 400);
      const device = escapeHtml(a.device || m().aDevice);
      const buttons = a.choices
        .map((n) => `<button type="submit" name="n" value="${n}" class="btn">${n}</button>`)
        .join('');
      // The question, when it was asked, then the three numbers under a
      // heading, saying what a choice does; "This wasn't me" quietly under them.
      return html(page(m().pageApprove, `<h1>${m().approveTitle(device)}</h1>
<p class="when">${m().approveWhen(escapeHtml(sgtTime(a.created)))}</p>
<h2 class="eyebrow" id="pick">${m().approveNumber(device)}</h2>
<form method="post" action="/auth/approve"><input type="hidden" name="r" value="${link}"><div class="choices" role="group" aria-labelledby="pick">${buttons}</div></form>
<p class="hint after">${m().approveRule}</p>
<form method="post" action="/auth/approve"><input type="hidden" name="r" value="${link}"><button type="submit" name="n" value="none" class="linkbtn">${m().notMe}</button></form>
<p class="hint center">${m().notMeHint}</p>`));
    }
    if (req.method === 'POST') {
      if (await limited(env, req, 'approve')) return json({ error: 'too many attempts, try again in a minute' }, 429, retryAfter());
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
    if (await limited(env, req, 'pair')) return json({ error: 'too many attempts, try again in a minute' }, 429, retryAfter());
    if (await pairBusy(env)) return json({ error: 'pairing is busy, try again in a minute' }, 429, retryAfter());
    const body = await readJson(req);
    const code = normalizePairCode(body?.code);
    const owner = code ? await pairCodeOwner(db, code, nowMs) : null;
    if (!owner) return json({ error: 'that code is wrong or has expired' }, 400);
    return json({ account: maskEmail(owner) });
  }

  if (path === '/pair' && req.method === 'POST') {
    if (await limited(env, req, 'pair')) return json({ error: 'too many attempts, try again in a minute' }, 429, retryAfter());
    if (await pairBusy(env)) return json({ error: 'pairing is busy, try again in a minute' }, 429, retryAfter());
    const body = await readJson(req);
    const code = normalizePairCode(body?.code);
    // It goes into the email to the account's owner: cleaned as at /auth/app/start.
    const name = deviceName(body);
    if (!code) return json({ error: 'enter the 6-character code from the account page' }, 400);
    const paired = await redeemPairCode(db, code, name, nowMs, clientFrom(req));
    if (!paired) return json({ error: 'that code is wrong or has expired' }, 400);
    ctx.waitUntil(mailDeviceAdded(env, paired.email, name, nowMs).catch(mailFailed));
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
    return json({ ok: true, profile: { ...(await getProfile(db, session.user.id, deps.graph)), limits: profileLimits() } });
  }

  if (!session) {
    // Each bad token costs a D1 read, so guessing is capped per address.
    // No token at all is just "signed out" (the homepage asks), not a guess.
    if (tokenFrom(req) && (await limited(env, req, 'badtoken'))) return json({ error: 'too many attempts, try again in a minute' }, 429, retryAfter());
    return json({ error: 'sign in first' }, 401);
  }

  // Per account: generous for a widget, an app and a browser tab together.
  if (env.RL_ME) {
    const { success } = await env.RL_ME.limit({ key: `me:${session.user.id}` });
    if (!success) return json({ error: 'too many requests, slow down' }, 429, retryAfter());
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

/**
 * /me/day's plan, kept up to a minute per user: a phone, a Mac and a browser
 * each ask every 30 s or so, and planning the whole day is the expensive
 * part. Kept under everything it's worked out from (the profile, today's
 * record, the clock style, the language, roughly where you are) and the
 * minute, so a change to any of them plans afresh at once.
 */
async function dayCached<T>(ctx: ExecutionContext, nowMs: number, inputs: unknown[], plan: () => Promise<T>): Promise<T> {
  const round = (x: unknown) => (typeof x === 'number' ? Math.round(x * 1000) / 1000 : x);
  const seed = JSON.stringify([...inputs, Math.floor(nowMs / 60_000)], (_, v) => round(v));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(seed));
  const key = new Request(`https://terminus.internal/day/${[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')}`);
  const cache = typeof caches === 'undefined' ? null : caches.default;
  const hit = await cache?.match(key).catch(() => undefined);
  if (hit) return (await hit.json()) as T;
  const fresh = await plan();
  if (cache) ctx.waitUntil(cache.put(key, new Response(JSON.stringify(fresh), { headers: { 'content-type': 'application/json', 'cache-control': 'max-age=60' } })).catch(() => {}));
  return fresh;
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
  // What this request changes in the Trip object, sent in one request at the end.
  const update: Omit<TripUpdate, 'date' | 'deleteAt'> = {};
  // At the destination, or home (this request's location): that trip is over, for every device.
  if (trip.reached && !local) {
    const label = isHomeKey(trip.reached) ? 'Home' : (answer.dest?.label ?? undefined);
    const onBus = day?.trips[trip.reached]?.kind === 'boarded' ? day.trips[trip.reached].boarded : undefined;
    update.items = [{ key: trip.reached, rec: { kind: 'arrived', at: nowMs, label, detected: true, ...(onBus ? { boarded: onBus } : {}) } }];
  }
  // Remember which bus the trip is for, so every device says it and detection
  // watches it: from when it's due, or before then when it was planned from
  // where the phone is (the widget and the Mac would otherwise each plan
  // from where the timetable puts you). Written only when the plan changes.
  if (trip.planChanged && trip.key && trip.plan && (trip.phase !== 'idle' || trip.plan.located)) {
    if (local) ctx.waitUntil(local.savePlan(trip.key, trip.plan));
    else update.plans = { [trip.key]: trip.plan };
  }
  // When the plan itself moves on (class starts, day ends). Only the planned
  // answer has one; a place or a stop never changes by itself.
  const isPlan = !url.searchParams.get('place') && !url.searchParams.get('to');
  const full: MeAnswer = isPlan ? { ...answer, refreshAt: isoSeconds(planChangesAt(profile, nowMs)) } : answer;
  // The display-ready card, in the client's 12- or 24-hour style.
  const card = cardFor(full, hour12(url, profile), trip, await feedDownSince(env, nowMs), nowMs);
  // Push: have the Trip object wake when this card next changes, to tell the
  // phones, unless it already wakes about then or sooner.
  const at = nextPhaseAt(full, trip, nowMs);
  if (!local && at !== null && pushEnabled(env) && needsWatch(day, at, nowMs) && classesOn(profile, nowMs).length) {
    update.watch = { userId, at };
  }
  if (update.items || update.plans || update.watch) {
    // The answer doesn't wait for it; a failure loses the plan or a push, not the card.
    ctx.waitUntil(updateTrip(env, userId, update, nowMs).then(
      () => undefined,
      (err: unknown) => console.error('trip state not saved', err instanceof Error ? err.message : typeof err),
    ));
  }
  // The user's walking speed, for walk times the apps show themselves (search).
  // The walk from the stop is in the card's journey; the raw seconds stay here.
  const { endWalk: _endWalk, upcoming: _upcoming, ...shown } = full;
  return { body: { ...shown, walkSpeedMs: paceSpeed(profile.walkPace), card }, trip };
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
): Promise<{ key: string | null; phase: string; remind: boolean; wakeAt: number | null } | null> {
  if (!env.DB) return null;
  const profile = await getProfile(env.DB, userId, deps.graph);
  if (!classesOn(profile, nowMs).length) return null;
  const prefs = await prefsFor(env.DB, userId, profile, nowMs);
  const url = new URL('https://terminus.internal/me/next');
  const { body, trip } = await nextWithTrip(url, env, ctx, nowMs, unlogged(deps), profile, day, userId, prefs, { savePlan: savePlanLocal });
  return { key: trip.key, phase: body.card.phase, remind: body.card.remind !== false, wakeAt: nextPhaseAt(body, trip, nowMs) };
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
  // With public buses on, the graph that has them: the same stops with more
  // services, and the public stops of their own.
  const graph = profile.publicBuses ? (deps.publicGraph ?? deps.graph) : deps.graph;
  // Without a location, start from the first home stop.
  const homeStop = profile.home ? indexGraph(graph).byCode.get(profile.home.stops[0]) : undefined;
  if (lat === null && homeStop) ({ lat, lon } = homeStop);
  if (lat === null || lon === null) return json({ error: 'turn on location, or add a home stop in Settings' }, 400);

  const idx = indexGraph(graph);
  const ranked = graph.stops
    .map((stop) => ({ stop, distM: haversineM(lat!, lon!, stop.lat, stop.lon), footM: footM(lat!, lon!, stop) }))
    .sort((a, b) => a.distM - b.distM);
  const near = ranked.filter((c) => c.distM <= WALK.maxRadiusM).slice(0, WALK.maxCandidates);
  // In a residence: its own stops, walked by the paths, like /me/next,
  // and at home your own walk to your stop.
  const homeWalk = profile.home ? { stops: profile.home.stops, m: profile.homeWalkMin * 60 * paceSpeed(profile.walkPace) } : null;
  const picked = residenceStops(lat, lon, idx.byCode, homeWalk)?.slice(0, WALK.maxCandidates) ?? (near.length ? near : ranked.slice(0, 1));
  // The nearest stop's twin (across the road, or PGP and PGP Foyer), always:
  // a location a few metres out puts you at the wrong one, and the widget
  // offers the other.
  const twinCode = picked[0] ? nearbyTwin(picked[0].stop) : null;
  const twin = twinCode ? ranked.find((c) => c.stop.code === twinCode) : undefined;
  if (twin && !picked.some((c) => c.stop.code === twin.stop.code)) picked.push(twin);

  const byStop = await deps.collectArrivals(env, ctx, picked.map((c) => c.stop.code), nowMs, graph);
  // `?stopped=1`: the services not running now too, for the Buses tab.
  const stopped = url.searchParams.get('stopped') === '1';
  const stops = picked.map(({ stop, distM, footM: foot }) => {
    const sa = byStop.get(stop.code)!;
    return {
      stop: { code: stop.code, name: stop.name, longName: displayName(stop, stop.code) },
      ...twinOf(stop, idx.byCode),
      distM: Math.round(distM),
      walkS: Math.round(foot / paceSpeed(profile.walkPace)),
      available: sa.available !== false,
      board: boardAt(graph, idx, stop.code, sa, nowMs, { stopped }),
    };
  });
  // As old as the oldest times on it, so "Updated N ago" is true.
  return json({ stops, asOf: new Date(boardAsOf(picked.map((c) => byStop.get(c.stop.code)), nowMs)).toISOString() });
}
