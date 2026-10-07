/**
 * "This was wrong" reports. The apps and the account page send the answer the
 * user was looking at with an optional note; it's stored for checking against
 * what the buses actually did, and emailed to the operator so a bad answer is
 * seen the day it happens.
 */

import type { Env } from './types.ts';
import { mailName, siteOrigin } from './site.ts';
import { m } from './i18n.ts';
import { normalizeEmail } from './accounts.ts';

export const FEEDBACK_LIMITS = {
  note: 1000,
  /** The answer as shown: plenty for an answer and its arrivals. */
  contextBytes: 16_000,
  appVersion: 20,
  /** Per account per day, so a stuck button can't fill the table or the inbox. */
  perDay: 10,
};

const PLATFORMS = ['android', 'mac', 'web'] as const;
type Platform = (typeof PLATFORMS)[number];

export interface FeedbackInput {
  kind: 'wrong' | 'other';
  note: string;
  platform: Platform;
  appVersion: string | null;
  context: string | null;
  /** Typed on the Feedback page by an account without an email; never checked. */
  replyTo: string | null;
}

export function parseFeedback(body: unknown): { ok: true; value: FeedbackInput } | { ok: false; error: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const kind = b.kind === 'other' ? 'other' : b.kind === 'wrong' || b.kind === undefined ? 'wrong' : null;
  if (!kind) return { ok: false, error: "kind is 'wrong' or 'other'" };
  const note = typeof b.note === 'string' ? b.note.trim() : '';
  if (note.length > FEEDBACK_LIMITS.note) return { ok: false, error: m().noteTooLong(FEEDBACK_LIMITS.note) };
  if (kind === 'other' && !note) return { ok: false, error: 'say what went wrong' };
  const platform = PLATFORMS.find((p) => p === b.platform);
  if (!platform) return { ok: false, error: "platform is 'android', 'mac' or 'web'" };
  const appVersion = typeof b.appVersion === 'string' ? b.appVersion.trim().slice(0, FEEDBACK_LIMITS.appVersion) || null : null;
  let context: string | null = null;
  if (b.context !== undefined && b.context !== null) {
    if (typeof b.context !== 'object') return { ok: false, error: 'context is the answer object' };
    context = JSON.stringify(b.context);
    if (new TextEncoder().encode(context).length > FEEDBACK_LIMITS.contextBytes) return { ok: false, error: 'context is too large' };
  }
  if (kind === 'wrong' && !context && !note) return { ok: false, error: 'send the answer that was wrong, or a note' };
  let replyTo: string | null = null;
  if (b.replyTo !== undefined && b.replyTo !== null && b.replyTo !== '') {
    replyTo = normalizeEmail(b.replyTo);
    if (!replyTo) return { ok: false, error: 'enter a valid email address' };
  }
  return { ok: true, value: { kind, note, platform, appVersion, context, replyTo } };
}

/** Stores the report; false when the account has sent its day's worth. */
export async function saveFeedback(db: D1Database, userId: string, f: FeedbackInput, nowMs: number): Promise<string | null> {
  const id = crypto.randomUUID();
  // Counted and inserted in one statement, so reports sent at once can't all
  // see the count from before the others.
  const saved = await db
    .prepare(
      `INSERT INTO feedback (id, user_id, created, kind, note, platform, app_version, context, reply_to)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM feedback WHERE user_id = ? AND created > ?) < ? RETURNING id`,
    )
    .bind(id, userId, nowMs, f.kind, f.note, f.platform, f.appVersion, f.context, f.replyTo, userId, nowMs - 86_400_000, FEEDBACK_LIMITS.perDay)
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
 * Emails the operator. The reporter's address is included so you can reply:
 * the account's own, or else the one they typed, marked as unchecked.
 */
export async function mailFeedback(env: Env, id: string, accountEmail: string | null, f: FeedbackInput, nowMs: number): Promise<void> {
  if (!env.EMAIL || !env.EMAIL_FROM || !env.ALERT_EMAIL) return;
  // A soft cap (KV is not atomic): new accounts are cheap, the inbox is not.
  const sentKey = `feedback:mailed:${new Date(nowMs + 8 * 3_600_000).toISOString().slice(0, 10)}`;
  const sent = Number((await env.KV.get(sentKey).catch(() => null)) ?? 0);
  if (sent >= OPERATOR_MAILS_PER_DAY) return;
  await env.KV.put(sentKey, String(sent + 1), { expirationTtl: 2 * 86_400 }).catch(() => {});
  const email = accountEmail ?? (f.replyTo ? `an anonymous account (reply to ${f.replyTo}, not checked)` : 'an anonymous account');
  const text = [
    `${f.kind === 'wrong' ? 'A wrong answer' : 'Feedback'} from ${email} on ${f.platform}${f.appVersion ? ` ${f.appVersion}` : ''}, ${new Date(nowMs).toISOString()}.`,
    '',
    f.note ? `They said: ${f.note}` : 'No note.',
    '',
    `The answer: ${summarize(f.context)}`,
    '',
    f.context ? JSON.stringify(JSON.parse(f.context), null, 2) : '',
    '',
    `Report ${id}; all reports are on the dashboard at ${siteOrigin(env)}/admin.`,
  ].join('\n');
  await env.EMAIL.send({
    from: { email: env.EMAIL_FROM, name: mailName(env) },
    to: env.ALERT_EMAIL,
    // Their words, on one line: a subject is a header. Matching control
    // characters is the point here.
    // oxlint-disable-next-line no-control-regex
    subject: `terminus feedback: ${f.kind === 'wrong' ? summarize(f.context) : f.note.slice(0, 60)}`.replace(/[\x00-\x1f\x7f]+/g, ' '),
    text,
  });
}
