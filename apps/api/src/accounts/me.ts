import { mailFeedback, parseFeedback, saveFeedback } from '../ops/feedback.ts';
import { logNextTook, logSignal, logStep } from '../ops/analytics.ts';
import { approvable, decide, enterCode, holdAppLogins, mergeAnonymous, pollAppLogin, startAppLogin } from './applogin.ts';
import type { Env, Graph, GraphIndex, Stop, StopArrivals } from '../types.ts';
import {
  ACCOUNT_TTL,
  type SessionInfo,
  authenticate,
  clientFrom,
  clientOutdated,
  UPDATE_REQUIRED,
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
import { PROFILE_LIMITS, type Profile, profileLimits, classKey, classesOn, parseProfile, reimportReason } from '../timetable/profile.ts';
import { askOf, hour12, planned, resolveTo } from '../answer/next.ts';
import { answerRequest, loadRider, prefsFor, tripDay } from '../answer/rider.ts';
import { dayPlan } from '../timetable/day.ts';
import { type MeDeps, unlogged } from '../answer/answer.ts';
import { getProfile, pinnable } from './profiles.ts';
import { PLATE_WINDOW_S, SIGNALS, type TripRecord, clearTrip, loadDay, saveSignals, sgtDate, updateTrip } from '../answer/trip.ts';
import { type PlateLookup, applySignal } from '../answer/signal.ts';
import { setLiveToken, setPushToken, setStartToken } from '../push/push.ts';
import { formatApnsToken, looksApns, parseApnsToken } from '../push/apns.ts';
import { WEB_PREFIX, parseSubscription, vapidPublicKey, webPushEnabled } from '../push/webpush.ts';
import { NO_PREFS, type PrefKind, clearHistory, clearOutcome, historySize, listPrefs, recordOutcome, setPref } from './outcomes.ts';
import { ImportInputError, parseShareUrl, resolveTrips } from '../timetable/nusmods.ts';
import { termName } from '../timetable/calendar.ts';
import { NEARBY_LATER, boardAsOf, boardAt, displayName, indexGraph, nearbyDest, nearbyRow } from '../answer/resolve.ts';
import { type ServiceBoard, departuresFrom } from '../answer/departures.ts';
import { stopVia, viaText } from '../answer/via.ts';
import { haversineM } from '../geo.ts';
import { isoSeconds } from '../answer/format.ts';
import { termNoticeFor } from '../ops/monitor.ts';
import { WALK, sgt } from '../config.ts';
import { landmark } from '../answer/landmarks.ts';
import { GRAPH, GRAPH_PUBLIC, oppositeOrPartner, oppositeOf } from '../answer/graph.ts';
import { residenceStops } from '../answer/residences.ts';
import { MAX_KEYS, createKey, listKeys, revokeKey } from './access.ts';
import { buildingStops, footM, paceSpeed } from '../answer/walk.ts';
import { clientKey, coords, coordsFrom, json } from '../http.ts';
import { parseTarget } from '../answer/step.ts';
import { linkOrigin } from '../origin.ts';
import { type Lang, type LangPref, lang, m } from '../i18n.ts';
import { ROUTE_COLORS } from '../map/campus.ts';

const html = (body: string, status = 200, extra: Record<string, string> = {}) =>
  new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...extra } });

function liveryHtml(): string {
  const u = 180 / 300;
  const left = 180 - 60 * u + 50;
  const right = left - 100;
  const band = (from: number, to: number, fill: string) =>
    `<path d="M0 ${left - from}L400 ${right - from}L400 ${right - to}L0 ${left - to}Z" fill="${fill}"/>`;
  const colours = ['R2', 'R1', 'K', 'D2', 'D1', 'A2', 'A1'].map((svc) => ROUTE_COLORS[svc]);
  return `<div class="livery" aria-hidden="true"><svg viewBox="0 0 400 180" preserveAspectRatio="none">${band(0, 6 * u, 'var(--accent-bright)')}${colours.map((c, i) => band((16 + 20 * i) * u, (36 + 20 * i) * u + 0.6, c)).join('')}</svg></div>`;
}

const page = (title: string, intro: string, form = '') => `<!doctype html>
<html lang="${lang() === 'zh' ? 'zh-Hans' : 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${title} · terminus</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="preload" href="/assets/fonts/inter-latin.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/assets/fonts/space-grotesk-latin.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/assets/fonts.css">
<link rel="stylesheet" href="/assets/site.css">
<link rel="stylesheet" href="/account/account.css">
<style>.signin-intro .btn{margin-top:20px}form.signin-alt .link-btn{padding:0}
.number{display:block;min-height:72px;text-align:center;font:700 2.2rem/1 var(--display);letter-spacing:.3em;font-variant-numeric:tabular-nums}
.sent-icon.done{background:color-mix(in srgb,var(--good) 14%,transparent);color:var(--good)}.sent-icon.cancelled{background:color-mix(in srgb,var(--ink) 8%,transparent);color:var(--ink)}
@media (min-width:900px){.signin-step.solo{display:block;max-width:44rem;text-align:center}.solo .sent-icon{margin:0 auto 16px}}</style>
</head><body><header class="wrap nav"><a class="brand" href="/"><img src="/assets/mark.svg" alt=""><span class="wordmark">termi<b>nus</b></span></a></header>
<main class="wrap"><section class="signin">${liveryHtml()}<div class="signin-step${form ? '' : ' solo'}"><div class="signin-intro">${intro}</div>${form ? `<div class="signin-form">${form}</div>` : ''}</div></section></main></body></html>`;

