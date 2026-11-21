import type { Card } from '../answer/card.ts';
import { type Lang, lang as currentLang, m, withLang } from '../i18n.ts';
import type { Env, MeAnswer } from '../types.ts';
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
const FCM_TIMEOUT_MS = 5_000;

interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
  token_uri?: string;
}

export interface Nudge {
  phase: string;
  urgent: boolean;
  remind?: boolean;
  answer?: MeAnswer & { card: Card };
  lang?: Lang;
  answerIn?: AnswerIn;
  clockChosen?: boolean;
  tripOver?: boolean;
  phaseChanged?: boolean;
  startLive?: boolean;
  startedFor?: ReadonlySet<string>;
}

function account(env: Env): ServiceAccount | null {
  if (!env.FCM_SERVICE_ACCOUNT) return null;
  try {
    const a = JSON.parse(env.FCM_SERVICE_ACCOUNT) as ServiceAccount;
    if (a.project_id && a.client_email && a.private_key) return a;
  } catch {}
  warnUnusable('FCM_SERVICE_ACCOUNT');
  return null;
}

export const fcmEnabled = (env: Env) => account(env) !== null;

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

const TOKEN_LIFE_S = 3600;

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

export interface Delivered {
  sent: number;
  failed: number;
  started?: string[];
  startFailed?: number;
}

export async function nudgeUser(env: Env, userId: string, nudge: Nudge, nowMs: number, exceptTokenHash?: string): Promise<Delivered> {
  const quiet = nudge.phase === 'idle' || nudge.remind === false;
  const data = { kind: 'card', phase: nudge.phase };
  const answer = nudge.answer;
  const expiresS = Math.floor(nowMs / 1000) + 600;
  const { worded, prepare } = wordings(answer ?? null, nudge);
  const ending = Boolean(nudge.tripOver) || nudge.phase === 'arrived';
  return deliver(
    env,
    userId,
    {
      web: quiet ? null : { kind: 'card', phase: nudge.phase, urgent: nudge.urgent },
      fcm: data,
      prepare,
      ios: (w, hasLive, alerts) => {
        if (quiet || !alerts || (hasLive && !nudge.urgent)) return backgroundPush(data, expiresS);
        const a = worded(w);
        const words = a ? cardWords(a.card) : withLang(w.lang, () => phaseWords(nudge.phase));
        const loudness: Loudness = nudge.urgent && !answer?.card.gone ? 'time-sensitive' : 'passive';
        return alertPush({ ...words, data, loudness, collapse: 'card', expiresS });
      },
      live: answer
        ? (w) => {
            const a = worded(w) ?? (ending ? answer : null);
            return a ? { state: liveActivityState(a), event: ending ? 'end' : 'update', urgent: Boolean(nudge.phaseChanged) } : null;
          }
        : null,
      start: answer && nudge.startLive && !ending ? startFrom(worded, nowMs) : null,
      startedFor: nudge.startedFor,
      urgent: nudge.urgent,
      collapse: 'card',
      ttlS: 600,
    },
    nowMs,
    exceptTokenHash,
  );
}

function startFrom(worded: Wordings['worded'], nowMs: number): NonNullable<Delivery['start']> {
  return (w, alerts) => {
    const a = worded(w);
    return a ? liveStartPush(liveActivityState(a), liveActivityTrip(a), cardWords(a.card), alerts, Math.floor(nowMs / 1000)) : null;
  };
}

export async function retryLiveStart(
  env: Env,
  userId: string,
  nudge: Pick<Nudge, 'lang' | 'answerIn' | 'clockChosen'> & { answer: MeAnswer & { card: Card }; startedFor: ReadonlySet<string> },
  nowMs: number,
): Promise<Delivered> {
  const { worded, prepare } = wordings(nudge.answer, nudge);
  return deliver(
    env,
    userId,
    {
      web: null,
      fcm: {},
      prepare,
      start: startFrom(worded, nowMs),
      startedFor: nudge.startedFor,
      onlyStart: true,
      urgent: true,
      collapse: 'card',
      ttlS: 600,
    },
    nowMs,
  );
}

export type AnswerIn = (lang: Lang, h12: boolean) => Promise<(MeAnswer & { card: Card }) | null>;

export interface Wording {
  lang: Lang;
  h12: boolean | null;
}

interface Wordings {
  worded: (w: Wording) => (MeAnswer & { card: Card }) | null | undefined;
  prepare: Delivery['prepare'];
}

