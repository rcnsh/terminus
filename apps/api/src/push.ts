/**
 * Push: FCM (HTTP v1) to Android, Web Push to the installed web app
 * (webpush.ts) and APNs to the iPhone app (apns.ts), all kept as the
 * session's push_token: an FCM token, `web:` and a subscription, or `apns:`
 * and a device token. An iPhone's trip Live Activity has its own token
 * beside it (sessions.live_token). A push is a nudge and the app fetches
 * the card itself (an iPhone's notification and Live Activity carry their
 * words); see internals.md, *One plan, and push*, and *A new semester* under
 * *The web app*. The Worker signs its own OAuth token from
 * FCM_SERVICE_ACCOUNT (RS256 with WebCrypto) and keeps it in KV for 50
 * minutes. A token FCM no longer knows is cleared from its session.
 *
 * An iPhone gets what Android does, the way iOS wants it: a notification
 * with words where the phone should look (the app's notification service
 * extension may re-word it from /me/next), a silent background push where
 * Android's would only update its ongoing notification, and, while a Live
 * Activity runs, that activity's update with the card in it (apns.ts).
 * An iPhone whose leave alerts are off (sessions.push_alerts, as it said
 * when it registered) gets the silent push instead of the trip's alerts, as
 * Android words and shows its own only with them on. An iPhone with its
 * Live Activity setting on and none running has its Live Activity started
 * by push (sessions.start_token) when the trip is due or missed, as
 * Android's live notification starts from those pushes.
 */

import type { Card } from './card.ts';
import { type Lang, lang as currentLang, m, withLang } from './i18n.ts';
import type { Env, MeAnswer } from './types.ts';
import {
  type ApnsPush,
  type ApnsRun,
  type LiveActivityState,
  type Loudness,
  alertPush,
  apnsEnabled,
  backgroundPush,
  livePush,
  liveActivityState,
  liveActivityTrip,
  liveStartPush,
  looksApns,
  newApnsRun,
  parseApnsToken,
  sendApns,
} from './apns.ts';
import { WEB_PREFIX, type WebSubscription, b64url, parseSubscription, sendWebPush, warnUnusable, webPushEnabled } from './webpush.ts';

const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const TOKEN_KV = 'fcm:access';
const TOKEN_TTL_S = 50 * 60;
/** Google answers in well under a second; a hung call mustn't hold up the other devices, or the Trip object's alarm. */
const FCM_TIMEOUT_MS = 5_000;

interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
  token_uri?: string;
}

/** What a push says; the app fetches the card itself. */
export interface Nudge {
  phase: string;
  /** Worth waking the phone for. */
  urgent: boolean;
  /** False when reminders are off for this trip: the web app then isn't
   *  pushed, since a web push must show a notification. */
  remind?: boolean;
  /** The answer and card it's about: an iPhone's notification and Live Activity are worded from them. */
  answer?: MeAnswer & { card: Card };
  /** The language `answer` is worded in; by default the current request's. */
  lang?: Lang;
  /**
   * The same answer worded in another language, for an iPhone pushed in
   * that one (sessions.push_lang). Asked once per language, and only for an
   * iPhone's; without it, or when it fails, that iPhone gets the phase's
   * words in its language and no Live Activity update.
   */
  answerIn?: (lang: Lang) => Promise<(MeAnswer & { card: Card }) | null>;
  /** The trip is over (no trip now): an iPhone's Live Activity ends. */
  tripOver?: boolean;
  /** The trip's phase changed since the last push: the Live Activity's update is priority 10 (Apple budgets those). */
  phaseChanged?: boolean;
  /** Start the Live Activity on iPhones that can start one by push and have none running (tripdo.ts says when). */
  startLive?: boolean;
}

function account(env: Env): ServiceAccount | null {
  if (!env.FCM_SERVICE_ACCOUNT) return null;
  try {
    const a = JSON.parse(env.FCM_SERVICE_ACCOUNT) as ServiceAccount;
    if (a.project_id && a.client_email && a.private_key) return a;
  } catch {
    // Unreadable: said once below, like one missing a field.
  }
  warnUnusable('FCM_SERVICE_ACCOUNT');
  return null;
}

export const fcmEnabled = (env: Env) => account(env) !== null;

/** Whether push is set up at all. */
export const pushEnabled = (env: Env) => fcmEnabled(env) || webPushEnabled(env) || apnsEnabled(env);