const stroke = (d: string) =>
  `<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const NOTICE_ICONS = {
  done: stroke('<path d="m5 12 5 5 9-10"/>'),
  expired: stroke('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  cancelled: stroke('<path d="M7 7l10 10M17 7 7 17"/>'),
};

const notice = (title: string, icon: keyof typeof NOTICE_ICONS, inner: string) =>
  page(title, `<div class="sent-icon ${icon}" aria-hidden="true">${NOTICE_ICONS[icon]}</div>${inner}`);

const MAX_BODY_BYTES = 64 * 1024;

function emailOrigin(url: URL, env: Env): string {
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname.endsWith('.test');
  return local ? url.origin : linkOrigin(env);
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const mailFailed = (e: unknown) => console.error('device email failed', e instanceof Error ? e.name : typeof e);

function stepTrip(profile: Profile, key: string, nowMs: number): boolean {
  if (key.startsWith('place:')) return profile.places.some((p) => `place:${p.key}` === key);
  if (key.startsWith('to:')) return /^to:[A-Za-z0-9_-]{1,24}$/.test(key);
  return knownTrip(profile, key, nowMs);
}

function knownTrip(profile: Profile, key: string, nowMs: number): boolean {
  if (/^home:(\d{1,4}|evening)$/.test(key) || /^gap-home:[A-Za-z0-9_-]{1,24}$/.test(key)) return true;
  return [...profile.trips, ...profile.manual, ...classesOn(profile, nowMs)].some((t) => classKey(t) === key);
}

function deviceName(body: Record<string, unknown> | null): string {
  if (typeof body?.name !== 'string') return '';
  const name = body.name
    .replace(/[^\p{L}\p{N} ()'_-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);
  return name;
}

function clientWith(req: Request, body: Record<string, unknown> | null) {
  const c = clientFrom(req);
  if (c.client) return c;
  const named = PLATFORMS.find((p) => p === body?.platform);
  return named ? { ...c, platform: named } : c;
}

function sgtTime(ms: number): string {
  const d = new Date(ms + 8 * 3_600_000);
  const hm = `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  if (lang() === 'zh') return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日 ${hm}`;
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()];
  return `${hm}, ${d.getUTCDate()} ${month}`;
}

export async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  const type = (req.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') return null;
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

const MAX_FORM_BYTES = 4096;
async function readForm(req: Request): Promise<URLSearchParams | null> {
  if (Number(req.headers.get('content-length') ?? 0) > MAX_FORM_BYTES) return null;
  const text = await readCapped(req, MAX_FORM_BYTES).catch(() => null);
  return text !== null ? new URLSearchParams(text) : null;
}

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

const LOCKED = 'too many wrong codes for this address today; use the link in the email';

const retryAfter = (seconds = 60): Record<string, string> => ({ 'retry-after': String(seconds) });

async function limited(env: Env, req: Request, scope: string): Promise<boolean> {
  if (!env.RL_AUTH) return false;
  const { success } = await env.RL_AUTH.limit({ key: `${scope}:${clientKey(req)}` });
  return !success;
}

async function pairBusy(env: Env): Promise<boolean> {
  if (!env.RL_PAIR) return false;
  return !(await env.RL_PAIR.limit({ key: 'pair:global' })).success;
}

async function pushLang(db: D1Database, userId: string): Promise<Lang> {
  const chosen = ((await loadProfileJson(db, userId).catch(() => null)) as { lang?: unknown } | null)?.lang;
  return chosen === 'en' || chosen === 'zh' ? chosen : lang();
}

async function refreshPushLang(db: D1Database, userId: string, tokenHash: string, pref: LangPref): Promise<void> {
  try {
    if (pref === 'auto') {
      await db
        .prepare("UPDATE sessions SET push_lang = ? WHERE token_hash = ? AND push_token LIKE 'apns:%' AND push_lang IS NOT ?")
        .bind(lang(), tokenHash, lang())
        .run();
    } else {
      await db
        .prepare("UPDATE sessions SET push_lang = ? WHERE user_id = ? AND push_token LIKE 'apns:%' AND push_lang IS NOT ?")
        .bind(pref, userId, pref)
        .run();
    }
  } catch (err) {
    console.error('push language not saved', err instanceof Error ? err.message : typeof err);
  }
}

const PROFILE_TRIES = 3;
const PROFILE_CHANGED = 'your settings were changed on another device; try again';

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

export function ifMatchVersion(req: Request): number | null | undefined {
  const m = /^\s*(?:W\/)?"(\d{1,16})"\s*$/.exec(req.headers.get('if-match') ?? '');
  if (!m) return undefined;
  const v = Number(m[1]);
  return v === 0 ? null : v;
}

const versionTag = (v: number | null | undefined) => `"${v ?? 0}"`;

interface MeContext {
  req: Request;
  url: URL;
  env: Env;
  ctx: ExecutionContext;
  nowMs: number;
  deps: MeDeps;
  db: D1Database;
  session: SessionInfo;
  rest: string;
}

interface MeRoute {
  method: string;
  path: string;
  access?: 'web';
  run: (c: MeContext) => Promise<Response>;
}

async function plateAt(
  env: Env,
  ctx: ExecutionContext,
  deps: MeDeps,
  stopCode: string | undefined,
  svc: string,
  nowMs: number,
  graph: Graph,
): Promise<{ plate?: string; at?: string }> {
  if (!stopCode) return {};
  try {
    const sa = (await deps.collectArrivals(env, ctx, [stopCode], nowMs, graph)).get(stopCode);
    const near = (sa?.arrivals ?? [])
      .filter((x) => x.svc === svc && x.plate && x.etaS !== null && x.etaS <= PLATE_WINDOW_S)
      .sort((x, y) => x.etaS! - y.etaS!)[0];
    return near?.plate && sa ? { plate: near.plate, at: isoSeconds(sa.fetchedAt + near.etaS! * 1000) } : {};
  } catch {
    return {};
  }
}

export const ME_ROUTES: MeRoute[] = [
  {
    method: 'DELETE',
    path: '/api/me',
    run: async ({ env, db, session }) => {
      if (session.kind !== 'web' && session.user.email !== null) return json({ error: 'delete the account from the account page' }, 403);
      if (session.paired) return json({ error: 'only the device that started this account can do that' }, 403);
      await deleteAccount(db, session.user);
      await clearTrip(env, session.user.id);
      if (session.user.email) await forgetSignInCode(env, session.user.email);
      return json({ ok: true }, 200, { 'set-cookie': sessionCookie('', 0) });
    },
  },
  {
    method: 'GET',
    path: '/api/me/export',
    run: async ({ env, db, session, nowMs }) => {
      return json(await exportAccount(db, session.user, await loadDay(env, session.user.id, nowMs)), 200, {
        'content-disposition': 'attachment; filename="terminus-export.json"',
      });
    },
  },
  {
    method: 'DELETE',
    path: '/api/me/sessions',
    access: 'web',
    run: async ({ db, session }) => {
      const ended = await endAllSessions(db, session.user);
      return json({ ok: true, ended }, 200, { 'set-cookie': sessionCookie('', 0) });
    },
  },
  {
    method: 'GET',
    path: '/api/me',
    run: async ({ req, nowMs, db, session }) => {
      const token = session.kind === 'web' ? tokenFrom(req) : null;
      const renewed = token !== null && (await renewWebSession(db, session.tokenHash, nowMs));
      const saved = await loadProfileJson(db, session.user.id);
      const profile = await getProfile(db, session.user.id, GRAPH, saved);
      const reason = reimportReason(profile, nowMs);
      return json(
        {
          email: session.user.email,
          anonymous: session.user.email === null,
          kind: session.kind,
          needsReimport: reason !== null,
          reimportReason: reason,
          term: profile.term ? termName(profile.term) : null,
          onboarding: onboardingFor(saved !== null, profile.seen),
        },
        200,
        renewed && token ? { 'set-cookie': sessionCookie(token, ACCOUNT_TTL.webSessionMs / 1000) } : {},
      );
    },
  },
  {
    method: 'GET',
    path: '/api/me/profile',
    run: async ({ db, session }) => {
      const row = await loadProfileRow(db, session.user.id);
      const profile = await getProfile(db, session.user.id, GRAPH, row?.json ?? null);
      return json({ ...profile, limits: profileLimits() }, 200, { etag: versionTag(row?.updated) });
    },
  },
  {
    method: 'PUT',
    path: '/api/me/profile',
    run: async ({ req, nowMs, db, session }) => {
      const body = await readJson(req);
      if (!body) return json({ error: 'send the profile as JSON' }, 400);
      const idx = indexGraph(GRAPH);
      const r = parseProfile(
        body,
        (c) => idx.byCode.has(c),
        (c) => idx.byCode.has(c) || landmark(c) !== null,
        pinnable(GRAPH),
      );
      if (!r.ok) return json({ error: r.error }, 400);
      r.profile.once = r.profile.once.filter((o) => o.date >= sgtDate(nowMs));
      const from = ifMatchVersion(req);
      const version =
        from === undefined
          ? await saveProfileJson(db, session.user.id, r.profile, nowMs)
          : await saveProfileIf(db, session.user.id, r.profile, nowMs, from);
      if (version === null) return json({ error: PROFILE_CHANGED }, 412);
      await refreshPushLang(db, session.user.id, session.tokenHash, r.profile.lang);
      return json({ ...r.profile, limits: profileLimits() }, 200, { etag: versionTag(version) });
    },
  },
  {
    method: 'POST',
    path: '/api/me/once',
    run: async ({ req, url, env, ctx, nowMs, deps, db, session }) => {
      const body = await readJson(req);
      const changed = await changeProfile(db, session.user.id, GRAPH, nowMs, (profile) => {
        const saved = typeof body?.place === 'string' ? profile.places.find((p) => p.key === body.place) : undefined;
        const dest = saved ? { to: saved.to, label: saved.label } : typeof body?.to === 'string' ? resolveTo(GRAPH, body.to) : null;
        if (!dest) return json({ error: "send place (a favourite's key) or to (a stop, place or room code)" }, 400);
        const atMin = body?.atMin;
        if (typeof atMin !== 'number' || !Number.isInteger(atMin) || atMin < 0 || atMin > 1439)
          return json({ error: 'atMin must be minutes past midnight, Singapore time' }, 400);
        const today = sgtDate(nowMs);
        const date = typeof body?.date === 'string' ? body.date : today;
        const day = Date.parse(`${date}T00:00:00Z`);
        const real = /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(day) && new Date(day).toISOString().slice(0, 10) === date;
        if (!real || date < today || date > sgtDate(nowMs + 7 * 86_400_000))
          return json({ error: 'date must be today or within the next week (YYYY-MM-DD)' }, 400);
        if (date === today && atMin <= sgt(nowMs).minutes) return json({ error: 'that time has passed today' }, 400);
        const label = typeof body?.label === 'string' && body.label.trim() ? body.label.trim().slice(0, PROFILE_LIMITS.label) : dest.label;
        const once = profile.once.filter((o) => o.date >= today && !(o.date === date && o.arriveByMin === atMin && o.to === dest.to));
        if (once.length >= PROFILE_LIMITS.once) return json({ error: m().tooManyOnce(PROFILE_LIMITS.once) }, 400);
        once.push({ date, arriveByMin: atMin, to: dest.to, label });
        once.sort((a, b) => a.date.localeCompare(b.date) || a.arriveByMin - b.arriveByMin);
        return { ...profile, once };
      });
      if (changed instanceof Response) return changed;
      const asked = askOf(url);
      const rider = await loadRider(env, session.user.id, nowMs, { profile: changed.profile, asked });
      return json(await answerRequest(env, ctx, deps, rider, asked, nowMs));
    },
  },
  {
    method: 'POST',
    path: '/api/me/import',
    run: async ({ env, req, nowMs, db, session }) => {
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
      if (r.failed.length) {
        return json({ error: m().nusmodsNoAnswer(r.failed.join(', ')), failed: r.failed }, 502);
      }
      if (!r.trips.length && !r.unresolved.length) {
        const why = r.missing.length ? m().modsNoClasses(r.missing.join(', '), r.missing.length !== 1, term) : m().linkNoClasses(term);
        return json({ error: m().nothingImported(why), missing: r.missing }, 422);
      }
      const changed = await changeProfile(db, session.user.id, GRAPH, nowMs, (profile) => ({
        ...profile,
        trips: r.trips.slice(0, PROFILE_LIMITS.trips),
        share,
        term: r.term,
      }));
      if (changed instanceof Response) return changed;
      const { profile } = changed;
      const dropped = Math.max(0, r.trips.length - PROFILE_LIMITS.trips);
      return json(
        {
          profile: { ...profile, limits: profileLimits() },
          unresolved: r.unresolved,
          missing: r.missing,
          online: r.online,
          term,
          ...(dropped ? { dropped } : {}),
        },
        200,
        { etag: versionTag(changed.version) },
      );
    },
  },
  {
    method: 'POST',
    path: '/api/me/pair-code',
    run: async ({ nowMs, db, session }) => {
      if (session.paired) return json({ error: 'only the device that started this account can do that' }, 403);
      return json(await createPairCode(db, session.user.id, nowMs));
    },
  },
  {
    method: 'GET',
    path: '/api/me/keys',
    run: async ({ db, session }) => {
      return json({ keys: await listKeys(db, session.user.id) });
    },
  },
  {
    method: 'POST',
    path: '/api/me/keys',
    access: 'web',
    run: async ({ req, nowMs, db, session }) => {
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
    path: '/api/me/keys/',
    access: 'web',
    run: async ({ db, session, rest }) => {
      const ok = await revokeKey(db, session.user.id, rest);
      return ok ? json({ ok: true }) : json({ error: 'no such key' }, 404);
    },
  },
  {
    method: 'GET',
    path: '/api/me/devices',
    run: async ({ db, session }) => {
      return json({ devices: await listDevices(db, session.user.id, session.tokenHash) });
    },
  },
  {
    method: 'DELETE',
    path: '/api/me/devices/',
    run: async ({ db, session, rest }) => {
      if (session.paired) return json({ error: 'only the device that started this account can do that' }, 403);
      const name = await revokeDevice(db, session.user.id, rest);
      if (name === null) return json({ error: 'no such device' }, 404);
      return json({ ok: true });
    },
  },
  {
    method: 'GET',
    path: '/api/me/next',
    run: async ({ url, env, ctx, nowMs, deps, db, session }) => {
      const profile = await getProfile(db, session.user.id, GRAPH, session.profileJson);
      const asked = askOf(url);
      const body = await answerRequest(env, ctx, deps, await loadRider(env, session.user.id, nowMs, { profile, asked }), asked, nowMs);
      logNextTook(env, Date.now() - nowMs);
      return json(body);
    },
  },
  {
    method: 'GET',
    path: '/api/me/day',
    run: async ({ url, env, ctx, nowMs, deps, db, session }) => {
      const profile = await getProfile(db, session.user.id, GRAPH, session.profileJson);
      const [day, prefs] = await Promise.all([
        tripDay(env, session.user.id, profile, nowMs),
        prefsFor(db, session.user.id, profile, nowMs),
      ]);
      const { at: here, h12: clientH12 } = askOf(url);
      const h12 = hour12(clientH12, profile);
      const plan = () => dayPlan(env, ctx, nowMs, deps, profile, day, h12, prefs.earlier, here);
      return json(await dayCached(ctx, nowMs, [session.user.id, profile, day, h12, [...prefs.earlier], here, lang()], plan));
    },
  },
  {
    method: 'POST',
    path: '/api/me/signal',
    run: async ({ req, url, env, ctx, nowMs, deps, db, session }) => {
      if (!env.TRIPS) return json({ error: 'trip tracking is not available' }, 503);
      const body = await readJson(req);
      const kind = SIGNALS.find((k) => k === body?.kind);
      if (!kind) return json({ error: m().signalKinds(SIGNALS.join(', ')) }, 400);
      const profile = await getProfile(db, session.user.id, GRAPH);
      const asked = askOf(url);
      const here = typeof body?.lat === 'number' && typeof body?.lon === 'number' ? { ...asked, at: coords(body.lat, body.lon) } : asked;
      const day = await loadDay(env, session.user.id, nowMs);
      if (kind === 'location') {
        return json(await answerRequest(env, ctx, deps, await loadRider(env, session.user.id, nowMs, { profile, day }), here, nowMs));
      }
      if (kind === 'away' || kind === 'back') {
        const items: { key: string; rec: TripRecord | null }[] =
          kind === 'away'
            ? classesOn(profile, nowMs)
                .filter((c) => !day?.trips[classKey(c)])
                .map((c) => ({ key: classKey(c), rec: { kind: 'skipped', at: nowMs, label: c.label, away: true } }))
            : Object.entries(day?.trips ?? {})
                .filter(([, r]) => r.away)
                .map(([key]) => ({ key, rec: null }));
        const after = items.length ? await saveSignals(env, session.user.id, items, nowMs) : day;
        logSignal(env, kind);
        const rider = await loadRider(env, session.user.id, nowMs, { profile, day: after });
        return json(await answerRequest(env, ctx, deps, rider, asked, nowMs, session.tokenHash));
      }
      const now = await planned(env, ctx, unlogged(deps), { userId: session.user.id, profile, day, prefs: NO_PREFS }, here, nowMs);
      const key = typeof body?.trip === 'string' && body.trip ? body.trip.slice(0, 80) : now.trip.key;
      if (!key) return json({ error: 'no trip in progress to say that about' }, 409);
      if (key !== now.trip.key && !knownTrip(profile, key, nowMs)) return json({ error: 'no such trip today' }, 400);
      const plate: PlateLookup = (stopCode, svc, graph) => plateAt(env, ctx, deps, stopCode, svc, nowMs, graph);
      const { rec, outcome } = await applySignal(kind, key, now, day, profile, nowMs, plate);
      const next = await updateTrip(env, session.user.id, { items: [{ key, rec }] }, nowMs);
      logSignal(env, kind);
      if (outcome === 'clear') await clearOutcome(db, session.user.id, key, nowMs);
      else if (outcome) await recordOutcome(db, session.user.id, key, outcome, nowMs);
      const rider = await loadRider(env, session.user.id, nowMs, { profile, day: next });
      return json(await answerRequest(env, ctx, deps, rider, asked, nowMs, session.tokenHash));
    },
  },
  {
    method: 'POST',
    path: '/api/me/step',
    run: async ({ req, url, env, ctx, nowMs, deps, db, session }) => {
      if (!env.TRIPS) return json({ error: 'trip tracking is not available' }, 503);
      const body = await readJson(req);
      const trip = typeof body?.trip === 'string' ? body.trip : '';
      const to = parseTarget(body?.to);
      if (!trip || trip.length > 80 || (body?.to !== null && !to))
        return json(
          { error: 'send trip (card.step.trip) and to: card.step.earlier or card.step.later as it is, or null for the best bus' },
          400,
        );
      const profile = await getProfile(db, session.user.id, GRAPH);
      if (!stepTrip(profile, trip, nowMs)) return json({ error: 'no such trip today' }, 400);
      const next = await updateTrip(env, session.user.id, { steps: { [trip]: to } }, nowMs);
      logStep(env, body?.to === null ? 'best' : body?.dir === 'earlier' ? 'earlier' : 'later', trip);
      const query = askOf(url);
      const at = typeof body?.lat === 'number' && typeof body?.lon === 'number' ? coords(body.lat, body.lon) : query.at;
      const asked = trip.startsWith('place:')
        ? { ...query, at, place: trip.slice(6), to: null }
        : trip.startsWith('to:')
          ? { ...query, at, place: null, to: trip.slice(3) }
          : { ...query, at };
      const rider = await loadRider(env, session.user.id, nowMs, { profile, day: next });
      return json(await answerRequest(env, ctx, deps, rider, asked, nowMs, session.tokenHash));
    },
  },
  {
    method: 'POST',
    path: '/api/me/push',
    run: async ({ req, env, db, session }) => {
      const body = await readJson(req);
      if (body?.subscription !== undefined) {
        if (!webPushEnabled(env)) return json({ error: 'web push is not set up on this server' }, 503);
        const sub = parseSubscription(body.subscription);
        if (!sub) return json({ error: 'send subscription: an https endpoint with keys.p256dh and keys.auth' }, 400);
        await setPushToken(db, session.tokenHash, WEB_PREFIX + JSON.stringify(sub));
        return json({ ok: true });
      }
      const token = typeof body?.token === 'string' ? body.token.trim() : '';
      if (looksApns(token)) {
        const t = parseApnsToken(token);
        if (!t)
          return json(
            {
              error:
                'send token as apns:<hex device token>, apnsla:<hex Live Activity token> or apnsstart:<hex Live Activity start token>, with :sandbox from a development build',
            },
            400,
          );
        const alerts = typeof body?.alerts === 'boolean' ? body.alerts : null;
        const live = typeof body?.live === 'boolean' ? body.live : null;
        const activity = typeof body?.activity === 'boolean' ? body.activity : null;
        const h12 = typeof body?.h12 === 'boolean' ? body.h12 : null;
        if (t.kind === 'live') await setLiveToken(db, session.tokenHash, formatApnsToken(t));
        else if (t.kind === 'start') await setStartToken(db, session.tokenHash, formatApnsToken(t));
        else
          await setPushToken(db, session.tokenHash, formatApnsToken(t), await pushLang(db, session.user.id), alerts, live, activity, h12);
        return json({ ok: true });
      }
      if (!token || token.length > 4096 || token.startsWith(WEB_PREFIX))
        return json({ error: 'send token (the FCM registration token) or subscription' }, 400);
      await setPushToken(db, session.tokenHash, token);
      return json({ ok: true });
    },
  },
  {
    method: 'GET',
    path: '/api/me/push/key',
    run: async ({ env }) => {
      const key = vapidPublicKey(env);
      return key ? json({ key }) : json({ error: 'web push is not set up on this server' }, 503);
    },
  },
  {
    method: 'DELETE',
    path: '/api/me/push',
    run: async ({ db, session }) => {
      await setPushToken(db, session.tokenHash, null);
      return json({ ok: true });
    },
  },
  {
    method: 'POST',
    path: '/api/me/choice',
    run: async ({ req, nowMs, db, session }) => {
      const body = await readJson(req);
      const choice = CHOICES.find((c) => c === body?.choice);
      const [pref, trip] =
        typeof body?.id === 'string' && body.id.includes(':')
          ? [body.id.slice(0, body.id.indexOf(':')), body.id.slice(body.id.indexOf(':') + 1)]
          : [body?.pref, body?.trip];
      if (!choice || (pref !== 'earlier' && pref !== 'quiet') || typeof trip !== 'string' || !trip || trip.length > 80) {
        return json(
          { error: "send id (from card.suggestion) or trip and pref ('earlier' or 'quiet'), and choice: accept, dismiss or undo" },
          400,
        );
      }
      const profile = await getProfile(db, session.user.id, GRAPH);
      if (!knownTrip(profile, trip, nowMs)) return json({ error: 'no such trip today' }, 400);
      const label = [...profile.trips, ...profile.manual, ...classesOn(profile, nowMs)].find((t) => classKey(t) === trip)?.label ?? null;
      await setPref(db, session.user.id, trip, pref as PrefKind, choice, label, nowMs);
      return json({ ok: true, choices: await listPrefs(db, session.user.id) });
    },
  },
  {
    method: 'GET',
    path: '/api/me/notice',
    run: async ({ db, session, nowMs }) => {
      return json({ notice: termNoticeFor((await loadProfileJson(db, session.user.id)) as Parameters<typeof termNoticeFor>[0], nowMs) });
    },
  },
  {
    method: 'GET',
    path: '/api/me/choices',
    run: async ({ db, session }) => {
      return json({ choices: await listPrefs(db, session.user.id), history: await historySize(db, session.user.id) });
    },
  },
  {
    method: 'DELETE',
    path: '/api/me/history',
    run: async ({ db, session }) => {
      const cleared = await clearHistory(db, session.user.id);
      return json({ ok: true, cleared });
    },
  },
  {
    method: 'POST',
    path: '/api/me/feedback',
    run: async ({ req, env, ctx, nowMs, db, session }) => {
      const email = session.user.email;
      if (!email) return json({ error: 'sign in to send feedback' }, 403);
      const parsed = parseFeedback(await readJson(req));
      if (!parsed.ok) return json({ error: parsed.error }, 400);
      const id = await saveFeedback(db, session.user.id, parsed.value, nowMs);
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
    path: '/api/me/nearby',
    run: async ({ url, env, ctx, nowMs, deps, db, session }) => {
      const profile = await getProfile(db, session.user.id, GRAPH);
      return nearbyFor(url, env, ctx, nowMs, deps, profile);
    },
  },
  {
    method: 'GET',
    path: '/api/me/stops',
    run: async ({ url, env, ctx, nowMs, deps, db, session }) => {
      const profile = await getProfile(db, session.user.id, GRAPH);
      return stopsFor(url, env, ctx, nowMs, deps, profile);
    },
  },
];

async function browserAnon(db: D1Database, req: Request, nowMs: number): Promise<string | null> {
  const s = await authenticate(db, req, nowMs);
  return s?.kind === 'web' && s.user.email === null ? s.user.id : null;
}

export async function handleMe(
  req: Request,
  url: URL,
  env: Env,
  ctx: ExecutionContext,
  nowMs: number,
  deps: MeDeps,
): Promise<Response | null> {
  const path = url.pathname;
  const emailed = path === '/auth/verify' || path === '/auth/approve';
  if (
    !(
      emailed ||
      path.startsWith('/api/auth/') ||
      path === '/api/pair' ||
      path === '/api/pair/check' ||
      path === '/api/me' ||
      path.startsWith('/api/me/')
    )
  )
    return null;
  const db = env.DB;
  if (!db) return json({ error: 'accounts are not configured' }, 503);
  const fetchSite = req.headers.get('sec-fetch-site');
  if (
    req.method !== 'GET' &&
    req.method !== 'HEAD' &&
    req.method !== 'OPTIONS' &&
    fetchSite &&
    fetchSite !== 'same-origin' &&
    fetchSite !== 'none'
  ) {
    const setsSession =
      path === '/auth/verify' ||
      path === '/auth/approve' ||
      path === '/api/auth/logout' ||
      path === '/api/auth/code' ||
      path === '/api/auth/anon/web';
    const bearer = req.headers.get('authorization')?.startsWith('Bearer ') || req.headers.has('x-api-key');
    if (setsSession || (!bearer && hasSessionCookie(req))) return json({ error: 'that request came from another site' }, 403);
  }

  if ((path === '/auth/verify' || path === '/api/auth/config') && env.RL_PUBLIC) {
    if (!(await env.RL_PUBLIC.limit({ key: `pub:${clientKey(req)}` })).success)
      return json({ error: 'too many requests, slow down' }, 429, retryAfter());
  }

  if (path === '/api/auth/config' && req.method === 'GET') {
    return json({ turnstileSiteKey: env.TURNSTILE_SECRET ? (env.TURNSTILE_SITE_KEY ?? null) : null });
  }

  if (path === '/api/auth/login' && req.method === 'POST') {
    if (await limited(env, req, 'login')) return json({ error: 'too many attempts, try again in a minute' }, 429, retryAfter());
    const body = await readJson(req);
    const email = normalizeEmail(body?.email);
    if (!email) return json({ error: 'enter a valid email address' }, 400);
    const human = await checkTurnstile(env, body?.turnstile, req.headers.get('cf-connecting-ip'));
    if (human === 'unavailable')
      return json({ error: 'the human check is not answering, try again in a minute' }, 503, { 'retry-after': '60' });
    if (human === 'failed') return json({ error: 'the human check failed, try again' }, 400);
    let outcome;
    try {
      outcome = await requestLink(env, db, email, emailOrigin(url, env), nowMs, body?.next === '/app/');
    } catch (err) {
      console.error('sign-in email failed', err instanceof Error ? err.name : typeof err);
      return json({ error: 'could not send the email, try again later' }, 502);
    }
    if (outcome === 'busy') return json({ error: 'sign-in is busy, try again in a minute' }, 429, retryAfter());
    return json({ ok: true, message: m().checkEmail });
  }

  if (path === '/api/auth/code' && req.method === 'POST') {
    if (await limited(env, req, 'code')) return json({ error: 'too many attempts, try again in a minute' }, 429, retryAfter());
    const body = await readJson(req);
    const email = normalizeEmail(body?.email);
    const code = normalizePairCode(body?.code);
    if (!email || !code) return json({ error: 'enter the 6-character code from the email' }, 400);
    const done = await redeemCode(env, db, email, code, nowMs, await browserAnon(db, req, nowMs));
    if (!done) return json({ error: 'that code is wrong or has expired' }, 400);
    if (done === 'locked') return json({ error: LOCKED }, 400);
    if (done.removed) await clearTrip(env, done.removed);
    return json({ ok: true }, 200, {
      'set-cookie': sessionCookie(done.token, ACCOUNT_TTL.webSessionMs / 1000),
      'cache-control': 'no-store',
    });
  }

  if (path === '/auth/verify') {
    if (req.method === 'GET') {
      const t = url.searchParams.get('t') ?? '';
      const safe = t.replace(/[^A-Za-z0-9_-]/g, '');
      const email = safe ? await linkEmail(db, safe, nowMs) : null;
      if (!email) return html(notice(m().pageLinkExpired, 'expired', m().linkExpiredHtml), 400);
      return html(
        page(
          m().pageSignIn,
          `<h1>${m().signInTitle}</h1>
