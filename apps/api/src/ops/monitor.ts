import { KEEP_DAYS } from '../accounts/outcomes.ts';
import { FEEDBACK_KEEP_DAYS } from './feedback.ts';
import type { Env } from '../types.ts';
import { sgt } from '../config.ts';
import { failureReason, fetchArrivals, renewToken } from '../feeds/fms.ts';
import { fetchPublicArrivals, ltaConfigured } from '../feeds/lta.ts';
import { GRAPH_PUBLIC } from '../answer/graph.ts';
import { KV_APP_VERSION, UpstreamRejected, appVersion } from '../feeds/auth.ts';
import { autoUpdateVersion, type AutoResult } from '../feeds/appversion.ts';
import { calendarThrough, semesterSoon, termFrom, termName } from '../timetable/calendar.ts';
import { loadCalendar, refreshCalendar } from '../timetable/calendarsync.ts';
import { pruneCrowdSeen } from '../answer/crowd.ts';
import { ACCOUNT_TTL, mail } from '../accounts/accounts.ts';
import { type Notice, pushEnabled, remindUser } from '../push/push.ts';
import { m, withLang } from '../i18n.ts';
import { clearTrip, sgtDate, watchTrip } from '../answer/trip.ts';
import { isBeta, linkOrigin } from '../origin.ts';
import { ensureRecorder } from '../map/timelapse.ts';
import { logCronError } from './analytics.ts';
import { recordActive } from './usage.ts';
import { recordSettings } from './settings.ts';
import { recordEta } from './eta.ts';
import { shadowEta } from './etashadow.ts';
import { type Feed, lastBreakerOpen, breakerError } from '../feeds/feedwatch.ts';

export interface UpstreamState {
  up: boolean;
  since: number;
  reason: string | null;
  detail?: string | null;
  auto?: string | null;
  checkedAt: number;
  failures?: number;
  failSince?: number | null;
  oks?: number;
  okSince?: number | null;
  pending?: 'down' | 'up' | null;
}

const KEY = 'monitor:upstream';
const ALERTED_KEY = 'monitor:alerted';
const INCIDENTS_KEY = 'monitor:incidents';
export const INCIDENTS_KEPT = 20;

export interface Incident {
  start: number;
  end: number | null;
  cause: 'version' | 'feed';
}
const CALENDAR_KEY = 'monitor:calendar-alert';
export const KV_NAMESPACE_IDS = { stable: '1f88f570f6e04f78aa2888ee7aa78e6a', beta: '5bd33589cdfc43c0bb324d158edd46ba' } as const;
export const kvNamespaceId = (env: Env): string => (isBeta(env) ? KV_NAMESPACE_IDS.beta : KV_NAMESPACE_IDS.stable);
export const CHECK_EVERY_MS = 15 * 60_000;
export const UNIVUS_PLAY_URL = 'https://play.google.com/store/apps/details?id=sg.edu.nus.univus';
export const PROBE_STOP = 'COM3';
export const DEVICE_IDLE_MS = 90 * 86_400_000;
export const FAILS_TO_ALERT = 2;
export const OKS_TO_RECOVER = 2;
export const OUTAGE_HOURS = { start: 7 * 60, end: 23 * 60 + 30 };
export const inOutageHours = (nowMs: number): boolean => {
  const { minutes } = sgt(nowMs);
  return minutes >= OUTAGE_HOURS.start && minutes < OUTAGE_HOURS.end;
};

export const answering = (u: UpstreamState): boolean => u.up || (u.oks ?? 0) > 0;

export const answeringSince = (u: UpstreamState): number => (!u.up && answering(u) && u.okSince ? u.okSince : u.since);

export const causeOf = (reason: string | null | undefined): Incident['cause'] => (/10009/.test(reason ?? '') ? 'version' : 'feed');

export function feedStatus(u: UpstreamState): { feed: 'up' | 'down' | 'maintenance'; since: number; cause: Incident['cause'] | null } {
  if (!answering(u)) return { feed: 'down', since: answeringSince(u), cause: causeOf(u.reason) };
  if ((u.failures ?? 0) >= FAILS_TO_ALERT) return { feed: 'maintenance', since: u.failSince ?? u.checkedAt, cause: null };
  return { feed: 'up', since: answeringSince(u), cause: null };
}
export const MAIL_TIMEOUT_MS = 15_000;
export const HEARTBEAT_TIMEOUT_MS = 10_000;
export const CALENDAR_WARN_DAYS = 45;