const b64urlText = (s: string) => b64url(new TextEncoder().encode(s));

async function signJwt(a: ServiceAccount, nowS: number): Promise<string> {
  const pem = a.private_key.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const head = b64urlText(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64urlText(
    JSON.stringify({
      iss: a.client_email,
      scope: SCOPE,
      aud: a.token_uri ?? 'https://oauth2.googleapis.com/token',
      iat: nowS,
      exp: nowS + 3600,
    }),
  );
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${head}.${claims}`));
  return `${head}.${claims}.${b64url(sig)}`;
}

/** How long Google's access tokens last. */
const TOKEN_LIFE_S = 3600;

/**
 * The token kept in the isolate too, so a push batch doesn't read KV each
 * time: until the KV entry would expire for one this isolate minted, and for
 * one read back from KV (put there at most TOKEN_TTL_S ago) only for the
 * part of its life that is certainly left.
 */
const tokenMemo = new WeakMap<object, { token: string; until: number }>();

async function accessToken(env: Env, a: ServiceAccount, nowMs: number): Promise<string> {
  const kept = tokenMemo.get(env.KV);
  if (kept && nowMs < kept.until) return kept.token;
  const cached = await env.KV.get(TOKEN_KV).catch(() => null);
  if (cached) {
    tokenMemo.set(env.KV, { token: cached, until: nowMs + (TOKEN_LIFE_S - TOKEN_TTL_S) * 1000 });
    return cached;
  }
  const res = await fetch(a.token_uri ?? 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: await signJwt(a, Math.floor(nowMs / 1000)),
    }),
    signal: AbortSignal.timeout(FCM_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`fcm oauth ${res.status}`);
  const { access_token } = (await res.json()) as { access_token?: string };
  if (!access_token) throw new Error('fcm oauth: no token');
  await env.KV.put(TOKEN_KV, access_token, { expirationTtl: TOKEN_TTL_S }).catch(() => {});
  tokenMemo.set(env.KV, { token: access_token, until: nowMs + TOKEN_TTL_S * 1000 });
  return access_token;
}

/** What a delivery did: how many devices it reached, and how many it should have but didn't. */
export interface Delivered {
  sent: number;
  failed: number;
}

/**
 * Nudges every device of a user that registered for push. Never throws:
 * push is a nicety on top of the apps' own refresh.
 */
export async function nudgeUser(env: Env, userId: string, nudge: Nudge, nowMs: number, exceptTokenHash?: string): Promise<Delivered> {
  // Every web push shows a notification (iOS insists), so nothing to show
  // means nothing sent: an idle card, or reminders off for the trip.
  const quiet = nudge.phase === 'idle' || nudge.remind === false;
  const data = { kind: 'card', phase: nudge.phase };
  const answer = nudge.answer;
  const expiresS = Math.floor(nowMs / 1000) + 600;
  const { worded, prepare } = wordings(answer ?? null, nudge.lang, nudge.answerIn);
  const ending = Boolean(nudge.tripOver) || nudge.phase === 'arrived';
  return deliver(
    env,
    userId,
    {
      web: quiet ? null : { kind: 'card', phase: nudge.phase, urgent: nudge.urgent },
      fcm: data,
      prepare,
      // An iPhone: a notification where the web app gets one (loud only when
      // it's time to look), and a silent push otherwise, while the Live
      // Activity shows the trip instead, or with its leave alerts off. Its
      // words in its own language: the card's, else the phase's.
      ios: (l, hasLive, alerts) => {
        if (quiet || !alerts || (hasLive && !nudge.urgent)) return backgroundPush(data, expiresS);
        const a = worded.get(l);
        const words = a ? cardWords(a.card) : withLang(l, () => phaseWords(nudge.phase));
        const loudness: Loudness = nudge.urgent && !answer?.card.gone ? 'time-sensitive' : 'passive';
        return alertPush({ ...words, data, loudness, collapse: 'card', expiresS });
      },
      // Its Live Activity, worded the same way. Without the card in its
      // language it waits for the Trip object's next update, but an end is
      // sent in any language rather than leave a finished trip showing.
      live: answer
        ? (l) => {
            const a = worded.get(l) ?? (ending ? answer : null);
            return a ? { state: liveActivityState(a), event: ending ? 'end' : 'update', urgent: Boolean(nudge.phaseChanged) } : null;
          }
        : null,
      // A Live Activity started where none runs, in the iPhone's language
      // only: a start in the wrong one would show until the next update.
      start:
        answer && nudge.startLive && !ending
          ? (l, alerts) => {
              const a = worded.get(l);
              return a
                ? liveStartPush(liveActivityState(a), liveActivityTrip(a), cardWords(a.card), alerts, Math.floor(nowMs / 1000))
                : null;
            }
          : null,
      urgent: nudge.urgent,
      collapse: 'card',
      ttlS: 600,
    },
    nowMs,
    exceptTokenHash,
  );
}

/**
 * An answer in each iPhone's language: the one given (in `lang`, by default
 * the current request's), and others asked for (`answerIn`) only when an
 * iPhone in that language is about to be sent to, once each (`prepare`).
 * One that can't be had is null.
 */
function wordings(answer: (MeAnswer & { card: Card }) | null, lang?: Lang, answerIn?: Nudge['answerIn']) {
  const worded = new Map<Lang, (MeAnswer & { card: Card }) | null>([[lang ?? currentLang(), answer]]);
  const prepare =
    answer && answerIn
      ? async (langs: Lang[]) => {
          for (const l of langs) {
            if (worded.has(l)) continue;
            worded.set(
              l,
              await answerIn(l).catch((err: unknown) => {
                console.error('push: card not worded', err instanceof Error ? err.message : typeof err);
                return null;
              }),
            );
          }
        }
      : undefined;
  return { worded, prepare };
}

/** What a Live Activity update is about: the card to word it from, as nudgeUser takes it, or a state already worded. */
export type LiveUpdate = (Pick<Nudge, 'lang' | 'answerIn'> & { answer: MeAnswer & { card: Card } }) | { state: LiveActivityState };

/**
 * Updates the Live Activities of a user's iPhones alone, when what the
 * activity shows changed but the trip's phase didn't (a bus running late).
 * Nothing else is pushed. From an answer, each iPhone's is worded in its
 * own language as nudgeUser's are; one with no card in its language waits
 * for the next update, but an end goes in any. A state already worded (the
 * last one sent, to end it) goes to every iPhone as it is.
 */
export async function updateLive(env: Env, userId: string, update: LiveUpdate, event: 'update' | 'end', nowMs: number): Promise<Delivered> {
  let live: (l: Lang) => LiveSend | null;
  let prepare: Delivery['prepare'];
  if ('state' in update) {
    const state = update.state;
    live = () => ({ state, event, urgent: false });
  } else {
    const w = wordings(update.answer, update.lang, update.answerIn);
    prepare = w.prepare;
    live = (l) => {
      const a = w.worded.get(l) ?? (event === 'end' ? update.answer : null);
      return a ? { state: liveActivityState(a), event, urgent: false } : null;
    };
  }
  return deliver(env, userId, { web: null, fcm: {}, prepare, live, onlyLive: true, urgent: false, collapse: 'card', ttlS: 600 }, nowMs);
}

/** A card's notification: its phase, and the trip in a line. */
function cardWords(card: Card): { title: string; body: string } {
  return { title: card.phaseText ?? card.heading ?? card.title, body: card.line };
}

/** A notification for a phase when there's no card to word it from. */
function phaseWords(phase: string): { title: string; body: string } {
  const t = m();
  const title =
    { due: t.phaseDue, heading: t.phaseHeading, waiting: t.phaseWaiting, riding: t.phaseRiding, missed: t.phaseMissed }[phase] ??
    t.pushTitle;
  return { title, body: t.pushOpen };
}

/** A notification worded by the server, in English and Chinese: the app shows the one in its language. */
export interface Notice {
  title: string;
  body: string;
  zhTitle: string;
  zhBody: string;
}

/**
 * The new semester's reminder (monitor.ts): a notification the apps show,
 * rather than a card to fetch. Says how many devices took it and how many
 * failed; none of either means there was nobody it could go to.
 */
export async function remindUser(env: Env, userId: string, notice: Notice, nowMs: number): Promise<Delivered> {
  const words = { title: notice.title, body: notice.body, zhTitle: notice.zhTitle, zhBody: notice.zhBody };
  const expiresS = Math.floor(nowMs / 1000) + 2 * 86_400;
  return deliver(
    env,
    userId,
    {
      web: { kind: 'term', ...words },
      fcm: { kind: 'term', ...words },
      fcmBare: { kind: 'term' },
      // In the language the iPhone registered in, the account's choice first.
      ios: (l) =>
        alertPush({
          title: l === 'zh' ? notice.zhTitle : notice.title,
          body: l === 'zh' ? notice.zhBody : notice.body,
          data: { kind: 'term', ...words },
          loudness: 'active',
          collapse: 'term',
          expiresS,
        }),
      urgent: false,
      collapse: 'term',
      ttlS: 2 * 86_400,
    },
    nowMs,
  );
}

/** The first Android version that fetches the reminder's words itself (GET /api/me/notice). */
export const NOTICE_FETCH_FROM = [2, 5, 0] as const;

/** Whether the app behind this session (its x-terminus-client, "android/2.5.0") fetches the reminder's words. */
export function fetchesNotice(client: string | null): boolean {
  const v = /^android\/(\d+)\.(\d+)\.(\d+)/.exec(client ?? '');
  if (!v) return false;
  const [a, b, c] = v.slice(1).map(Number);
  const [x, y, z] = NOTICE_FETCH_FROM;
  return a !== x ? a > x : b !== y ? b > y : c >= z;
}

interface Delivery {
  /** The web push's payload, or null to send browsers nothing. */
  web: Record<string, unknown> | null;
  /** FCM data: strings only. */
  fcm: Record<string, string>;
  /** What an app that fetches the words itself is sent instead (fetchesNotice). */
  fcmBare?: Record<string, string>;
  /** Before anything is sent, with the languages of the iPhones to be sent to (with APNs on). */
  prepare?: (langs: Lang[]) => Promise<void>;
  /**
   * What an iPhone is sent, in its language, knowing whether a Live Activity
   * of its runs and whether its leave alerts are on (true when it never
   * said). Null or absent: nothing.
   */
  ios?: (lang: Lang, hasLive: boolean, alerts: boolean) => ApnsPush | null;
  /** A Live Activity update for the iPhones running one, in the iPhone's language; null: none for it. */
  live?: ((lang: Lang) => LiveSend | null) | null;
  /**
   * A Live Activity's start, for the iPhones that registered a token to
   * start one (their setting is on) and have none running, knowing whether
   * their leave alerts are on; null: none for it.
   */
  start?: ((lang: Lang, alerts: boolean) => ApnsPush | null) | null;
  /** Only the Live Activities: no device is sent anything else. */
  onlyLive?: boolean;
  urgent: boolean;
  /** A newer message with the same key replaces one not yet delivered. */
  collapse: string;
  ttlS: number;
}

/** Sends one message to every device of a user that takes push, and clears tokens that are gone. */
async function deliver(env: Env, userId: string, msg: Delivery, nowMs: number, exceptTokenHash?: string): Promise<Delivered> {
  const out: Delivered = { sent: 0, failed: 0 };
  const db = env.DB;
  if (!pushEnabled(env) || !db) return out;
  const a = account(env);
  let results: Row[];
  try {
    ({ results } = await db
      .prepare(
        msg.onlyLive
          ? 'SELECT token_hash, push_token, client, live_token, start_token, push_lang, push_alerts FROM sessions WHERE user_id = ? AND live_token IS NOT NULL AND token_hash != ?'
          : 'SELECT token_hash, push_token, client, live_token, start_token, push_lang, push_alerts FROM sessions WHERE user_id = ? AND (push_token IS NOT NULL OR live_token IS NOT NULL) AND token_hash != ?',
      )
      .bind(userId, exceptTokenHash ?? '')
      .all<Row>());
  } catch (err) {
    console.error('push failed', err instanceof Error ? err.message : typeof err);
    return { sent: 0, failed: 1 };
  }
  const forget = (tokenHash: string) =>
    db
      .prepare('UPDATE sessions SET push_token = NULL, live_token = NULL, start_token = NULL, push_alerts = NULL WHERE token_hash = ?')
      .bind(tokenHash)
      .run();
  const forgetLive = (tokenHash: string) => db.prepare('UPDATE sessions SET live_token = NULL WHERE token_hash = ?').bind(tokenHash).run();
  const forgetStart = (tokenHash: string) =>
    db.prepare('UPDATE sessions SET start_token = NULL WHERE token_hash = ?').bind(tokenHash).run();
  const count = async (res: PushResult, gone: () => Promise<unknown>) => {
    if (res === 'sent') out.sent++;
    else if (res === 'failed') out.failed++;
    else if (res === 'gone') await gone();
  };
  const fcm: Fcm = { bearer: null, down: false };
  const apns = newApnsRun();
  const langOf = (r: Row): Lang => (r.push_lang === 'zh' ? 'zh' : 'en');
  const iphones = apnsEnabled(env) ? results.filter((r) => looksApns(r.push_token ?? '') || r.live_token) : [];
  if (msg.prepare && iphones.length) await msg.prepare([...new Set(iphones.map(langOf))]);
  for (const r of results) {
    // One device's failure (a key that won't import, a service that hangs) mustn't stop the rest.
    try {
      const token = r.push_token ?? '';
      const iphone = looksApns(token);
      const live = r.live_token ? (msg.live?.(langOf(r)) ?? null) : null;
      if (!msg.onlyLive && token) {
        const res = token.startsWith(WEB_PREFIX)
          ? await toBrowser(env, token, msg, nowMs)
          : iphone
            ? await toIphone(env, apns, token, langOf(r), live !== null, r.push_alerts !== 0, msg, nowMs)
            : a
              ? await toAndroid(env, a, fcm, { push_token: token, client: r.client }, msg, nowMs)
              : 'skip';
        await count(res, () => forget(r.token_hash));
      }
      if (live && r.live_token) await count(await toLiveActivity(env, apns, r.live_token, live, nowMs), () => forgetLive(r.token_hash));
      // None running: started, where the iPhone can start one by push.
      const start =
        !msg.onlyLive && !r.live_token && r.start_token && iphone ? (msg.start?.(langOf(r), r.push_alerts !== 0) ?? null) : null;
      if (start && r.start_token) await count(await toStartToken(env, apns, r.start_token, start, nowMs), () => forgetStart(r.token_hash));
    } catch (err) {
      console.error('push failed', err instanceof Error ? err.message : typeof err);
      out.failed++;
    }
  }
  return out;
}

interface Row {
  token_hash: string;
  push_token: string | null;
  client: string | null;
  live_token: string | null;
  /** An iPhone's token to start a Live Activity by push, kept while its Live Activity setting is on. */
  start_token: string | null;
  push_lang: string | null;
  /** An iPhone's leave alerts: 0 off, 1 on, null not said (a build from before it was sent). */
  push_alerts: number | null;
}

type PushResult = 'sent' | 'failed' | 'gone' | 'skip';

/** One Live Activity's update or end. */
interface LiveSend {
  state: LiveActivityState;
  event: 'update' | 'end';
  urgent: boolean;
}

async function toBrowser(env: Env, pushToken: string, msg: Delivery, nowMs: number): Promise<PushResult> {
  // Without a usable VAPID key no browser can be sent to: nobody reached, not a failure to retry.
  if (!msg.web || !webPushEnabled(env)) return 'skip';
  let sub: WebSubscription | null = null;
  try {
    sub = parseSubscription(JSON.parse(pushToken.slice(WEB_PREFIX.length)));
  } catch {
    // Unreadable: treated as gone, like a subscription that fails its checks.
  }
  if (!sub) return 'gone';
  return sendWebPush(env, sub, msg.web, { urgent: msg.urgent, nowMs, topic: msg.collapse, ttlS: msg.ttlS }).catch((err) => {
    console.error('web push', String(err));
    return 'failed' as const;
  });
}

async function toIphone(
  env: Env,
  run: ApnsRun,
  pushToken: string,
  l: Lang,
  hasLive: boolean,
  alerts: boolean,
  msg: Delivery,
  nowMs: number,
): Promise<PushResult> {
  const push = msg.ios?.(l, hasLive, alerts);
  if (!push) return 'skip';
  // Stored only once checked (POST /me/push): one that doesn't read is gone.
  const token = parseApnsToken(pushToken);
  if (!token || token.kind !== 'device') return 'gone';
  return sendApns(env, run, token, push, nowMs);
}

async function toLiveActivity(env: Env, run: ApnsRun, liveToken: string, live: LiveSend, nowMs: number): Promise<PushResult> {
  const token = parseApnsToken(liveToken);
  if (token?.kind !== 'live') return 'gone';
  return sendApns(env, run, token, livePush(live.state, live.event, Math.floor(nowMs / 1000), live.urgent), nowMs);
}

async function toStartToken(env: Env, run: ApnsRun, startToken: string, push: ApnsPush, nowMs: number): Promise<PushResult> {
  const token = parseApnsToken(startToken);
  if (token?.kind !== 'start') return 'gone';
  return sendApns(env, run, token, push, nowMs);
}

/** One delivery's FCM access token, shared by its devices; `down` once it couldn't be had. */
interface Fcm {
  bearer: string | null;
  down: boolean;
}

async function toAndroid(
  env: Env,
  a: ServiceAccount,
  fcm: Fcm,
  to: { push_token: string; client: string | null },
  msg: Delivery,
  nowMs: number,
): Promise<PushResult> {
  // Without an access token no device can be sent to: asking again for each would only wait longer.
  if (fcm.down) return 'failed';
  const send = (token: string) =>
    fetch(`https://fcm.googleapis.com/v1/projects/${a.project_id}/messages:send`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        message: {
          token: to.push_token,
          // An app that fetches the words itself is sent only the kind (GET /api/me/notice).
          data: msg.fcmBare && fetchesNotice(to.client) ? msg.fcmBare : msg.fcm,
          android: { priority: msg.urgent ? 'HIGH' : 'NORMAL', ttl: `${msg.ttlS}s`, collapse_key: msg.collapse },
        },
      }),
      signal: AbortSignal.timeout(FCM_TIMEOUT_MS),
    });
  try {
    fcm.bearer ??= await accessToken(env, a, nowMs);
  } catch (err) {
    fcm.down = true;
    throw err;
  }
  let res = await send(fcm.bearer);
  if (res.status === 401) {
    // The access token went stale before its cache entry did: a new one, and once more.
    tokenMemo.delete(env.KV);
    await env.KV.delete(TOKEN_KV).catch(() => {});
    fcm.bearer = null;
    try {
      fcm.bearer = await accessToken(env, a, nowMs);
    } catch (err) {
      fcm.down = true;
      throw err;
    }
    res = await send(fcm.bearer);
  }
  if (res.ok) return 'sent';
  const why = await fcmError(res);
  if (why.tokenGone) return 'gone';
  // Never the token: the status and FCM's code say what went wrong.
  console.error('fcm send', res.status, why.code);
  return 'failed';
}