<p class="hint">${m().continueAs(escapeHtml(email))}</p>`,
          `<form method="post" action="/auth/verify"><input type="hidden" name="t" value="${safe}">${url.searchParams.get('next') === 'app' ? '<input type="hidden" name="next" value="app">' : ''}<button type="submit" class="btn accent wide">${m().signInButton}</button></form>`,
        ),
      );
    }
    if (req.method === 'POST') {
      const form = await readForm(req);
      const t = form?.get('t');
      const done = typeof t === 'string' ? await redeemLink(db, t, nowMs, await browserAnon(db, req, nowMs)) : null;
      if (done?.removed) await clearTrip(env, done.removed);
      const token = done?.token;
      if (!token) {
        return html(notice(m().pageLinkExpired, 'expired', m().linkExpiredHtml), 400);
      }
      const location = form?.get('next') === 'app' ? '/account/?next=/app/' : '/account';
      return new Response(null, {
        status: 303,
        headers: { location, 'set-cookie': sessionCookie(token, ACCOUNT_TTL.webSessionMs / 1000), 'cache-control': 'no-store' },
      });
    }
  }

  if (path === '/api/auth/anon' && req.method === 'POST') {
    if (await limited(env, req, 'anon')) return json({ error: 'too many attempts, try again in a minute' }, 429, retryAfter());
    if (env.RL_ANON && !(await env.RL_ANON.limit({ key: 'anon:global' })).success) {
      return json({ error: 'terminus is busy, try again in a minute' }, 429, retryAfter());
    }
    const body = await readJson(req);
    const token = await createAnonymous(db, deviceName(body), clientWith(req, body), nowMs);
    return json({ token }, 201);
  }

  if (path === '/api/auth/anon/web' && req.method === 'POST') {
    if (await limited(env, req, 'anon')) return json({ error: 'too many attempts, try again in a minute' }, 429, retryAfter());
    const body = await readJson(req);
    const human = await checkTurnstile(env, body?.turnstile, req.headers.get('cf-connecting-ip'));
    if (human === 'unavailable')
      return json({ error: 'the human check is not answering, try again in a minute' }, 503, { 'retry-after': '60' });
    if (human === 'failed') return json({ error: 'the human check failed, try again' }, 400);
    if (env.RL_ANON && !(await env.RL_ANON.limit({ key: 'anon:global' })).success) {
      return json({ error: 'terminus is busy, try again in a minute' }, 429, retryAfter());
    }
    const token = await createAnonymousWeb(db, nowMs);
    return json({ ok: true }, 201, { 'set-cookie': sessionCookie(token, ACCOUNT_TTL.webSessionMs / 1000), 'cache-control': 'no-store' });
  }

  if (path === '/api/auth/app/start' && req.method === 'POST') {
    if (await limited(env, req, 'appstart')) return json({ error: 'too many attempts, try again in a minute' }, 429, retryAfter());
    const body = await readJson(req);
    const email = normalizeEmail(body?.email);
    if (!email) return json({ error: 'enter a valid email address' }, 400);
    const current = tokenFrom(req) ? await authenticate(db, req, nowMs) : null;
    if (current?.user.email) return json({ error: 'this device is already signed in' }, 409);
    const anonUserId = current && !current.paired ? current.user.id : null;
    let started;
    try {
      started = await startAppLogin(
        env,
        db,
        { email, name: deviceName(body), client: clientWith(req, body), anonUserId },
        emailOrigin(url, env),
        nowMs,
      );
    } catch (err) {
      console.error('sign-in email failed', err instanceof Error ? err.name : typeof err);
      return json({ error: 'could not send the email, try again later' }, 502);
    }
    if (started === 'cooldown')
      return json({ error: 'an email was sent to that address a moment ago; wait a minute and try again' }, 429, retryAfter());
    if (started === 'busy') return json({ error: 'sign-in is busy, try again in a minute' }, 429, retryAfter());
    if (started === 'held')
      return json(
        {
          error:
            'a sign-in to that address was turned down recently, so the app cannot ask again for a few hours; pair this device from the website instead',
        },
        403,
      );
    return json({ ...started, expires: new Date(started.expires).toISOString() }, 201);
  }

  if ((path === '/api/auth/app/poll' || path === '/api/auth/app/code') && req.method === 'POST') {
    if (env.RL_PUBLIC && !(await env.RL_PUBLIC.limit({ key: `poll:${clientKey(req)}` })).success) {
      return json({ error: 'too many requests, slow down' }, 429, retryAfter(10));
    }
    if (path === '/api/auth/app/code' && (await limited(env, req, 'appcode')))
      return json({ error: 'too many attempts, try again in a minute' }, 429, retryAfter());
    const body = await readJson(req);
    if (typeof body?.request !== 'string' || typeof body?.poll !== 'string') return json({ error: 'send request and poll' }, 400);
    if (path === '/api/auth/app/code') {
      const code = normalizePairCode(body.code);
      const entered = code ? await enterCode(env, db, body.request, body.poll, code, nowMs) : 'wrong';
      if (entered === 'wrong') return json({ status: 'pending', error: "that code isn't right; check the email and try again" }, 400);
      if (entered === 'locked') return json({ status: 'pending', error: LOCKED }, 400);
      if (entered !== 'approved')
        return json(
          { status: entered, error: entered === 'denied' ? 'too many wrong codes; start again' : 'that request expired; start again' },
          400,
        );
    }
    const r = await pollAppLogin(db, body.request, body.poll, clientWith(req, body), nowMs);
    if (r.status !== 'approved') return json({ status: r.status });
    if (r.removed) await clearTrip(env, r.removed);
    return json({ status: 'approved', token: r.token, email: r.email, outcome: r.outcome });
  }

  if (path === '/auth/approve') {
    if (req.method === 'GET') {
      if (env.RL_PUBLIC && !(await env.RL_PUBLIC.limit({ key: `pub:${clientKey(req)}` })).success)
        return json({ error: 'too many requests, slow down' }, 429, retryAfter());
      const link = (url.searchParams.get('r') ?? '').replace(/[^A-Za-z0-9_-]/g, '');
      const a = link ? await approvable(db, link, nowMs) : null;
      if (!a) return html(notice(m().pageRequestExpired, 'expired', m().approveExpiredHtml), 400);
      const device = escapeHtml(a.device || m().aDevice);
      return html(
        page(
          m().pageApprove,
          `<h1>${m().approveTitle(device)}</h1>
