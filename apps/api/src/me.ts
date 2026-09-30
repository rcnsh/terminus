/**
 * The personal layer: sign-in, pairing, profile, and the answers that use
 * them (/me/next, /me/nearby). Everything here needs the DB binding; the
 * public routes in index.ts never do.
 */

import { mailFeedback, parseFeedback, saveFeedback } from './feedback.ts';
import { approvable, decide, enterCode, mergeAnonymous, pollAppLogin, startAppLogin } from './applogin.ts';
import type { Answer, Env, Graph, MeAnswer, PlaceChip, ResolveInput, StopArrivals, Why } from './types.ts';
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
  redeemCode,
  redeemLink,
  redeemPairCode,
  requestLink,
  revokeDevice,
  saveProfileJson,
  sessionCookie,
  PLATFORMS,
} from './accounts.ts';
import { DEFAULT_PROFILE, PROFILE_LIMITS, type Profile, classKey, classesOn, parseProfile, planChangesAt, reimportReason } from './profile.ts';
import { hour12, planned } from './next.ts';
import { dayPlan } from './day.ts';
import { type Boarded, type DayRecord, PLATE_WINDOW_S, SIGNALS, type TripRecord, clearTrip, loadDay, savePlan, saveSignal, watchTrip } from './trip.ts';
import { nudgeUser, pushEnabled, setPushToken } from './push.ts';
import { NO_PREFS, type PrefKind, type TripPrefs, askAgain, clearHistory, clearOutcome, historySize, listPrefs, noteUnanswered, recordOutcome, setPref, tripPrefs } from './outcomes.ts';
import { type ImportedTrip, ImportInputError, parseShareUrl, resolveTrips, venueToStop } from './nusmods.ts';
import { termName } from './calendar.ts';
import { boardAt, indexGraph } from './resolve.ts';
import { haversineM } from './geo.ts';
import { isoSeconds, shortStop } from './format.ts';
import { cardFor, nextPhaseAt } from './card.ts';
import { WALK } from './config.ts';
import { landmark, targetStops } from './landmarks.ts';
import { atHome, residenceStops } from './residences.ts';
import { MAX_KEYS, createKey, listKeys, revokeKey } from './access.ts';
import { footM, paceSpeed } from './walk.ts';
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
<style>.box{max-width:25rem;margin:10vh auto 0;padding:32px 28px}.box img{width:44px;height:44px;margin-bottom:20px}.box h1{font-size:1.6rem;margin-bottom:8px}.box .btn{width:100%;margin-top:20px}.choices{display:flex;gap:10px;margin-top:20px}.box .choices .btn{flex:1;margin:0;font-size:1.5rem;font-variant-numeric:tabular-nums}.linkbtn{display:block;margin:18px auto 0;background:none;border:0;color:inherit;opacity:.7;text-decoration:underline;font:inherit;cursor:pointer}</style>
</head><body><main class="wrap"><div class="card box"><img src="/assets/mark.svg" alt="">${inner}</div></main></body></html>`;

/** A whole profile is a few KB; nothing legitimate comes close to this. */
const MAX_BODY_BYTES = 64 * 1024;

const EXPIRED = '<h1>That link has expired</h1><p class="hint">Sign-in links work once, for 15 minutes.</p><a class="btn accent" href="/account">Get a new link</a>';

/**
 * Where emailed links point. The request's own origin only for local
 * development; otherwise always the real site, whatever hostname the request
 * came in on (the old name, a workers.dev preview).
 */
function linkOrigin(url: URL): string {
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname.endsWith('.test');
  return local ? url.origin : 'https://terminus.rcn.sh';
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const APPROVE_EXPIRED = '<h1>This request has expired</h1><p class="hint">Sign-in requests work once, for 15 minutes. Start again on your device.</p>';

const mailFailed = (e: unknown) => console.error('device email failed', e instanceof Error ? e.name : typeof e);

/** "Pixel 8": what the app calls itself, shown in emails and the device list. */
function deviceName(body: Record<string, unknown> | null): string {
  return typeof body?.name === 'string' ? body.name.trim().slice(0, 40) || 'Device' : 'Device';
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
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()];
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}, ${d.getUTCDate()} ${month}`;
}

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
  const r = parseProfile(raw, (c) => idx.byCode.has(c), (c) => idx.byCode.has(c) || landmark(c) !== null);
  if (r.ok) return r.profile;
  const p = raw as Profile;
  const ok = (c: string) => idx.byCode.has(c) || landmark(c) !== null;
  return {
    ...structuredClone(DEFAULT_PROFILE),
    gapHours: typeof p.gapHours === 'number' ? p.gapHours : DEFAULT_PROFILE.gapHours,
    homeWalkMin: typeof p.homeWalkMin === 'number' ? p.homeWalkMin : DEFAULT_PROFILE.homeWalkMin,
    walkPace: p.walkPace ?? DEFAULT_PROFILE.walkPace,
    fullBusMargin: p.fullBusMargin ?? DEFAULT_PROFILE.fullBusMargin,
    seen: Array.isArray(p.seen) ? p.seen : [],
    home: p.home?.stops?.some(ok) ? { stops: p.home.stops.filter(ok) } : null,
    trips: (p.trips ?? []).filter((t) => ok(t.to)),
    manual: (p.manual ?? []).filter((t) => ok(t.to)),
    places: (p.places ?? []).filter((x) => ok(x.to)),
    share: p.share ?? null,
    term: p.term ?? null,
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
    run: async ({ nowMs, deps, db, session }) => {
      const saved = await loadProfileJson(db, session.user.id);
      const profile = await getProfile(db, session.user.id, deps.graph);
      const reason = reimportReason(profile, nowMs);
      return json({
        email: session.user.email,
        anonymous: session.user.email === null,
        kind: session.kind,
        needsReimport: reason !== null,
        reimportReason: reason,
        term: profile.term ? termName(profile.term) : null,
        onboarding: onboardingFor(saved !== null, profile.seen),
      });
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
      await saveProfileJson(db, session.user.id, r.profile, nowMs);
      return json(r.profile);
    },
  },
  {
    method: 'POST',
    path: '/me/import',
    run: async ({ req, nowMs, deps, db, session }) => {
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
      if (!made) return json({ error: `you can have ${MAX_KEYS} keys; revoke one first` }, 409);
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
      return json(await dayPlan(env, ctx, nowMs, deps, profile, day, hour12(url), prefs.earlier));
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
      if (!kind) return json({ error: `kind is one of ${SIGNALS.join(', ')}` }, 400);
      const profile = await getProfile(db, session.user.id, deps.graph);
      // A location travels in the body; it's used for this answer and not kept.
      const here = new URL(url);
      if (typeof body?.lat === 'number' && typeof body?.lon === 'number') {
        here.searchParams.set('lat', String(body.lat));
        here.searchParams.set('lon', String(body.lon));
      }
      const day = await loadDay(env, session.user.id, nowMs);
      const now = await planned(here, env, ctx, nowMs, deps, profile, day);
      const key = typeof body?.trip === 'string' && body.trip ? body.trip.slice(0, 80) : now.trip.key;
      if (!key) return json({ error: 'no trip in progress to say that about' }, 409);
      const current = key === now.trip.key;
      // After the planned bus has left, "On it" and "Missed it" are about that
      // bus (the plan), not the next one the answer has moved on to.
      const p = current ? now.trip.plan : null;
      const gone = p?.board ? Date.parse(p.board) <= nowMs + 60_000 : false;
      const l = current
        ? gone && p
          ? { ...(now.answer.leave ?? {}), svc: p.svc, stop: p.stop, board: p.board, arrive: p.arrive, off: p.off, stopCode: p.stopCode, offCode: p.alightCode }
          : now.answer.leave
        : null;
      const label = current ? (now.answer.dest?.label ?? undefined) : classesOn(profile, nowMs).find((c) => classKey(c) === key)?.label;
      let rec: TripRecord | null | undefined;
      switch (kind) {
        case 'reset':
          rec = null;
          break;
        case 'location':
          // Only what the location means is kept, never the location.
          rec = current && now.answer.arrived ? { kind: 'arrived', at: nowMs, label } : current && now.trip.phase === 'waiting' ? { kind: 'waiting', at: nowMs, label } : undefined;
          break;
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
      const next = rec === undefined ? day : await saveSignal(env, session.user.id, key, rec, nowMs);
      logSignal(env, kind);
      // What happened to the trip, for what terminus learns (outcomes.ts).
      const outcome = rec ? OUTCOME_OF[rec.kind] : undefined;
      if (rec === null) await clearOutcome(db, session.user.id, key, nowMs);
      else if (outcome) await recordOutcome(db, session.user.id, key, outcome, nowMs);
      const prefs = await prefsFor(db, session.user.id, profile, nowMs);
      const out = await nextBody(url, env, ctx, nowMs, deps, profile, next, session.user.id, prefs);
      // A tap here changes the other phones' cards now, not at their next refresh.
      if (rec !== undefined) {
        ctx.waitUntil(nudgeUser(env, session.user.id, { phase: out.card.phase, ask: out.card.ask !== null, urgent: false }, nowMs, session.tokenHash));
      }
      return json(out);
    },
  },
  {
    method: 'POST',
    path: '/me/push',
    run: async ({ req, db, session }) => {
      // This device's Firebase token: the Trip object nudges it when the card changes.
      const body = await readJson(req);
      const token = typeof body?.token === 'string' ? body.token.trim() : '';
      if (!token || token.length > 4096) return json({ error: 'send token (the FCM registration token)' }, 400);
      await setPushToken(db, session.tokenHash, token);
      return json({ ok: true });
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
      const label = [...profile.trips, ...profile.manual].find((t) => classKey(t) === trip)?.label ?? null;
      await setPref(db, session.user.id, trip, pref as PrefKind, choice, label, nowMs);
      return json({ ok: true, choices: await listPrefs(db, session.user.id) });
    },
  },
  {
    method: 'GET',
    path: '/me/choices',
    run: async ({ nowMs, deps, db, session }) => {
      const profile = await getProfile(db, session.user.id, deps.graph);
      const prefs = await prefsFor(db, session.user.id, profile, nowMs);
      return json({ choices: await listPrefs(db, session.user.id), askMuted: prefs.askMuted, history: await historySize(db, session.user.id) });
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
    run: async ({ nowMs, db, session }) => {
      // "Ask if I caught the bus" back on: earlier silence no longer counts.
      await askAgain(db, session.user.id, nowMs);
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
      await requestLink(env, db, email, linkOrigin(url), nowMs);
    } catch (err) {
      // The error text can carry the recipient: log its kind only.
      console.error('sign-in email failed', err instanceof Error ? err.name : typeof err);
      return json({ error: 'could not send the email, try again later' }, 502);
    }
    // Same answer whether or not the address is blocked or already has an account.
    return json({ ok: true, message: 'Check your email for a sign-in code.' });
  }

  if (path === '/auth/code' && req.method === 'POST') {
    // The emailed code, typed on the page that asked for it.
    if (await limited(env, req, 'code')) return json({ error: 'too many attempts, try again in a minute' }, 429);
    const body = await readJson(req);
    const email = normalizeEmail(body?.email);
    const code = normalizePairCode(body?.code);
    if (!email || !code) return json({ error: 'enter the 6-character code from the email' }, 400);
    const token = await redeemCode(env, db, email, code, nowMs);
    if (!token) return json({ error: 'that code is wrong or has expired' }, 400);
    return json({ ok: true }, 200, { 'set-cookie': sessionCookie(token, ACCOUNT_TTL.webSessionMs / 1000), 'cache-control': 'no-store' });
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
      if (!email) return html(page('Link expired', EXPIRED), 400);
      return html(page('Sign in', `<h1>Sign in to terminus</h1>
<p class="hint">Continue as <strong>${escapeHtml(maskEmail(email))}</strong> on this device. If that isn't your address, close this page.</p>
<form method="post" action="/auth/verify"><input type="hidden" name="t" value="${safe}"><button type="submit" class="btn accent">Sign in</button></form>`));
    }
    if (req.method === 'POST') {
      const form = await req.formData().catch(() => null);
      const t = form?.get('t');
      const token = typeof t === 'string' ? await redeemLink(db, t, nowMs) : null;
      if (!token) {
        return html(page('Link expired', EXPIRED), 400);
      }
      return new Response(null, {
        status: 303,
        headers: { location: '/account', 'set-cookie': sessionCookie(token, ACCOUNT_TTL.webSessionMs / 1000), 'cache-control': 'no-store' },
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
      started = await startAppLogin(env, db, { email, name: deviceName(body), client: clientWith(req, body), anonUserId: current?.user.id ?? null }, linkOrigin(url), nowMs);
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
      if (!a) return html(page('Request expired', APPROVE_EXPIRED), 400);
      const device = escapeHtml(a.device);
      const buttons = a.choices
        .map((n) => `<button type="submit" name="n" value="${n}" class="btn">${n}</button>`)
        .join('');
      return html(page('Approve sign-in', `<h1>Sign in terminus on ${device}?</h1>
<p class="hint">Requested ${escapeHtml(sgtTime(a.created))}. Choose the number ${device} is showing.</p>
<form method="post" action="/auth/approve"><input type="hidden" name="r" value="${link}"><div class="choices">${buttons}</div></form>
<form method="post" action="/auth/approve"><input type="hidden" name="r" value="${link}"><button type="submit" name="n" value="none" class="linkbtn">This wasn't me</button></form>`));
    }
    if (req.method === 'POST') {
      if (await limited(env, req, 'approve')) return json({ error: 'too many attempts, try again in a minute' }, 429);
      const form = await req.formData().catch(() => null);
      const r = form?.get('r');
      const n = Number(form?.get('n'));
      const out = typeof r === 'string' ? await decide(db, r, Number.isInteger(n) ? n : null, nowMs) : 'expired';
      if (out === 'approved') return html(page('Approved', '<h1>Approved</h1><p class="hint">Go back to your device: it will be signed in in a few seconds. You can close this page.</p>'));
      if (out === 'denied') {
        const picked = form?.get('n') !== 'none';
        return html(
          page('Cancelled', `<h1>Cancelled</h1><p class="hint">${picked ? "That wasn't the number on the device, so" : 'Nothing was signed in:'} the request is cancelled. If you were signing in, start again on your device.</p>`),
          picked ? 400 : 200,
        );
      }
      return html(page('Request expired', APPROVE_EXPIRED), 400);
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
  // Nobody answered the question and the plan was taken as what happened:
  // noted once as "no answer", which is what mutes the question in the end.
  if (trip.assumed && trip.key && trip.plan && !trip.plan.noted && env.DB) {
    const key = trip.key;
    const plan = { ...trip.plan, noted: true };
    ctx.waitUntil(Promise.all([noteUnanswered(env.DB, userId, key, nowMs), keepPlan(key, plan)]).catch(outcomeFailed));
  }
  // From when the trip is due, remember which bus it's for, so the question at
  // its departure is about that bus. Written only when the plan changes.
  if (trip.planChanged && trip.key && trip.plan && trip.phase !== 'idle') ctx.waitUntil(keepPlan(trip.key, trip.plan));
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
  return { body: { ...full, card }, trip };
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
): Promise<{ key: string | null; phase: string; ask: boolean; wakeAt: number | null } | null> {
  if (!env.DB) return null;
  const profile = await getProfile(env.DB, userId, deps.graph);
  if (!classesOn(profile, nowMs).length) return null;
  const prefs = await prefsFor(env.DB, userId, profile, nowMs);
  const url = new URL('https://terminus.internal/me/next');
  const { body, trip } = await nextWithTrip(url, env, ctx, nowMs, deps, profile, day, userId, prefs, { savePlan: savePlanLocal });
  return { key: trip.key, phase: body.card.phase, ask: body.card.ask !== null, wakeAt: nextPhaseAt(body, trip, nowMs) };
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

  const byStop = await deps.collectArrivals(env, ctx, picked.map((c) => c.stop.code), nowMs);
  const stops = picked.map(({ stop, distM, footM: foot }) => {
    const sa = byStop.get(stop.code)!;
    return {
      stop: { code: stop.code, name: stop.name },
      distM: Math.round(distM),
      walkS: Math.round(foot / paceSpeed(profile.walkPace)),
      available: sa.available !== false,
      board: boardAt(deps.graph, idx, stop.code, sa, nowMs),
    };
  });
  return json({ stops, asOf: new Date(nowMs).toISOString() });
}