type FcmErrorBody = {
  error?: { status?: string; message?: string; details?: { errorCode?: string; fieldViolations?: { field?: string }[] }[] };
};

/**
 * Whether FCM's error says this device's token is no good: UNREGISTERED (the
 * app was uninstalled), or a 400 that names the token as the bad field or, as
 * FCM usually words it, says the registration token isn't valid. Any other 400
 * is our message's fault, and must not cost every phone its token.
 */
export async function fcmError(res: Response): Promise<{ tokenGone: boolean; code: string }> {
  const body = (await res.json().catch(() => null)) as FcmErrorBody | null;
  const details = Array.isArray(body?.error?.details) ? body.error.details : [];
  const code = details.find((d) => typeof d?.errorCode === 'string')?.errorCode ?? body?.error?.status ?? '';
  const namesToken = details.some((d) => Array.isArray(d?.fieldViolations) && d.fieldViolations.some((v) => v?.field === 'message.token'));
  const badToken = namesToken || /registration token/i.test(String(body?.error?.message ?? ''));
  return { tokenGone: res.status === 404 || code === 'UNREGISTERED' || (res.status === 400 && badToken), code };
}

/** Who a user's pushes can reach. */
export interface Audience {
  /** Devices that take push: an iPhone only with APNs on. */
  devices: number;
  /** Of them, the iPhones' Live Activities running (0 with APNs off). */
  lives: number;
  /** The language the latest iPhone is pushed in; null with none, or APNs off. */
  iphoneLang: Lang | null;
}