async function getKvJson(env: Env, key: string): Promise<unknown> {
  const raw = await env.KV.get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

const readKvJson = (env: Env, key: string): Promise<unknown> => getKvJson(env, key).catch(() => null);

const asIncidents = (list: unknown): Incident[] => (Array.isArray(list) ? (list as Incident[]) : []);

export async function readIncidents(env: Env): Promise<Incident[]> {
  return asIncidents(await readKvJson(env, INCIDENTS_KEY));
}

async function recordIncident(env: Env, state: UpstreamState, nowMs: number): Promise<void> {
  const list = asIncidents(await getKvJson(env, INCIDENTS_KEY));
  const open = list[0] && list[0].end === null ? list[0] : null;
  if (state.up) {
    if (!open) return;
    open.end = Math.max(open.start, Math.min(state.since, nowMs));
  } else {
    if (open && open.start === state.since) return;
    if (open) open.end = Math.max(open.start, state.since);
    list.unshift({ start: state.since, end: null, cause: causeOf(state.reason) });
  }
  await env.KV.put(INCIDENTS_KEY, JSON.stringify(list.slice(0, INCIDENTS_KEPT)));
}

const DOWN_MEMO_MS = 60_000;
const downMemo = new WeakMap<object, { at: number; since: number | null }>();

export async function feedDownSince(env: Env, nowMs: number): Promise<number | null> {
  if (!env.KV) return null;
  const kept = downMemo.get(env.KV);
  if (kept && nowMs - kept.at < DOWN_MEMO_MS && nowMs >= kept.at) return kept.since;
  const u = await readUpstream(env);
  const since = u && !answering(u) ? u.since : null;
  downMemo.set(env.KV, { at: nowMs, since });
  return since;
}

export interface StatusRecords {
  upstream: UpstreamState | null;
  incidents: Incident[];
  publicFeed: PublicFeedState | null;
}

const statusMemo = new WeakMap<object, { at: number; records: StatusRecords }>();

export async function statusRecords(env: Env, nowMs: number): Promise<StatusRecords> {
  const kept = statusMemo.get(env.KV);
  if (kept && nowMs - kept.at < DOWN_MEMO_MS && nowMs >= kept.at) return kept.records;
  const [upstream, incidents, publicFeed] = await Promise.all([readUpstream(env), readIncidents(env), readPublicFeed(env)]);
  const records = { upstream, incidents, publicFeed };
  if (env.KV) statusMemo.set(env.KV, { at: nowMs, records });
  return records;
}

export async function readUpstream(env: Env): Promise<UpstreamState | null> {
  return (await readKvJson(env, KEY)) as UpstreamState | null;
}

export async function checkUpstream(
  env: Env,
  nowMs: number,
  probe: () => Promise<unknown> = () => fetchArrivals(env, PROBE_STOP, nowMs),
  fixVersion: (detail: string | null) => Promise<AutoResult> = (detail) => autoUpdateVersion(env, nowMs, detail, PROBE_STOP),
): Promise<{ state: UpstreamState; changed: boolean }> {
  const prev = (await getKvJson(env, KEY)) as UpstreamState | null;
  const delivered = prev?.pending ? await env.KV.get(ALERTED_KEY).catch(() => null) : null;
  let ok = true;
  let reason: string | null = null;
  let detail: string | null = null;
  let auto: string | null = null;
  let refusedVersion = false;
  const run = async () => {
    try {
      await probe();
      ok = true;
      reason = detail = null;
    } catch (err) {
      ok = false;
      reason = String((err as Error)?.message ?? err).slice(0, 300);
      refusedVersion = err instanceof UpstreamRejected && err.code === '10009';
      if (err instanceof UpstreamRejected && err.detail) {
        detail = err.detail;
        console.log('upstream rejected', err.code, detail);
      }
    }
  };
  await run();

  if (refusedVersion) {
    let result: AutoResult;
    try {
      result = await fixVersion(detail);
    } catch (err) {
      result = { status: 'failed', note: `the automatic update failed: ${(err as Error)?.message ?? err}` };
    }
    if (result.status === 'switched') {
      await switchedAlert(env, result).catch((e) => console.error('alert failed', (e as Error)?.name ?? 'error'));
      await run();
      if (!ok) auto = `switched to ${result.to} automatically, but the feed still fails`;
    } else {
      auto = result.note;
    }
  }

  const failures = ok ? 0 : (prev?.failures ?? 0) + 1;
  const failSince = ok ? null : prev?.failures && prev.failSince ? prev.failSince : nowMs;
  const oks = ok ? (prev?.oks ?? 0) + 1 : 0;
  const okSince = ok ? (prev?.oks && prev.okSince ? prev.okSince : nowMs) : null;
  const was = prev?.up ?? true;
  const counts = causeOf(reason) === 'version' || inOutageHours(nowMs);
  const up = was ? failures < FAILS_TO_ALERT || !counts : oks >= OKS_TO_RECOVER;
  const changed = !prev || prev.up !== up;
  let pending = prev?.pending ?? null;
  if (pending && delivered === `${prev!.since} ${pending}`) pending = null;
  if (changed && (prev || !up)) pending = up ? 'up' : 'down';
  const since = !changed ? prev!.since : up && okSince ? okSince : nowMs;
  const state: UpstreamState = { up, since, reason, detail, auto, checkedAt: nowMs, failures, failSince, oks, okSince, pending };

  await env.KV.put(KEY, JSON.stringify(state));
  if (pending) {
    try {
      await alert(env, state, pending);
      state.pending = null;
    } catch (e) {
      console.error('alert failed', (e as Error)?.name ?? 'error');
    }
    if (!state.pending) {
      await env.KV.put(ALERTED_KEY, `${state.since} ${pending}`, { expirationTtl: 30 * 86_400 }).catch((e) =>
        console.error('alert not marked sent', (e as Error)?.name ?? 'error'),
      );
    }
  }
  if (prev || !up) {
    await recordIncident(env, state, nowMs).catch((e) => console.error('incident not recorded', (e as Error)?.name ?? 'error'));
  }
  return { state, changed };
}

export function adviceFor(reason: string | null, kv: string = KV_NAMESPACE_IDS.stable): string {
  if (!reason) return '';
  if (/10009/.test(reason)) {
    return [
      'uNivUS has a new release and the old version string is refused.',
      `Find the new versionName and versionCode (the release is at ${UNIVUS_PLAY_URL}), then from apps/api:`,
      `  pnpm exec cf kv keys put ${KV_APP_VERSION} --namespace-id ${kv} --body univus_android_<versionName>_<versionCode>`,
      'It takes effect within a minute, with no deploy. The NEXTBUS_APP_VERSION secret is only the fallback while that key is unset.',
    ].join('\n');
  }
  if (/10008/.test(reason)) return 'The device id no longer matches the access token. Clear auth:session in KV and let it re-mint.';
  if (/10000|Invalid API KEY/i.test(reason)) return 'The app API keys were rejected; they may have been rotated in a new uNivUS build.';
  return 'Check `pnpm exec wrangler tail` (from apps/api) and /api/health?probe=1.';
}

async function mailOperator(env: Env, subject: string, text: string): Promise<boolean> {
  if (!env.EMAIL || !env.EMAIL_FROM || !env.ALERT_EMAIL || isBeta(env)) return false;
  const html = await (await mail()).operatorHtml({ origin: linkOrigin(env), beta: false, subject, text });
  const send = env.EMAIL.send({ from: { email: env.EMAIL_FROM, name: 'terminus' }, to: env.ALERT_EMAIL, subject, text, html });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('email timed out')), MAIL_TIMEOUT_MS);
  });
  try {
    await Promise.race([send, late]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  return true;
}

async function alert(env: Env, s: UpstreamState, kind: 'up' | 'down'): Promise<void> {
  const when = new Date(s.since).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  const subject = kind === 'up' ? 'terminus: NUS bus feed recovered' : 'terminus: NUS bus feed is down';
  const text =
    kind === 'up'
      ? `The NUS bus feed is answering again as of ${when}. Live times are back.`
      : `The NUS bus feed stopped answering at ${when}.\n\nError: ${s.reason}\n\n${s.auto ? `Tried automatically: ${s.auto}.\n\n` : ''}${adviceFor(s.reason, kvNamespaceId(env))}\n\nUntil then every answer says "live times unavailable".${s.detail ? `\n\nNUS's full response:\n${s.detail}` : ''}`;
  await tellOperator(env, subject, text);
}

async function switchedAlert(env: Env, r: Extract<AutoResult, { status: 'switched' }>): Promise<void> {
  const name = /univus_android_(.+)_\d+$/.exec(r.to)?.[1] ?? r.to;
  await tellOperator(
    env,
    `terminus: switched to uNivUS ${name} automatically`,
    [
      `NUS started refusing ${r.from || 'the old version string'}, so a new uNivUS is out. terminus found ${r.to}, NUS accepted it, and it is now in ${KV_APP_VERSION}.`,
      'Nothing to do. To undo it, from apps/api:',
      `  pnpm exec cf kv keys delete ${KV_APP_VERSION} --namespace-id ${kvNamespaceId(env)}`,
    ].join('\n\n'),
  );
}

async function tellOperator(env: Env, subject: string, text: string): Promise<void> {
  if (isBeta(env)) {
    console.error(`beta: ${subject}\n${text}`);
    return;
  }
  await mailOperator(env, subject, text);
}

export async function housekeeping(db: D1Database, nowMs: number, daily = true, env?: Env): Promise<void> {
  const stmts = [
    db.prepare('DELETE FROM magic_links WHERE expires < ?').bind(nowMs),
    db.prepare('DELETE FROM login_requests WHERE expires < ?').bind(nowMs),
    db.prepare('DELETE FROM pair_codes WHERE expires < ?').bind(nowMs),
  ];
  let anonAt = -1;
  if (daily) {
    anonAt = stmts.length;
    stmts.push(
      db
        .prepare('DELETE FROM users INDEXED BY users_anon_idle WHERE email IS NULL AND last_seen < ? RETURNING id')
        .bind(nowMs - ACCOUNT_TTL.anonIdleMs),
      db.prepare("DELETE FROM sessions WHERE kind = 'web' AND expires < ?").bind(nowMs),
      db.prepare("DELETE FROM sessions WHERE kind = 'device' AND last_seen < ?").bind(nowMs - DEVICE_IDLE_MS),
      db.prepare('DELETE FROM trip_outcomes WHERE at < ?').bind(nowMs - KEEP_DAYS * 86_400_000),
      db.prepare('DELETE FROM feedback WHERE created < ?').bind(nowMs - FEEDBACK_KEEP_DAYS * 86_400_000),
    );
  }
  const out = await db.batch(stmts);
  if (!daily || !env) return;
  const ids = ((out[anonAt]?.results ?? []) as Array<{ id: string }>).map((r) => r.id);
  for (let i = 0; i < ids.length; i += ARM_AT_ONCE) await Promise.all(ids.slice(i, i + ARM_AT_ONCE).map((id) => clearTrip(env, id)));
}

const SWEPT_KEY = 'housekeeping:day';

async function sweepDue(env: Env, nowMs: number): Promise<boolean> {
  return (await env.KV.get(SWEPT_KEY).catch(() => null)) !== sgtDate(nowMs);
}

export async function checkCalendar(env: Env, nowMs: number, through = calendarThrough()): Promise<boolean> {
  const daysLeft = Math.floor((Date.parse(`${through}T00:00:00Z`) - nowMs) / 86_400_000);
  if (daysLeft > CALENDAR_WARN_DAYS) return false;
  const last = Number(await env.KV.get(CALENDAR_KEY).catch(() => null)) || 0;
  if (nowMs - last < 7 * 86_400_000) return false;
  const sent = await mailOperator(
    env,
    'terminus: academic calendar data runs out soon',
    `The academic calendar covers dates up to ${through} (${daysLeft} days from now). After that, imported classes are shown every week, including recess and exams.\n\nThe Worker fetches the calendar itself every week, from NUSMods and data.gov.sg, so either NUSMods doesn't list the next academic year yet, or the fetch is failing (look for "cron calendar" in the Worker's logs).\n\nWhen NUSMods has the year, nothing else is needed. To bundle it as well:\n  python3 apps/api/scripts/data/fetch_calendar.py && pnpm run deploy`,
  );
  if (!sent) return false;
  await env.KV.put(CALENDAR_KEY, String(nowMs));
  return true;
}

export const ARM_FROM_HOUR = 6;
const ARMED_KEY = 'trips:armed';
const ARM_RETRY_KEY = 'trips:retry';
const ARM_BATCH = 400;
const ARM_AT_ONCE = 20;

export async function armTrips(env: Env, nowMs: number, batch = ARM_BATCH): Promise<number> {
  if (!env.DB || !env.TRIPS || !pushEnabled(env)) return 0;
  batch = Math.max(1, Math.floor(batch));
  const today = sgtDate(nowMs);
  const hour = new Date(nowMs + 8 * 3_600_000).getUTCHours();
  if (hour < ARM_FROM_HOUR) return 0;
  const mark = (await env.KV.get(ARMED_KEY)) ?? '';
  const kept = (await env.KV.get(ARM_RETRY_KEY)) ?? '';
  const left = kept.startsWith(`${today} `) ? kept.slice(today.length + 1).split(' ') : [];
  const retry = left.slice(0, batch);
  if (mark === today && !retry.length) return 0;
  const after = mark.startsWith(`${today} `) ? mark.slice(today.length + 1) : '';
  const { results } =
    mark === today
      ? { results: [] as { user_id: string }[] }
      : await env.DB.prepare('SELECT DISTINCT user_id FROM sessions WHERE push_token IS NOT NULL AND user_id > ? ORDER BY user_id LIMIT ?')
          .bind(after, batch)
          .all<{ user_id: string }>();
  const users = [...retry, ...results.map((r) => r.user_id)];
  const failed: string[] = [];
  for (let i = 0; i < users.length; i += ARM_AT_ONCE) {
    const some = users.slice(i, i + ARM_AT_ONCE);
    const took = await Promise.all(some.map((id) => watchTrip(env, id, nowMs, nowMs).catch(() => false)));
    some.forEach((id, j) => took[j] || failed.push(id));
  }
  if (mark !== today) {
    const done = results.length < batch;
    await env.KV.put(ARMED_KEY, done ? today : `${today} ${results[results.length - 1].user_id}`, { expirationTtl: 2 * 86_400 });
  }
  if (failed.length || kept) {
    const keep = [...new Set([...failed, ...left.slice(batch)])].slice(0, 2 * batch);
    if (keep.length) await env.KV.put(ARM_RETRY_KEY, `${today} ${keep.join(' ')}`, { expirationTtl: 86_400 });
    else await env.KV.delete(ARM_RETRY_KEY);
    if (failed.length) console.error('trips not armed', failed.length);
  }
  return users.length - failed.length;
}

const REMINDED_KEY = 'term:reminded';
const REMIND_RETRY_KEY = 'term:retry';
const REMIND_TRIES = 8;
type Due = [string, Notice, number];
const PROFILES_AT_ONCE = 50;
const REMIND_FROM_HOUR = 10;

export function termNotice(term: { acadYear: string; semester: number }, start: string): Notice {
  const d = new Date(`${start}T00:00:00Z`);
  const words = () => ({
    title: m().termSoonTitle(termName(term), m().shortDate(d.getUTCDay(), d.getUTCDate(), d.getUTCMonth())),
    body: m().termSoonBody,
  });
  const en = withLang('en', words);
  const zh = withLang('zh', words);
  return { title: en.title, body: en.body, zhTitle: zh.title, zhBody: zh.body };
}

export function termNoticeFor(
  p: { trips?: unknown; term?: { acadYear: string; semester: number } | null; lang?: unknown } | null,
  nowMs: number,
): Notice | null {
  const soon = semesterSoon(nowMs);
  if (!soon || !p || !Array.isArray(p.trips) || !p.trips.length || termFrom(p.term, soon.start)) return null;
  const both = termNotice(soon.term, soon.start);
  if (p.lang === 'en') return { ...both, zhTitle: both.title, zhBody: both.body };
  if (p.lang === 'zh') return { title: both.zhTitle, body: both.zhBody, zhTitle: both.zhTitle, zhBody: both.zhBody };
  return both;
}

export async function remindTerm(env: Env, nowMs: number, batch = ARM_BATCH): Promise<number> {
  if (!env.DB || !pushEnabled(env)) return 0;
  batch = Math.max(1, Math.floor(batch));
  const soon = semesterSoon(nowMs);
  if (!soon || new Date(nowMs + 8 * 3_600_000).getUTCHours() < REMIND_FROM_HOUR) return 0;
  const id = `${soon.term.acadYear} ${soon.term.semester}`;
  const [mark, markRun] = ((await env.KV.get(REMINDED_KEY)) ?? '').split('#');
  let retry: { term: string; run: number; users: [string, number][] } | null = null;
  try {
    retry = JSON.parse((await env.KV.get(REMIND_RETRY_KEY)) ?? 'null');
  } catch {
    retry = null;
  }
  if (retry?.term !== id || !Array.isArray(retry.users) || String(retry.run) !== markRun) retry = null;
  if (mark === id && !retry) return 0;
  const after = mark.startsWith(`${id} `) ? mark.slice(id.length + 1) : '';
  const { results } =
    mark === id
      ? { results: [] as { user_id: string; json: string }[] }
      : await env.DB.prepare(
          'SELECT DISTINCT s.user_id AS user_id, p.json AS json FROM sessions s JOIN profiles p ON p.user_id = s.user_id WHERE s.push_token IS NOT NULL AND s.user_id > ? ORDER BY s.user_id LIMIT ?',
        )
          .bind(after, batch)
          .all<{ user_id: string; json: string }>();
  const waiting = retry?.users ?? [];
  const triesOf = new Map(waiting.slice(0, batch));
  const ids = [...triesOf.keys()];
  const rows: { user_id: string; json: string; tries: number }[] = [];
  for (let i = 0; i < ids.length; i += PROFILES_AT_ONCE) {
    const some = ids.slice(i, i + PROFILES_AT_ONCE);
    const { results: got } = await env.DB.prepare(`SELECT user_id, json FROM profiles WHERE user_id IN (${some.map(() => '?').join(', ')})`)
      .bind(...some)
      .all<{ user_id: string; json: string }>();
    for (const r of got) rows.push({ ...r, tries: triesOf.get(r.user_id) ?? 0 });
  }
  for (const r of results) rows.push({ ...r, tries: 0 });
  let sent = 0;
  const due: Due[] = [];
  for (const r of rows) {
    let p: Parameters<typeof termNoticeFor>[0] = null;
    try {
      p = JSON.parse(r.json);
    } catch {
      continue;
    }
    const notice = termNoticeFor(p, nowMs);
    if (notice) due.push([r.user_id, notice, r.tries]);
  }
  const done = mark === id || results.length < batch;
  await env.KV.put(REMINDED_KEY, `${done ? id : `${id} ${results[results.length - 1].user_id}`}#${nowMs}`, { expirationTtl: 30 * 86_400 });
  const failed: Due[] = [];
  for (let i = 0; i < due.length; i += ARM_AT_ONCE) {
    const some = due.slice(i, i + ARM_AT_ONCE);
    const n = await Promise.all(
      some.map(([userId, notice]) => remindUser(env, userId, notice, nowMs).catch(() => ({ sent: 0, failed: 1 }))),
    );
    some.forEach(([userId, notice, tries], j) => {
      sent += n[j].sent;
      if (n[j].sent === 0 && n[j].failed > 0) failed.push([userId, notice, tries + 1]);
    });
  }
  const again = failed.filter(([, , tries]) => tries < REMIND_TRIES).map(([userId, , n]): [string, number] => [userId, n]);
  const users = [...again, ...waiting.slice(batch)].slice(0, 2 * batch);
  if (failed.length) console.error('term reminders not sent', failed.length);
  if (users.length) {
    await env.KV.put(REMIND_RETRY_KEY, JSON.stringify({ term: id, run: nowMs, users }), { expirationTtl: 30 * 86_400 });
  } else if (retry) {
    await env.KV.delete(REMIND_RETRY_KEY).catch((e) => console.error('term retry not cleared', (e as Error)?.name ?? 'error'));
  }
  return sent;
}

export interface PublicFeedState {
  up: boolean;
  since: number;
  reason: string | null;
  checkedAt: number;
}

const PUBLIC_KEY = 'monitor:public';
export const PUBLIC_PROBE: [string, string] = ['CLB', '16181'];

export async function readPublicFeed(env: Env): Promise<PublicFeedState | null> {
  return (await readKvJson(env, PUBLIC_KEY)) as PublicFeedState | null;
}

export async function checkPublicFeed(
  env: Env,
  nowMs: number,
  probe: () => Promise<unknown> = () => fetchPublicArrivals(env, GRAPH_PUBLIC, PUBLIC_PROBE[0], PUBLIC_PROBE[1], nowMs),
): Promise<PublicFeedState | null> {
  if (!ltaConfigured(env)) return null;
  let up = true;
  let reason: string | null = null;
  try {
    await probe();
  } catch (err) {
    up = false;
    reason = String((err as Error)?.message ?? err).slice(0, 300);
  }
  const prev = await readPublicFeed(env);
  const state: PublicFeedState = { up, since: prev && prev.up === up ? prev.since : nowMs, reason, checkedAt: nowMs };
  await env.KV.put(PUBLIC_KEY, JSON.stringify(state));
  if (!up) console.log('public feed down', reason);
  return state;
}

export function sawTrip(env: Env, feed: Feed, nowMs: number): () => Promise<void> {
  return async () => {
    const seen = await lastBreakerOpen(env, feed);
    if (!seen || seen.at > nowMs || nowMs - seen.at >= CHECK_EVERY_MS) return;
    if (feed === 'nus' && seen.version !== undefined && seen.version !== (await appVersion(env, nowMs))) return;
    throw breakerError(seen);
  };
}

export async function runCron(env: Env, nowMs: number): Promise<void> {
  const step = async (name: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (err) {
      console.error('cron', name, err instanceof Error ? err.message : String(err));
      logCronError(env, name, failureReason(err));
    }
  };
  let feedUp = false;
  if (isBeta(env)) {
    await step('upstream', async () => {
      const { state } = await checkUpstream(env, nowMs, sawTrip(env, 'nus', nowMs));
      feedUp = state.up && !state.failures;
      if (!state.up) {
        console.error('beta: NUS feed down', state.reason);
        logCronError(env, 'feed down');
      }
    });
    await step('public feed', () => checkPublicFeed(env, nowMs, sawTrip(env, 'lta', nowMs)));
  } else {
    await step('upstream', async () => {
      const { state } = await checkUpstream(env, nowMs);
      feedUp = state.up && !state.failures;
    });
    await step('public feed', () => checkPublicFeed(env, nowMs));
  }
  if (feedUp) await step('token', () => renewToken(env, nowMs));
  await step('calendar', async () => {
    await loadCalendar(env, nowMs);
    try {
      await refreshCalendar(env, nowMs);
    } finally {
      await checkCalendar(env, nowMs);
    }
  });
  if (env.DB) {
    const daily = await sweepDue(env, nowMs);
    let swept = false;
    await step('housekeeping', async () => {
      await housekeeping(env.DB!, nowMs, daily, env);
      swept = daily;
    });
    if (daily) {
      await step('crowds', () => pruneCrowdSeen(env.DB!, nowMs));
      if (swept) await step('swept', () => env.KV.put(SWEPT_KEY, sgtDate(nowMs), { expirationTtl: 2 * 86_400 }));
    }
  }
  await step('trips', () => armTrips(env, nowMs));
  await step('timelapse', () => ensureRecorder(env, nowMs));
  await step('term', () => remindTerm(env, nowMs));
  await step('usage', () => recordActive(env, nowMs));
  await step('settings', () => recordSettings(env, nowMs));
  await step('eta', () => recordEta(env, nowMs));
  await step('etaModel', () => shadowEta(env, nowMs));
  await step('heartbeat', () => pingHeartbeat(env));
}

export async function pingHeartbeat(env: Env): Promise<void> {
  if (!env.HEARTBEAT_URL) return;
  const res = await fetch(env.HEARTBEAT_URL, { signal: AbortSignal.timeout(HEARTBEAT_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}
