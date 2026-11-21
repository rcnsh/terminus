import type { Env } from '../types.ts';
import { mailName } from '../site/site.ts';
import { isBeta, linkOrigin } from '../origin.ts';
import { m } from '../i18n.ts';
import { mail, sendMail } from '../accounts/accounts.ts';
import { venueBuilding, venueStops } from '../timetable/nusmods.ts';
import { GRAPH } from '../answer/graph.ts';

export const FEEDBACK_LIMITS = {
  note: 1000,
  contextBytes: 16_000,
  appVersion: 20,
  perDay: 10,
};

export const FEEDBACK_KEEP_DAYS = 365;

const PLATFORMS = ['android', 'mac', 'ios', 'web'] as const;
type Platform = (typeof PLATFORMS)[number];
const PLATFORM_NAMES: Record<Platform, string> = { android: 'Android', mac: 'Mac', ios: 'iPhone', web: 'Web' };

export const REASONS = {
  'never-came': 'The bus never came',
  'times-off': 'The times were off',
  'wrong-stop': 'Wrong stop',
  'walk-longer': 'The walk is longer',
  'wrong-class': 'Wrong class',
} as const;
export type Reason = keyof typeof REASONS;

export const BETTER_STOP = 'better-stop';
export const BETTER_STOP_TEXT = 'A better stop for a building';

export interface StopSuggestion {
  venue: string;
  stop: string;
  stopName: string;
  now: string[];
}

export interface FeedbackInput {
  kind: 'wrong' | 'other';
  reason: Reason | typeof BETTER_STOP | null;
  note: string;
  platform: Platform;
  appVersion: string | null;
  context: string | null;
  suggestion?: StopSuggestion;
}

function parseSuggestion(b: Record<string, unknown>): { ok: true; value: StopSuggestion } | { ok: false; error: string } {
  const venue = typeof b.venue === 'string' ? venueBuilding(b.venue) : null;
  if (!venue) return { ok: false, error: 'we don’t know that building; use the code on your timetable, like LT21' };
  const stop = typeof b.stop === 'string' ? GRAPH.stops.find((s) => s.code === b.stop) : undefined;
  if (!stop) return { ok: false, error: 'choose a stop' };
  const has = venueStops(venue);
  const now = has ? [has.to, ...has.also] : [];
  if (now[0] === stop.code || (now[0] && now[0] === stop.opposite))
    return { ok: false, error: 'that’s already the stop we use for that building' };
  return { ok: true, value: { venue, stop: stop.code, stopName: stop.name, now } };
}

export function parseFeedback(body: unknown): { ok: true; value: FeedbackInput } | { ok: false; error: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const kind = b.kind === 'other' || b.kind === 'stop' ? b.kind : b.kind === 'wrong' || b.kind === undefined ? 'wrong' : null;
  if (!kind) return { ok: false, error: "kind is 'wrong', 'other' or 'stop'" };
  const note = typeof b.note === 'string' ? b.note.trim() : '';
  if (note.length > FEEDBACK_LIMITS.note) return { ok: false, error: m().noteTooLong(FEEDBACK_LIMITS.note) };
  const platform = PLATFORMS.find((p) => p === b.platform);
  const appVersion = typeof b.appVersion === 'string' ? b.appVersion.trim().slice(0, FEEDBACK_LIMITS.appVersion) || null : null;
  if (kind === 'stop') {
    const s = parseSuggestion(b);
    if (!s.ok) return s;
    if (!platform) return { ok: false, error: "platform is 'android', 'mac', 'ios' or 'web'" };
    return {
      ok: true,
      value: { kind: 'other', reason: BETTER_STOP, note, platform, appVersion, context: JSON.stringify(s.value), suggestion: s.value },
    };
  }
  let reason: Reason | null = null;
  if (b.reason !== undefined && b.reason !== null) {
    if (kind !== 'wrong' || typeof b.reason !== 'string' || !Object.hasOwn(REASONS, b.reason))
      return { ok: false, error: 'reason is not one of the choices' };
    reason = b.reason as Reason;
  }
  if (!note && !reason) return { ok: false, error: 'say what went wrong' };
  if (!platform) return { ok: false, error: "platform is 'android', 'mac', 'ios' or 'web'" };
  let context: string | null = null;
  if (b.context !== undefined && b.context !== null) {
    if (typeof b.context !== 'object') return { ok: false, error: 'context is the answer object' };
    context = JSON.stringify(b.context);
    if (new TextEncoder().encode(context).length > FEEDBACK_LIMITS.contextBytes) return { ok: false, error: 'context is too large' };
  }
  return { ok: true, value: { kind, reason, note, platform, appVersion, context } };
}