/**
 * Who a user's pushes can reach, in one read. An iPhone counts only with
 * APNs on: its token is kept when it's off, but a Trip object waking every
 * 30 s for a phone nothing can be sent to would wake all day for nothing.
 */
export async function pushAudience(env: Env, userId: string): Promise<Audience> {
  const none: Audience = { devices: 0, lives: 0, iphoneLang: null };
  if (!pushEnabled(env) || !env.DB) return none;
  const r = await env.DB.prepare(
    `SELECT COUNT(*) AS n,
       SUM(push_token IS NOT NULL AND push_token NOT LIKE 'apns:%') AS others,
       SUM(live_token IS NOT NULL) AS lives,
       (SELECT push_lang FROM sessions WHERE user_id = ? AND push_token LIKE 'apns:%' ORDER BY last_seen DESC LIMIT 1) AS lang,
       SUM(push_token LIKE 'apns:%') AS iphones
     FROM sessions WHERE user_id = ? AND (push_token IS NOT NULL OR live_token IS NOT NULL)`,
  )
    .bind(userId, userId)
    .first<{ n: number; others: number | null; lives: number | null; lang: string | null; iphones: number | null }>();
  if (!r) return none;
  if (!apnsEnabled(env)) return { devices: r.others ?? 0, lives: 0, iphoneLang: null };
  return { devices: r.n, lives: r.lives ?? 0, iphoneLang: r.iphones ? (r.lang === 'zh' ? 'zh' : 'en') : null };
}

