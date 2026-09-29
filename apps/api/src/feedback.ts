/**
 * "This was wrong" reports. The apps and the account page send the answer the
 * user was looking at with an optional note; it's stored for checking against
 * what the buses actually did, and emailed to the operator so a bad answer is
 * seen the day it happens.
 */

import type { Env } from './types.ts';

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
}

export function parseFeedback(body: unknown): { ok: true; value: FeedbackInput } | { ok: false; error: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const kind = b.kind === 'other' ? 'other' : b.kind === 'wrong' || b.kind === undefined ? 'wrong' : null;
  if (!kind) return { ok: false, error: "kind is 'wrong' or 'other'" };
  const note = typeof b.note === 'string' ? b.note.trim() : '';
  if (note.length > FEEDBACK_LIMITS.note) return { ok: false, error: `keep the note under ${FEEDBACK_LIMITS.note} characters` };
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
  return { ok: true, value: { kind, note, platform, appVersion, context } };
}

/** Stores the report; false when the account has sent its day's worth. */
export async function saveFeedback(db: D1Database, userId: string, f: FeedbackInput, nowMs: number): Promise<string | null> {
  const recent = await db
    .prepare('SELECT COUNT(*) AS n FROM feedback WHERE user_id = ? AND created > ?')
    .bind(userId, nowMs - 86_400_000)
    .first<{ n: number }>();
  if ((recent?.n ?? 0) >= FEEDBACK_LIMITS.perDay) return null;
  const id = crypto.randomUUID();
  await db
    .prepare('INSERT INTO feedback (id, user_id, created, kind, note, platform, app_version, context) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, userId, nowMs, f.kind, f.note, f.platform, f.appVersion, f.context)
    .run();
  return id;
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

/** Emails the operator. The reporter's address is included so you can reply. */
export async function mailFeedback(env: Env, id: string, email: string, f: FeedbackInput, nowMs: number): Promise<void> {
  if (!env.EMAIL || !env.EMAIL_FROM || !env.ALERT_EMAIL) return;
  const text = [
    `${f.kind === 'wrong' ? 'A wrong answer' : 'Feedback'} from ${email} on ${f.platform}${f.appVersion ? ` ${f.appVersion}` : ''}, ${new Date(nowMs).toISOString()}.`,
    '',
    f.note ? `They said: ${f.note}` : 'No note.',
    '',
    `The answer: ${summarize(f.context)}`,
    '',
    f.context ? JSON.stringify(JSON.parse(f.context), null, 2) : '',
    '',
    `Report ${id}; all reports are on the dashboard at https://terminus.rcn.sh/admin.`,
  ].join('\n');
  await env.EMAIL.send({
    from: { email: env.EMAIL_FROM, name: 'terminus' },
    to: env.ALERT_EMAIL,
    subject: `terminus feedback: ${f.kind === 'wrong' ? summarize(f.context) : f.note.slice(0, 60)}`,
    text,
  });
}