<p class="hint">${m().approveWhen(escapeHtml(sgtTime(a.created)))}</p>`,
          `<form method="post" action="/auth/approve"><input type="hidden" name="r" value="${link}">
<label for="n">${m().approveNumber(device)}</label>
<input class="number" id="n" name="n" inputmode="numeric" pattern="[0-9]{2}" maxlength="2" autocomplete="off" required autofocus>
<p class="hint small">${m().approveRule}</p>
<button type="submit" class="btn accent wide">${m().approveButton}</button></form>
<form class="signin-alt" method="post" action="/auth/approve"><input type="hidden" name="r" value="${link}">${m().notYou} <button type="submit" name="n" value="none" class="link-btn">${m().notMe}</button></form>
<p class="hint small">${m().notMeHint}</p>`,
        ),
      );
    }
    if (req.method === 'POST') {
      if (await limited(env, req, 'approve')) return json({ error: 'too many attempts, try again in a minute' }, 429, retryAfter());
      const form = await readForm(req);
      const r = form?.get('r');
      const typed = (form?.get('n') ?? '').trim();
      const n = /^[0-9]{1,3}$/.test(typed) ? Number(typed) : null;
      const out = typeof r === 'string' ? await decide(db, r, n, nowMs) : { status: 'expired' as const };
      if (out.status === 'approved') return html(notice(m().pageApproved, 'done', m().approvedHtml));
      if (out.status === 'denied') {
        const notMe = typed === 'none';
        if (notMe && out.email) await holdAppLogins(env, out.email);
        return html(notice(m().pageCancelled, 'cancelled', m().cancelledHtml(!notMe)), notMe ? 200 : 400);
      }
      return html(notice(m().pageRequestExpired, 'expired', m().approveExpiredHtml), 400);
    }
  }

  if (path === '/api/pair/check' && req.method === 'POST') {
    if (await limited(env, req, 'pair')) return json({ error: 'too many attempts, try again in a minute' }, 429, retryAfter());
    if (await pairBusy(env)) return json({ error: 'pairing is busy, try again in a minute' }, 429, retryAfter());
    const body = await readJson(req);
    const code = normalizePairCode(body?.code);
    const owner = code ? await pairCodeOwner(db, code, nowMs, clientFrom(req)) : null;
    if (!owner) return json({ error: 'that code is wrong or has expired' }, 400);
    if (owner.email === null) return json({ account: m().accountWithoutEmail, anonymous: true });
    return json({ account: maskEmail(owner.email), anonymous: false });
  }

  if (path === '/api/pair' && req.method === 'POST') {
    if (await limited(env, req, 'pair')) return json({ error: 'too many attempts, try again in a minute' }, 429, retryAfter());
    if (await pairBusy(env)) return json({ error: 'pairing is busy, try again in a minute' }, 429, retryAfter());
    const body = await readJson(req);
    const code = normalizePairCode(body?.code);
    const name = deviceName(body);
    if (!code) return json({ error: 'enter the 6-character code from the account page' }, 400);
    const paired = await redeemPairCode(db, code, name, nowMs, clientWith(req, body));
    if (!paired) return json({ error: 'that code is wrong or has expired' }, 400);
    ctx.waitUntil(mailDeviceAdded(env, paired.email, name, nowMs).catch(mailFailed));
    return json({ token: paired.token });
  }

  const readsProfile = req.method === 'GET' && (path === '/api/me/next' || path === '/api/me/day');
  const session = await authenticate(db, req, nowMs, ctx, readsProfile);

  if (path === '/api/auth/logout' && req.method === 'POST') {
    if (session) await endSession(db, session.tokenHash);
    else if (tokenFrom(req) && (await limited(env, req, 'badtoken')))
      return json({ error: 'too many attempts, try again in a minute' }, 429, retryAfter());
    return json({ ok: true }, 200, { 'set-cookie': sessionCookie('', 0) });
  }

  if (path === '/api/auth/app/merge' && req.method === 'POST' && session) {
    const body = await readJson(req);
    const keep = body?.keep === 'device' ? 'device' : body?.keep === 'account' ? 'account' : null;
    if (!keep || typeof body?.anon !== 'string')
      return json({ error: "send anon (the device's old token) and keep: 'account' or 'device'" }, 400);
    const r = await mergeAnonymous(db, session.user.id, body.anon, keep, nowMs);
    if (r === 'not-anonymous') return json({ error: 'that token is not an anonymous account' }, 400);
    await clearTrip(env, r.removed);
    return json({ ok: true, profile: { ...(await getProfile(db, session.user.id, GRAPH)), limits: profileLimits() } });
  }

  if (!session) {
    if (tokenFrom(req) && (await limited(env, req, 'badtoken')))
      return json({ error: 'too many attempts, try again in a minute' }, 429, retryAfter());
    return json({ error: 'sign in first' }, 401);
  }
  const leaving = req.method === 'DELETE' && (path === '/api/me/push' || path === '/api/me');
  if (!leaving && (await clientOutdated(env, req, nowMs))) return json(UPDATE_REQUIRED, 426);

  if (env.RL_ME) {
    const { success } = await env.RL_ME.limit({ key: `me:${session.user.id}` });
    if (!success) return json({ error: 'too many requests, slow down' }, 429, retryAfter());
  }
  for (const r of ME_ROUTES) {
    if (r.method !== req.method) continue;
    const prefix = r.path.endsWith('/');
    if (prefix ? !path.startsWith(r.path) : path !== r.path) continue;
    if (r.access === 'web' && session.kind !== 'web') return json({ error: 'do this from the account page' }, 403);
    return r.run({ req, url, env, ctx, nowMs, deps, db, session, rest: prefix ? path.slice(r.path.length) : '' });
  }

  return json({ error: 'not found' }, 404);
}

async function dayCached<T>(ctx: ExecutionContext, nowMs: number, inputs: unknown[], plan: () => Promise<T>): Promise<T> {
  const round = (x: unknown) => (typeof x === 'number' ? Math.round(x * 1000) / 1000 : x);
  const seed = JSON.stringify([...inputs, Math.floor(nowMs / 60_000)], (_, v) => round(v));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(seed));
  const key = new Request(
    `https://terminus.internal/day/${[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')}`,
  );
  const cache = typeof caches === 'undefined' ? null : caches.default;
  const hit = await cache?.match(key).catch(() => undefined);
  if (hit) return (await hit.json()) as T;
  const fresh = await plan();
  if (cache)
    ctx.waitUntil(
      cache
        .put(key, new Response(JSON.stringify(fresh), { headers: { 'content-type': 'application/json', 'cache-control': 'max-age=60' } }))
        .catch(() => {}),
    );
  return fresh;
}