/** How many of a user's devices take push (pushAudience). */
export async function pushDevices(env: Env, userId: string): Promise<number> {
  return (await pushAudience(env, userId)).devices;
}

/**
 * Registers (or with null, forgets) this device's push token: an FCM token,
 * a web subscription or an iPhone's `apns:` token, with the language an
 * iPhone's notifications are worded in and whether its leave alerts are on
 * (null: not said, so alerts as before). An iPhone's Live Activity setting
 * turned off (`live` false) forgets its token to start one, so none is
 * started by push. A token lives on one session only. Forgetting it forgets
 * the Live Activity's tokens too.
 */
export async function setPushToken(
  db: D1Database,
  tokenHash: string,
  pushToken: string | null,
  lang: Lang | null = null,
  alerts: boolean | null = null,
  live: boolean | null = null,
): Promise<void> {
  const stmts = [];
  if (pushToken)
    stmts.push(
      db.prepare('UPDATE sessions SET push_token = NULL, push_lang = NULL, push_alerts = NULL WHERE push_token = ?').bind(pushToken),
    );
  stmts.push(
    pushToken
      ? db
          .prepare('UPDATE sessions SET push_token = ?, push_lang = ?, push_alerts = ? WHERE token_hash = ?')
          .bind(pushToken, lang, alerts === null ? null : alerts ? 1 : 0, tokenHash)
      : db
          .prepare(
            'UPDATE sessions SET push_token = NULL, push_lang = NULL, push_alerts = NULL, live_token = NULL, start_token = NULL WHERE token_hash = ?',
          )
          .bind(tokenHash),
  );
  if (pushToken && live === false) stmts.push(db.prepare('UPDATE sessions SET start_token = NULL WHERE token_hash = ?').bind(tokenHash));
  await db.batch(stmts);
}

