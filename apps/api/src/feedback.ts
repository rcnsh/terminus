/**
 * "This was wrong" reports. The apps and the account page send the answer the
 * user was looking at with a note; it's stored for checking against what the
 * buses actually did, and the note is emailed to the operator so a bad answer
 * is seen the day it happens. Who sent it and the answer stay on the
 * dashboard: an inbox keeps mail after the account is deleted. Only accounts
 * with an email can send one, and every report needs a note: an anonymous
 * answer with nothing said can't be acted on or replied to, and anonymous
 * accounts cost nothing to make. A wrong answer says what was wrong with a
 * reason picked from a few (REASONS), a note, or both. A stop suggestion
 * (kind `stop`) names a building and the stop students use for it, for
 * data/src/venue-stops.json; it's kept as feedback with the reason
 * `better-stop`, and the email carries the entry to paste. Reports are kept
 * FEEDBACK_KEEP_DAYS.
 */

import type { Env } from './types.ts';
import { isBeta, linkOrigin, mailName } from './site.ts';
import { m } from './i18n.ts';
import { mail, sendMail } from './accounts.ts';
import { venueBuilding, venueStops } from './nusmods.ts';
import { GRAPH } from './graph.ts';

export const FEEDBACK_LIMITS = {
  note: 1000,
  /** The answer as shown: plenty for an answer and its arrivals. */
  contextBytes: 16_000,
  appVersion: 20,
  /** Per account per day, so a stuck button can't fill the table or the inbox. */
  perDay: 10,
};

/** Reports older than this are deleted by the cron. */
export const FEEDBACK_KEEP_DAYS = 365;

const PLATFORMS = ['android', 'mac', 'web'] as const;
type Platform = (typeof PLATFORMS)[number];
/** As the operator's email names them. */
const PLATFORM_NAMES: Record<Platform, string> = { android: 'Android', mac: 'Mac', web: 'Web' };

/** What was wrong with an answer, as the apps' chips offer it; the email and the dashboard say it in words. */
export const REASONS = {
  'never-came': 'The bus never came',
  'times-off': 'The times were off',
  'wrong-stop': 'Wrong stop',
  'walk-longer': 'The walk is longer',
  'wrong-class': 'Wrong class',
} as const;
export type Reason = keyof typeof REASONS;

/** A stop suggestion, kept as feedback with this reason; the dashboard says it in words. */
export const BETTER_STOP = 'better-stop';
export const BETTER_STOP_TEXT = 'A better stop for a building';

/** A building and the stop someone uses for it, with the stops it has now. */
export interface StopSuggestion {
  venue: string;
  stop: string;
  stopName: string;
  /** The building's stops as the planner has them, its usual one first. */
  now: string[];
}

export interface FeedbackInput {
  kind: 'wrong' | 'other';
  /** On a wrong answer, or `better-stop` on a stop suggestion. */
  reason: Reason | typeof BETTER_STOP | null;
  /** Empty only when there's a reason. */
  note: string;
  platform: Platform;
  appVersion: string | null;
  context: string | null;
  /** Only on a stop suggestion; `context` is it, as JSON. */
  suggestion?: StopSuggestion;
}

/** A stop suggestion: the building must be one the table knows, the stop one on the map. */
function parseSuggestion(b: Record<string, unknown>): { ok: true; value: StopSuggestion } | { ok: false; error: string } {
  const venue = typeof b.venue === 'string' ? venueBuilding(b.venue) : null;
  if (!venue) return { ok: false, error: 'we don’t know that building; use the code on your timetable, like LT21' };
  const stop = typeof b.stop === 'string' ? GRAPH.stops.find((s) => s.code === b.stop) : undefined;
  if (!stop) return { ok: false, error: 'choose a stop' };
  const has = venueStops(venue);
  const now = has ? [has.to, ...has.also] : [];
  if (now[0] === stop.code || (now[0] && now[0] === stop.opposite)) return { ok: false, error: 'that’s already the stop we use for that building' };
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
    // The building and the stop say it all; why is welcome but not needed.
    const s = parseSuggestion(b);
    if (!s.ok) return s;
    if (!platform) return { ok: false, error: "platform is 'android', 'mac' or 'web'" };
    return { ok: true, value: { kind: 'other', reason: BETTER_STOP, note, platform, appVersion, context: JSON.stringify(s.value), suggestion: s.value } };
  }
  let reason: Reason | null = null;
  if (b.reason !== undefined && b.reason !== null) {
    if (kind !== 'wrong' || typeof b.reason !== 'string' || !Object.hasOwn(REASONS, b.reason)) return { ok: false, error: 'reason is not one of the choices' };
    reason = b.reason as Reason;
  }
  if (!note && !reason) return { ok: false, error: 'say what went wrong' };
  if (!platform) return { ok: false, error: "platform is 'android', 'mac' or 'web'" };
  let context: string | null = null;
  if (b.context !== undefined && b.context !== null) {
    if (typeof b.context !== 'object') return { ok: false, error: 'context is the answer object' };
    context = JSON.stringify(b.context);
    if (new TextEncoder().encode(context).length > FEEDBACK_LIMITS.contextBytes) return { ok: false, error: 'context is too large' };
  }
  return { ok: true, value: { kind, reason, note, platform, appVersion, context } };
}