export async function saveFeedback(db: D1Database, userId: string, f: FeedbackInput, nowMs: number): Promise<string | null> {
  const id = crypto.randomUUID();
  const saved = await db
    .prepare(
      `INSERT INTO feedback (id, user_id, created, kind, reason, note, platform, app_version, context)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM feedback WHERE user_id = ? AND created > ?) < ? RETURNING id`,
    )
    .bind(
      id,
      userId,
      nowMs,
      f.kind,
      f.reason,
      f.note,
      f.platform,
      f.appVersion,
      f.context,
      userId,
      nowMs - 86_400_000,
      FEEDBACK_LIMITS.perDay,
    )
    .first<{ id: string }>();
  return saved ? id : null;
}

export function summarize(context: string | null): string {
  if (!context) return 'no answer attached';
  try {
    const a = JSON.parse(context) as { label?: string; stop?: { name?: string }; quality?: string; venue?: string; stopName?: string };
    if (typeof a.venue === 'string') return `${a.venue}: use ${a.stopName ?? 'another stop'}`;
    const what = typeof a.label === 'string' ? a.label : '';
    const where = a.stop?.name ? ` at ${a.stop.name}` : '';
    return `${what}${where}${a.quality ? ` (${a.quality})` : ''}`.trim() || 'an answer';
  } catch {
    return 'an answer';
  }
}

export const OPERATOR_MAILS_PER_DAY = 50;

export async function mailFeedback(env: Env, id: string, f: FeedbackInput, nowMs: number): Promise<void> {
  if (!env.EMAIL || !env.EMAIL_FROM || !env.ALERT_EMAIL) return;
  const sentKey = `feedback:mailed:${new Date(nowMs + 8 * 3_600_000).toISOString().slice(0, 10)}`;
  const sent = Number((await env.KV.get(sentKey).catch(() => null)) ?? 0);
  if (sent >= OPERATOR_MAILS_PER_DAY) return;
  await env.KV.put(sentKey, String(sent + 1), { expirationTtl: 2 * 86_400 }).catch(() => {});
  const s = f.suggestion;
  const what = s ? 'A better stop for a building' : f.kind === 'wrong' ? 'A wrong answer' : 'Feedback';
  const text = [
    `${what} on ${f.platform}${f.appVersion ? ` ${f.appVersion}` : ''}, ${new Date(nowMs).toISOString()}.`,
    '',
    ...(s ? suggestionLines(s) : f.reason && f.reason !== BETTER_STOP ? [`What was wrong: ${REASONS[f.reason]}`] : []),
    ...(f.note ? [`They said: ${f.note}`] : []),
    '',
    ...(s
      ? [
          `If it's right, add this to apps/api/data/src/venue-stops.json and run scripts/data/walk_routes.py:`,
          '',
          venueStopsEntry(s, f.note),
          '',
        ]
      : []),
    `Report ${id}. Who sent it${f.context ? ' and the answer they saw' : ''}: the dashboard at ${linkOrigin(env)}/admin.`,
  ].join('\n');
  const subject = s
    ? `terminus stop suggestion: ${s.venue} from ${s.stop}`
    : oneLine(
        `terminus ${f.kind === 'wrong' ? 'wrong answer' : 'feedback'}: ${(f.note || (f.reason && f.reason !== BETTER_STOP ? REASONS[f.reason] : '')).slice(0, 60)}`,
      );
  await sendMail(env, {
    from: { email: env.EMAIL_FROM, name: mailName(env) },
    to: env.ALERT_EMAIL,
    subject,
    text,
    html: await (
      await mail()
    ).feedbackHtml({
      origin: linkOrigin(env),
      beta: isBeta(env),
      id,
      what,
      from: `${PLATFORM_NAMES[f.platform]}${f.appVersion ? ` ${f.appVersion}` : ''}`,
      at: nowMs,
      reason: !s && f.reason && f.reason !== BETTER_STOP ? REASONS[f.reason] : null,
      note: f.note,
      details: s
        ? [
            ['Building', s.venue],
            ['The stop they use', `${s.stopName} (${s.stop})`],
            ['Its stops now', s.now.join(', ') || 'none'],
          ]
        : [],
      entry: s ? venueStopsEntry(s, f.note) : null,
      withAnswer: !!f.context,
    }),
  });
}

// oxlint-disable-next-line no-control-regex
const oneLine = (text: string) => text.replace(/[\x00-\x1f\x7f]+/g, ' ');

function suggestionLines(s: StopSuggestion): string[] {
  return [`Building: ${s.venue}`, `The stop they use: ${s.stopName} (${s.stop})`, `Its stops now: ${s.now.join(', ') || 'none'}`];
}

export function venueStopsEntry(s: StopSuggestion, note: string): string {
  return `"${s.venue}": ${JSON.stringify({ stops: [s.stop], why: note })}`;
}