const CHOICES = ['accept', 'dismiss', 'undo'] as const;

export function onboardingFor(hasProfile: boolean, seen: string[]): 'full' | null {
  return !hasProfile && !seen.includes('onboarding') ? 'full' : null;
}

function nearbyStop<T extends object>(
  graph: Graph,
  idx: GraphIndex,
  stop: Stop,
  sa: StopArrivals,
  nowMs: number,
  stopped: boolean,
  where: T,
) {
  const boards = new Map<string, ServiceBoard>();
  const board = boardAt(graph, idx, stop.code, sa, nowMs, { stopped, boards });
  const via = stopVia(board);
  return {
    stop: { code: stop.code, name: stop.name, longName: displayName(stop, stop.code) },
    ...oppositeOf(stop, idx.byCode),
    ...where,
    available: sa.available !== false,
    via,
    viaText: viaText(via),
    board: board.map((r) => ({
      ...nearbyRow(
        r,
        nowMs,
        !r.paid && r.etaS != null
          ? departuresFrom(graph, boards.get(r.svc), r.svc, { now: nowMs, from: nowMs, max: NEARBY_LATER + 3 })
          : [],
      ),
      ...nearbyDest(idx, r.svc, stop.code, r.via, r.towards),
    })),
  };
}

const STOPS_MAX = 8;