function wordings(
  answer: (MeAnswer & { card: Card }) | null,
  { lang, answerIn, clockChosen }: Pick<Nudge, 'lang' | 'answerIn' | 'clockChosen'>,
): Wordings {
  const own = answer?.card.h12 ?? false;
  const clock = (h12: boolean | null) => (clockChosen || h12 === null ? own : h12);
  const key = (l: Lang, h12: boolean) => `${l}:${h12 ? 12 : 24}`;
  const done = new Map<string, (MeAnswer & { card: Card }) | null>([[key(lang ?? currentLang(), own), answer]]);
  const prepare =
    answer && answerIn
      ? async (wants: Wording[]) => {
          for (const w of wants) {
            const h12 = clock(w.h12);
            const k = key(w.lang, h12);
            if (done.has(k)) continue;
            done.set(
              k,
              await answerIn(w.lang, h12).catch((err: unknown) => {
                console.error('push: card not worded', err instanceof Error ? err.message : typeof err);
                return null;
              }),
            );
          }
        }
      : undefined;
  return { worded: (w) => done.get(key(w.lang, clock(w.h12))), prepare };
}

export type LiveUpdate =
  | (Pick<Nudge, 'lang' | 'answerIn' | 'clockChosen'> & { answer: MeAnswer & { card: Card } })
  | { state: LiveActivityState };

export async function updateLive(env: Env, userId: string, update: LiveUpdate, event: 'update' | 'end', nowMs: number): Promise<Delivered> {
  let live: (w: Wording) => LiveSend | null;
  let prepare: Delivery['prepare'];
  if ('state' in update) {
    const state = update.state;
    live = () => ({ state, event, urgent: false });
  } else {
    const { worded, prepare: ready } = wordings(update.answer, update);
    prepare = ready;
    live = (w) => {
      const a = worded(w) ?? (event === 'end' ? update.answer : null);
      return a ? { state: liveActivityState(a), event, urgent: false } : null;
    };
  }
  return deliver(env, userId, { web: null, fcm: {}, prepare, live, onlyLive: true, urgent: false, collapse: 'card', ttlS: 600 }, nowMs);
}

function cardWords(card: Card): { title: string; body: string } {
  return { title: card.phaseText ?? card.heading ?? card.title, body: card.line };
}

function phaseWords(phase: string): { title: string; body: string } {
  const t = m();
  const title =
    { due: t.phaseDue, heading: t.phaseHeading, waiting: t.phaseWaiting, riding: t.phaseRiding, missed: t.phaseMissed }[phase] ??
    t.pushTitle;
  return { title, body: t.pushOpen };
}

export interface Notice {
  title: string;
  body: string;
  zhTitle: string;
  zhBody: string;
}

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
      ios: ({ lang: l }) =>
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

export const NOTICE_FETCH_FROM = [2, 5, 0] as const;

export function fetchesNotice(client: string | null): boolean {
  const v = /^android\/(\d+)\.(\d+)\.(\d+)/.exec(client ?? '');
  if (!v) return false;
  const [a, b, c] = v.slice(1).map(Number);
  const [x, y, z] = NOTICE_FETCH_FROM;
  return a !== x ? a > x : b !== y ? b > y : c >= z;
}

