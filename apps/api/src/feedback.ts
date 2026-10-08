/**
 * "This was wrong" reports. The apps and the account page send the answer the
 * user was looking at with a note; it's stored for checking against what the
 * buses actually did, and the note is emailed to the operator so a bad answer
 * is seen the day it happens. Who sent it and the answer stay on the
 * dashboard: an inbox keeps mail after the account is deleted. Only accounts
 * with an email can send one, and every report needs a note: an anonymous
 * answer with nothing said can't be acted on or replied to, and anonymous
 * accounts cost nothing to make. A wrong answer says what was wrong with a
 * reason picked from a few (REASONS), a note, or both. Reports are kept
 * FEEDBACK_KEEP_DAYS.
 */

import type { Env } from './types.ts';
import { mailName, siteOrigin } from './site.ts';
import { m } from './i18n.ts';
import { sendMail } from './accounts.ts';

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

/** What was wrong with an answer, as the apps' chips offer it; the email and the dashboard say it in words. */
export const REASONS = {
  'never-came': 'The bus never came',
  'times-off': 'The times were off',
  'wrong-stop': 'Wrong stop',
  'walk-longer': 'The walk is longer',
  'wrong-class': 'Wrong class',
} as const;
export type Reason = keyof typeof REASONS;

export interface FeedbackInput {
  kind: 'wrong' | 'other';
  /** Only on a wrong answer. */
  reason: Reason | null;
  /** Empty only when there's a reason. */
  note: string;
  platform: Platform;
  appVersion: string | null;
  context: string | null;
}

export function parseFeedback(body: unknown): { ok: true; value: FeedbackInput } | { ok: false; error: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const kind = b.kind === 'other' ? 'other' : b.kind === 'wrong' || b.kind === undefined ? 'wrong' : null;
  if (!kind) return { ok: false, error: "kind is 'wrong' or 'other'" };
  const note = typeof b.note === 'string' ? b.note.trim() : '';
  if (note.length > FEEDBACK_LIMITS.note) return { ok: false, error: m().noteTooLong(FEEDBACK_LIMITS.note) };
  let reason: Reason | null = null;
  if (b.reason !== undefined && b.reason !== null) {
    if (kind !== 'wrong' || typeof b.reason !== 'string' || !Object.hasOwn(REASONS, b.reason)) return { ok: false, error: 'reason is not one of the choices' };
    reason = b.reason as Reason;
  }
  if (!note && !reason) return { ok: false, error: 'say what went wrong' };
  const platform = PLATFORMS.find((p) => p === b.platform);
  if (!platform) return { ok: false, error: "platform is 'android', 'mac' or 'web'" };
  const appVersion = typeof b.appVersion === 'string' ? b.appVersion.trim().slice(0, FEEDBACK_LIMITS.appVersion) || null : null;
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
    const a = JSON.parse(context) as { label?: string; stop?: { name?: string }; quality?: string };
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
  const text = [
    `${f.kind === 'wrong' ? 'A wrong answer' : 'Feedback'} on ${f.platform}${f.appVersion ? ` ${f.appVersion}` : ''}, ${new Date(nowMs).toISOString()}.`,
    '',
    ...(f.reason ? [`What was wrong: ${REASONS[f.reason]}`] : []),
    ...(f.note ? [`They said: ${f.note}`] : []),
    '',
    `Report ${id}. Who sent it${f.context ? ' and the answer they saw' : ''}: the dashboard at ${siteOrigin(env)}/admin.`,
  ].join('\n');
  await sendMail(env, {
    from: { email: env.EMAIL_FROM, name: mailName(env) },
    to: env.ALERT_EMAIL,
    // Their words, on one line: a subject is a header. Matching control
    // characters is the point here.
    // oxlint-disable-next-line no-control-regex
    subject: `terminus ${f.kind === 'wrong' ? 'wrong answer' : 'feedback'}: ${(f.note || (f.reason ? REASONS[f.reason] : '')).slice(0, 60)}`.replace(/[\x00-\x1f\x7f]+/g, ' '),
    text,
  });
}