async function stopsFor(url: URL, env: Env, ctx: ExecutionContext, nowMs: number, deps: MeDeps, profile: Profile) {
  const asked = (url.searchParams.get('codes') ?? '')
    .split(',')
    .map((c) => c.trim().toUpperCase())
    .filter((c, i, all) => c && all.indexOf(c) === i);
  if (!asked.length) return json({ error: 'codes is required' }, 400);
  if (asked.length > STOPS_MAX) return json({ error: 'too many stops at once' }, 400);
  const shuttles = { graph: GRAPH, idx: indexGraph(GRAPH) };
  const pub = { graph: GRAPH_PUBLIC, idx: indexGraph(GRAPH_PUBLIC) };
  const usual = profile.publicBuses ? pub : shuttles;
  const found = asked
    .map((code) => {
      const g = shuttles.idx.byCode.has(code) ? usual : pub;
      return { ...g, stop: g.idx.byCode.get(code) };
    })
    .filter((f): f is typeof f & { stop: Stop } => Boolean(f.stop));
  const byStop = new Map<string, StopArrivals>();
  const read = await Promise.all(
    [shuttles, pub].map(({ graph }) => {
      const codes = found.filter((f) => f.graph === graph).map((f) => f.stop.code);
      return codes.length ? deps.collectArrivals(env, ctx, codes, nowMs, graph) : new Map<string, StopArrivals>();
    }),
  );
  for (const m of read) for (const [k, v] of m) byStop.set(k, v);
  const { lat, lon } = coordsFrom(url);
  const stopped = url.searchParams.get('stopped') === '1';
  const homeWalk = profile.home ? { stops: profile.home.stops, m: profile.homeWalkMin * 60 * paceSpeed(profile.walkPace) } : null;
  const inside =
    lat === null || lon === null
      ? null
      : (residenceStops(lat, lon, usual.idx.byCode, homeWalk) ?? buildingStops(lat, lon, usual.idx.byCode));
  const walkM = (stop: Stop): number | null =>
    lat === null || lon === null ? null : (inside?.find((c) => c.stop.code === stop.code)?.footM ?? footM(lat, lon, stop));
  const stops = found.map(({ graph, idx, stop }) => {
    const m = walkM(stop);
    return nearbyStop(graph, idx, stop, byStop.get(stop.code)!, nowMs, stopped, {
      walkS: m === null ? null : Math.round(m / paceSpeed(profile.walkPace)),
    });
  });
  return json({
    stops,
    asOf: new Date(
      boardAsOf(
        found.map((f) => byStop.get(f.stop.code)),
        nowMs,
      ),
    ).toISOString(),
  });
}