interface Delivery {
  web: Record<string, unknown> | null;
  fcm: Record<string, string>;
  fcmBare?: Record<string, string>;
  prepare?: (wants: Wording[]) => Promise<void>;
  ios?: (w: Wording, hasLive: boolean, alerts: boolean) => ApnsPush | null;
  live?: ((w: Wording) => LiveSend | null) | null;
  start?: ((w: Wording, alerts: boolean) => ApnsPush | null) | null;
  startedFor?: ReadonlySet<string>;
  onlyLive?: boolean;
  onlyStart?: boolean;
  urgent: boolean;
  collapse: string;
  ttlS: number;
}

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
          ? 'SELECT token_hash, push_token, client, live_token, start_token, push_lang, push_alerts, push_h12 FROM sessions WHERE user_id = ? AND live_token IS NOT NULL AND token_hash != ?'
          : 'SELECT token_hash, push_token, client, live_token, start_token, push_lang, push_alerts, push_h12 FROM sessions WHERE user_id = ? AND (push_token IS NOT NULL OR live_token IS NOT NULL) AND token_hash != ?',
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
  const forgetLive = (tokenHash: string, liveToken: string) =>
    db.prepare('UPDATE sessions SET live_token = NULL WHERE token_hash = ? AND live_token = ?').bind(tokenHash, liveToken).run();
  const forgetStart = (tokenHash: string) =>
    db.prepare('UPDATE sessions SET start_token = NULL WHERE token_hash = ?').bind(tokenHash).run();
  const count = async (res: PushResult, gone: () => Promise<unknown>) => {
    if (res === 'sent') out.sent++;
    else if (res === 'failed') out.failed++;
    else if (res === 'gone') await gone();
  };
  const fcm: Fcm = { bearer: null, down: false };
  const apns = newApnsRun();
  const wordingOf = (r: Row): Wording => ({ lang: r.push_lang === 'zh' ? 'zh' : 'en', h12: r.push_h12 === null ? null : r.push_h12 !== 0 });
  const iphones = apnsEnabled(env) ? results.filter((r) => looksApns(r.push_token ?? '') || r.live_token) : [];
  if (msg.prepare && iphones.length) await msg.prepare(iphones.map(wordingOf));
  for (const r of results) {
    try {
      const token = r.push_token ?? '';
      const iphone = looksApns(token);
      const live = r.live_token && !msg.onlyStart ? (msg.live?.(wordingOf(r)) ?? null) : null;
      if (!msg.onlyLive && !msg.onlyStart && token) {
        const res = token.startsWith(WEB_PREFIX)
          ? await toBrowser(env, token, msg, nowMs)
          : iphone
            ? await toIphone(env, apns, token, wordingOf(r), live !== null, r.push_alerts !== 0, msg, nowMs)
            : a
              ? await toAndroid(env, a, fcm, { push_token: token, client: r.client }, msg, nowMs)
              : 'skip';
        await count(res, () => forget(r.token_hash));
      }
      if (live && r.live_token) {
        const res = await toLiveActivity(env, apns, r.live_token, live, nowMs);
        await count(res, () => forgetLive(r.token_hash, r.live_token!));
        if (res === 'sent' && live.event === 'end') await forgetLive(r.token_hash, r.live_token!);
      }
      const start =
        !msg.onlyLive && !r.live_token && r.start_token && iphone && !msg.startedFor?.has(r.token_hash)
          ? (msg.start?.(wordingOf(r), r.push_alerts !== 0) ?? null)
          : null;
      if (start && r.start_token) {
        const res = await toStartToken(env, apns, r.start_token, start, nowMs);
        if (res === 'sent') (out.started ??= []).push(r.token_hash);
        else if (res === 'failed') out.startFailed = (out.startFailed ?? 0) + 1;
        await count(res, () => forgetStart(r.token_hash));
      }
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
  start_token: string | null;
  push_lang: string | null;
  push_alerts: number | null;
  push_h12: number | null;
}

type PushResult = 'sent' | 'failed' | 'gone' | 'skip';

interface LiveSend {
  state: LiveActivityState;
  event: 'update' | 'end';
  urgent: boolean;
}

async function toBrowser(env: Env, pushToken: string, msg: Delivery, nowMs: number): Promise<PushResult> {
  if (!msg.web || !webPushEnabled(env)) return 'skip';
  let sub: WebSubscription | null = null;
  try {
    sub = parseSubscription(JSON.parse(pushToken.slice(WEB_PREFIX.length)));
  } catch {}
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
  w: Wording,
  hasLive: boolean,
  alerts: boolean,
  msg: Delivery,
  nowMs: number,
): Promise<PushResult> {
  const push = msg.ios?.(w, hasLive, alerts);
  if (!push) return 'skip';
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
  if (fcm.down) return 'failed';
  const send = (token: string) =>
    fetch(`https://fcm.googleapis.com/v1/projects/${a.project_id}/messages:send`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        message: {
          token: to.push_token,
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
  console.error('fcm send', res.status, why.code);
  return 'failed';
}

type FcmErrorBody = {
  error?: { status?: string; message?: string; details?: { errorCode?: string; fieldViolations?: { field?: string }[] }[] };
};

export async function fcmError(res: Response): Promise<{ tokenGone: boolean; code: string }> {
  const body = (await res.json().catch(() => null)) as FcmErrorBody | null;
  const details = Array.isArray(body?.error?.details) ? body.error.details : [];
  const code = details.find((d) => typeof d?.errorCode === 'string')?.errorCode ?? body?.error?.status ?? '';
  const namesToken = details.some((d) => Array.isArray(d?.fieldViolations) && d.fieldViolations.some((v) => v?.field === 'message.token'));
  const badToken = namesToken || /registration token/i.test(String(body?.error?.message ?? ''));
  return { tokenGone: res.status === 404 || code === 'UNREGISTERED' || (res.status === 400 && badToken), code };
}

export interface Audience {
  devices: number;
  lives: number;
  liveSessions: string[];
  iphoneLang: Lang | null;
  iphoneH12: boolean;
}

export async function pushAudience(env: Env, userId: string): Promise<Audience> {
  const none: Audience = { devices: 0, lives: 0, liveSessions: [], iphoneLang: null, iphoneH12: false };
  if (!pushEnabled(env) || !env.DB) return none;
  const r = await env.DB.prepare(
    `SELECT COUNT(*) AS n,
       SUM(push_token IS NOT NULL AND push_token NOT LIKE 'apns:%') AS others,
       SUM(live_token IS NOT NULL) AS lives,
       (SELECT push_lang FROM sessions WHERE user_id = ? AND push_token LIKE 'apns:%' ORDER BY last_seen DESC LIMIT 1) AS lang,
       SUM(push_token LIKE 'apns:%') AS iphones,
       MAX(CASE WHEN push_token LIKE 'apns:%' THEN push_h12 END) AS h12,
       GROUP_CONCAT(CASE WHEN live_token IS NOT NULL THEN token_hash END) AS liveSessions
     FROM sessions WHERE user_id = ? AND (push_token IS NOT NULL OR live_token IS NOT NULL)`,
  )
    .bind(userId, userId)
    .first<{
      n: number;
      others: number | null;
      lives: number | null;
      lang: string | null;
      iphones: number | null;
      h12: number | null;
      liveSessions: string | null;
    }>();
  if (!r) return none;
  if (!apnsEnabled(env)) return { ...none, devices: r.others ?? 0 };
  return {
    devices: r.n,
    lives: r.lives ?? 0,
    liveSessions: r.liveSessions ? r.liveSessions.split(',') : [],
    iphoneLang: r.iphones ? (r.lang === 'zh' ? 'zh' : 'en') : null,
    iphoneH12: r.h12 === 1,
  };
}

export async function pushDevices(env: Env, userId: string): Promise<number> {
  return (await pushAudience(env, userId)).devices;
}

export async function setPushToken(
  db: D1Database,
  tokenHash: string,
  pushToken: string | null,
  lang: Lang | null = null,
  alerts: boolean | null = null,
  live: boolean | null = null,
  activity: boolean | null = null,
  h12: boolean | null = null,
): Promise<void> {
  const stmts = [];
  if (pushToken)
    stmts.push(
      db
        .prepare(
          'UPDATE sessions SET push_token = NULL, push_lang = NULL, push_alerts = NULL, push_h12 = NULL, live_token = NULL, start_token = NULL WHERE push_token = ? AND token_hash != ?',
        )
        .bind(pushToken, tokenHash),
    );
  stmts.push(
    pushToken
      ? db
          .prepare('UPDATE sessions SET push_token = ?, push_lang = ?, push_alerts = ?, push_h12 = ? WHERE token_hash = ?')
          .bind(pushToken, lang, flag(alerts), flag(h12), tokenHash)
      : db
          .prepare(
            'UPDATE sessions SET push_token = NULL, push_lang = NULL, push_alerts = NULL, push_h12 = NULL, live_token = NULL, start_token = NULL WHERE token_hash = ?',
          )
          .bind(tokenHash),
  );
  if (pushToken && live === false) stmts.push(db.prepare('UPDATE sessions SET start_token = NULL WHERE token_hash = ?').bind(tokenHash));
  if (pushToken && activity === false) stmts.push(db.prepare('UPDATE sessions SET live_token = NULL WHERE token_hash = ?').bind(tokenHash));
  await db.batch(stmts);
}

const flag = (b: boolean | null) => (b === null ? null : b ? 1 : 0);

export async function setLiveToken(db: D1Database, tokenHash: string, liveToken: string): Promise<void> {
  await db.batch([
    db.prepare('UPDATE sessions SET live_token = NULL WHERE live_token = ?').bind(liveToken),
    db.prepare('UPDATE sessions SET live_token = ? WHERE token_hash = ?').bind(liveToken, tokenHash),
  ]);
}

export async function setStartToken(db: D1Database, tokenHash: string, startToken: string): Promise<void> {
  await db.batch([
    db.prepare('UPDATE sessions SET start_token = NULL WHERE start_token = ?').bind(startToken),
    db.prepare('UPDATE sessions SET start_token = ? WHERE token_hash = ?').bind(startToken, tokenHash),
  ]);
}

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