/** Registers this iPhone's Live Activity token (`apnsla:`), the latest replacing the last. One session only. */
export async function setLiveToken(db: D1Database, tokenHash: string, liveToken: string): Promise<void> {
  await db.batch([
    db.prepare('UPDATE sessions SET live_token = NULL WHERE live_token = ?').bind(liveToken),
    db.prepare('UPDATE sessions SET live_token = ? WHERE token_hash = ?').bind(liveToken, tokenHash),
  ]);
}

/** Registers this iPhone's token to start a Live Activity (`apnsstart:`), the latest replacing the last. One session only. */
export async function setStartToken(db: D1Database, tokenHash: string, startToken: string): Promise<void> {
  await db.batch([
    db.prepare('UPDATE sessions SET start_token = NULL WHERE start_token = ?').bind(startToken),
    db.prepare('UPDATE sessions SET start_token = ? WHERE token_hash = ?').bind(startToken, tokenHash),
  ]);
}

/** The language a user's iPhone notifications are worded in when the account follows each device: the latest iPhone's. */
export async function iphoneLang(env: Env, userId: string): Promise<Lang> {
  if (!env.DB) return 'en';
  const r = await env.DB.prepare(
    "SELECT push_lang FROM sessions WHERE user_id = ? AND push_token LIKE 'apns:%' ORDER BY last_seen DESC LIMIT 1",
  )
    .bind(userId)
    .first<{ push_lang: string | null }>()
    .catch(() => null);
  return r?.push_lang === 'zh' ? 'zh' : 'en';
}