async function nearbyFor(url: URL, env: Env, ctx: ExecutionContext, nowMs: number, deps: MeDeps, profile: Profile) {
  let { lat, lon } = coordsFrom(url);
  const graph = profile.publicBuses ? GRAPH_PUBLIC : GRAPH;
  const homeStop = profile.home ? indexGraph(graph).byCode.get(profile.home.stops[0]) : undefined;
  if (lat === null && homeStop) ({ lat, lon } = homeStop);
  if (lat === null || lon === null) return json({ error: 'turn on location, or add a home stop in Settings' }, 400);

  const idx = indexGraph(graph);
  const ranked = graph.stops
    .map((stop) => ({ stop, distM: haversineM(lat!, lon!, stop.lat, stop.lon), footM: footM(lat!, lon!, stop) }))
    .sort((a, b) => a.distM - b.distM);
  const near = ranked.filter((c) => c.distM <= WALK.maxRadiusM).slice(0, WALK.maxCandidates);
  const homeWalk = profile.home ? { stops: profile.home.stops, m: profile.homeWalkMin * 60 * paceSpeed(profile.walkPace) } : null;
  const inside = residenceStops(lat, lon, idx.byCode, homeWalk) ?? buildingStops(lat, lon, idx.byCode);
  const picked = inside?.slice(0, WALK.maxCandidates) ?? (near.length ? near : ranked.slice(0, 1));
  const otherCode = picked[0] ? oppositeOrPartner(picked[0].stop) : null;
  const other = otherCode ? ranked.find((c) => c.stop.code === otherCode) : undefined;
  if (other && !picked.some((c) => c.stop.code === other.stop.code)) picked.push(other);

  const byStop = await deps.collectArrivals(
    env,
    ctx,
    picked.map((c) => c.stop.code),
    nowMs,
    graph,
  );
  const stopped = url.searchParams.get('stopped') === '1';
  const stops = picked.map(({ stop, distM, footM: foot }) =>
    nearbyStop(graph, idx, stop, byStop.get(stop.code)!, nowMs, stopped, {
      distM: Math.round(distM),
      walkS: Math.round(foot / paceSpeed(profile.walkPace)),
    }),
  );
  return json({
    stops,
    asOf: new Date(
      boardAsOf(
        picked.map((c) => byStop.get(c.stop.code)),
        nowMs,
      ),
    ).toISOString(),
  });
}