/** Stores the report and returns its id; null when the account has sent its day's worth. */
export async function saveFeedback(db: D1Database, userId: string, f: FeedbackInput, nowMs: number): Promise<string | null> {
  const id = crypto.randomUUID();
  // Counted and inserted in one statement, so reports sent at once can't all
  // see the count from before the others.
  const saved = await db
    .prepare(
      `INSERT INTO feedback (id, user_id, created, kind, reason, note, platform, app_version, context)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM feedback WHERE user_id = ? AND created > ?) < ? RETURNING id`,
    )
    .bind(id, userId, nowMs, f.kind, f.reason, f.note, f.platform, f.appVersion, f.context, userId, nowMs - 86_400_000, FEEDBACK_LIMITS.perDay)
    .first<{ id: string }>();
  return saved ? id : null;
}

/** One line about the answer, for the email subject and the dashboard. */
export function summarize(context: string | null): string {
  if (!context) return 'no answer attached';
  try {
    const a = JSON.parse(context) as { label?: string; stop?: { name?: string }; quality?: string; venue?: string; stopName?: string };
    // A stop suggestion: the building and the stop, not an answer.
    if (typeof a.venue === 'string') return `${a.venue}: use ${a.stopName ?? 'another stop'}`;
    const what = typeof a.label === 'string' ? a.label : '';
    const where = a.stop?.name ? ` at ${a.stop.name}` : '';
    return `${what}${where}${a.quality ? ` (${a.quality})` : ''}`.trim() || 'an answer';
  } catch {
    return 'an answer';
  }
}

/** Feedback emails to the operator a day, across everyone; past it, reports are only on the dashboard. */
export const OPERATOR_MAILS_PER_DAY = 50;

/**
 * Emails the operator the note. Not the reporter's address nor the answer:
 * the dashboard has both, and the inbox would keep them after the account
 * is deleted.
 */
export async function mailFeedback(env: Env, id: string, f: FeedbackInput, nowMs: number): Promise<void> {
  if (!env.EMAIL || !env.EMAIL_FROM || !env.ALERT_EMAIL) return;
  // A soft cap (KV is not atomic): new accounts are cheap, the inbox is not.
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
    ...(s ? [`If it's right, add this to apps/api/data/src/venue-stops.json and run scripts/walk_routes.py:`, '', venueStopsEntry(s, f.note), ''] : []),
    `Report ${id}. Who sent it${f.context ? ' and the answer they saw' : ''}: the dashboard at ${linkOrigin(env)}/admin.`,
  ].join('\n');
  const subject = s ? `terminus stop suggestion: ${s.venue} from ${s.stop}` : oneLine(`terminus ${f.kind === 'wrong' ? 'wrong answer' : 'feedback'}: ${(f.note || (f.reason && f.reason !== BETTER_STOP ? REASONS[f.reason] : '')).slice(0, 60)}`);
  await sendMail(env, {
    from: { email: env.EMAIL_FROM, name: mailName(env) },
    to: env.ALERT_EMAIL,
    subject,
    text,
    html: await (await mail()).feedbackHtml({
      origin: linkOrigin(env),
      beta: isBeta(env),
      id,
      what,
      from: `${PLATFORM_NAMES[f.platform]}${f.appVersion ? ` ${f.appVersion}` : ''}`,
      at: nowMs,
      reason: !s && f.reason && f.reason !== BETTER_STOP ? REASONS[f.reason] : null,
      note: f.note,
      details: s ? [['Building', s.venue], ['The stop they use', `${s.stopName} (${s.stop})`], ['Its stops now', s.now.join(', ') || 'none']] : [],
      entry: s ? venueStopsEntry(s, f.note) : null,
      withAnswer: !!f.context,
    }),
  });
}

/** Their words, on one line: a subject is a header. Matching control characters is the point here. */
// oxlint-disable-next-line no-control-regex
const oneLine = (text: string) => text.replace(/[\x00-\x1f\x7f]+/g, ' ');

function suggestionLines(s: StopSuggestion): string[] {
  return [`Building: ${s.venue}`, `The stop they use: ${s.stopName} (${s.stop})`, `Its stops now: ${s.now.join(', ') || 'none'}`];
}

/**
 * The building's entry for data/src/venue-stops.json: the suggested stop
 * alone, as the listed stops replace the map's choice (add another stop if
 * both are used). Their note is the start of `why`; check it first.
 */
export function venueStopsEntry(s: StopSuggestion, note: string): string {
  return `"${s.venue}": ${JSON.stringify({ stops: [s.stop], why: note })}`;
}
