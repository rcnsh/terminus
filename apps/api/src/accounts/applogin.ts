/**
 * Signing in an app, confirmed from the email (modelled on RFC 8628): a code
 * to type into the app, or a link to a page that asks for the number the app
 * shows. The app holds `poll`; the email holds `code` and `link`, so the app
 * can never confirm its own request. Not a link that opens the app: the Mac
 * and an iOS sideload can't take universal links without a paid Apple team.
 * Why a code and a typed number: see internals.md, *Accounts*.
 */

import type { Env } from '../types.ts';
import { mailName } from '../site/site.ts';
import { isBeta, linkOrigin } from '../origin.ts';
import {
  type Client,
  type Live,
  type User,
  ACCOUNT_TTL,
  addEmailTo,
  anonymousGone,
  hasSetup,
  hashToken,
  inboxKey,
  mailBudgetLeft,
  takeMailBudget,
  takeGlobalMail,
  loadProfileJson,
  codesLeft,
  countWrongCode,
  newEmailCode,
  newToken,
  profileFor,
  removeAnonymous,
  profileUpsert,
  mail,
  sendMail,
  sessionFor,
  userFor,
} from './accounts.ts';
import { m } from '../i18n.ts';

export { hasSetup } from './accounts.ts';

export const LOGIN_TTL = {
  requestMs: 15 * 60_000,
  /** One email per address per this window, shared with the web's sign-in links. */
  cooldownMs: ACCOUNT_TTL.linkCooldownMs,
  /** Wrong codes before the request dies. */
  codeTries: ACCOUNT_TTL.codeTries,
  /** After "this wasn't me", how long the address takes no app sign-ins. */
  heldMs: 6 * 3_600_000,
} as const;

const heldKey = async (email: string) => `held:${await hashToken(inboxKey(email))}`;

/** "This wasn't me": no app sign-in to this address for LOGIN_TTL.heldMs. */
export async function holdAppLogins(env: Env, email: string): Promise<void> {
  await env.KV.put(await heldKey(email), '1', { expirationTtl: LOGIN_TTL.heldMs / 1000 }).catch(() => {});
}

export interface StartInput {
  email: string;
  name: string;
  client: Client;
  /** The anonymous account of the device asking, when it has one. */
  anonUserId: string | null;
}

export interface Started {
  request: string;
  poll: string;
  match: number;
  expires: number;
}

/** 10 to 99: two digits, easy to compare at a glance. */
function randomMatch(): number {
  return 10 + (crypto.getRandomValues(new Uint32Array(1))[0] % 90);
}

/**
 * Starts a request and emails the approval link. 'cooldown' when this address
 * was sent an email in the last minute; 'held' after its owner said a request
 * wasn't theirs. A blocked address gets a request that looks the same and
 * never completes, so the reply doesn't reveal the blocklist.
 */
export async function startAppLogin(
  env: Env,
  db: D1Database,
  input: StartInput,
  origin: string,
  nowMs: number,
): Promise<Started | 'cooldown' | 'busy' | 'held'> {
  const { email } = input;
  if (await env.KV.get(await heldKey(email)).catch(() => null)) return 'held';
  const inbox = inboxKey(email);
  const coolKey = `mail:${await hashToken(inbox)}`;
  const recent = await db
    .prepare(
      'SELECT 1 FROM login_requests WHERE email = ? AND created > ? UNION ALL SELECT 1 FROM magic_links WHERE email = ? AND created > ?',
    )
    .bind(email, nowMs - LOGIN_TTL.cooldownMs, email, nowMs - LOGIN_TTL.cooldownMs)
    .first();
  if (recent || (await env.KV.get(coolKey).catch(() => null))) return 'cooldown';
  const blocked = await db.prepare('SELECT 1 FROM blocklist WHERE email IN (?, ?)').bind(email, inbox).first();
  // An inbox over its hourly budget is refused before the ceiling, so it
  // spends nothing of everyone's.
  if (!blocked && !(await mailBudgetLeft(env, inbox, nowMs))) return 'cooldown';
  // Everyone's ceiling, after the cooldown so a repeat can't spend it. A
  // blocked address spends it too, so a busy minute doesn't reveal it.
  if (!(await takeGlobalMail(env, 'app'))) return 'busy';
  // A blocked address is sent nothing, so it spends nothing of its inbox's.
  if (!blocked && !(await takeMailBudget(env, inbox, nowMs))) return 'cooldown';

  const id = crypto.randomUUID();
  const poll = newToken();
  const link = newToken();
  // Digits, for the keyboard to offer (newEmailCode).
  const code = newEmailCode();
  const match = randomMatch();
  const expires = nowMs + LOGIN_TTL.requestMs;
  // The cooldown checked again in the insert itself: two requests at once
  // can't both pass the check above and both send an email.
  const since = nowMs - LOGIN_TTL.cooldownMs;
  const [, made] = await db.batch([
    db.prepare('DELETE FROM login_requests WHERE expires < ?').bind(nowMs),
    db
      .prepare(
        `INSERT INTO login_requests (id, email, poll_hash, link_hash, code_hash, match, device_name, platform, anon_user_id, status, created, expires)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
          WHERE NOT EXISTS (SELECT 1 FROM login_requests WHERE email = ? AND created > ?)
            AND NOT EXISTS (SELECT 1 FROM magic_links WHERE email = ? AND created > ?)
         RETURNING id`,
      )
      .bind(
        id,
        email,
        await hashToken(poll),
        await hashToken(link),
        await hashToken(code),
        match,
        input.name,
        input.client.platform,
        input.anonUserId,
        blocked ? 'blocked' : 'pending',
        nowMs,
        expires,
        email,
        since,
        email,
        since,
      ),
  ]);
  if (!made?.results?.length) return 'cooldown';
  if (!blocked) {
    try {
      if (!env.EMAIL || !env.EMAIL_FROM) throw new Error('email sending not configured');
      await sendApproval(env, email, input.name, code, `${origin}/auth/approve?r=${link}`, origin);
    } catch (err) {
      // Otherwise the unsent request holds the cooldown.
      await db.prepare('DELETE FROM login_requests WHERE id = ?').bind(id).run();
      throw err;
    }
  }
  await env.KV.put(coolKey, '1', { expirationTtl: Math.max(60, LOGIN_TTL.cooldownMs / 1000) }).catch(() => {});
  return { request: id, poll, match, expires };
}

/**
 * The device as the sign-in email names it: up to its first word with a digit
 * ("iPhone 17 Pro" is "iPhone"), since the keyboard offering the code from
 * the email could take the model's number for it.
 */
export function mailDevice(name: string): string {
  const words = name.trim().split(/\s+/);
  const n = words.findIndex((w) => /\d/.test(w));
  return (n < 0 ? words : words.slice(0, n)).join(' ');
}

/**
 * Worded like the web's sign-in email: the code up front, in the subject too,
 * since a lone link under "Sign in to ..." is the shape of a phishing mail.
 * The device's number is never in it: it's only on the device's screen.
 */
async function sendApproval(env: Env, email: string, device: string, code: string, link: string, origin: string): Promise<void> {
  const site = new URL(origin).host;
  const t = m();
  device = mailDevice(device) || t.aDevice;
  const why = t.codeWhyApp(site, device);
  await sendMail(env, {
    from: { email: env.EMAIL_FROM!, name: mailName(env) },
    to: email,
    subject: t.codeSubject(code),
    text: `${t.codeIs(code)}

${t.codeTypeApp(device)}

${t.codeOtherDeviceText(device)}
${link}

${why}`,
    html: await (await mail()).signInHtml({ origin: linkOrigin(env), beta: isBeta(env), code, link, device, why }),
  });
}

/**
 * The code from the email, typed into the app that asked. Right: the
 * request is approved (the caller then collects the token as a poll would).
 * Wrong five times, or for another request: it dies. Once the address has
 * had WRONG_CODES_PER_DAY, no code is checked ('locked').
 */
export async function enterCode(
  env: Env,
  db: D1Database,
  id: string,
  poll: string,
  code: string,
  nowMs: number,
): Promise<'approved' | 'wrong' | 'locked' | 'denied' | 'expired'> {
  const row = await db
    .prepare('SELECT email, poll_hash, code_hash, code_tries, status, expires FROM login_requests WHERE id = ?')
    .bind(id)
    .first<{ email: string; poll_hash: string; code_hash: string; code_tries: number; status: string; expires: number }>();
  if (!row || row.poll_hash !== (await hashToken(poll)) || row.expires < nowMs) return 'expired';
  if (row.status === 'approved') return 'approved';
  if (row.status === 'denied') return 'denied';
  // A blocked address was never sent a code: every guess is simply wrong.
  if (row.status !== 'pending' && row.status !== 'blocked') return 'expired';
  // The request stays alive: the email's link can still approve it.
  if (!(await codesLeft(env, row.email, nowMs))) return 'locked';
  // Spend the try before checking the code, in one statement: guesses sent
  // all at once can't each see the count from before the others.
  const spent = await db
    .prepare(
      "UPDATE login_requests SET code_tries = code_tries + 1 WHERE id = ? AND code_tries < ? AND status IN ('pending', 'blocked') RETURNING code_tries",
    )
    .bind(id, LOGIN_TTL.codeTries)
    .first<{ code_tries: number }>();
  if (!spent) return 'denied';
  if (row.status === 'pending' && (await hashToken(code)) === row.code_hash) {
    const ok = await db
      .prepare("UPDATE login_requests SET status = 'approved' WHERE id = ? AND status = 'pending' RETURNING id")
      .bind(id)
      .first();
    return ok ? 'approved' : 'expired';
  }
  await countWrongCode(env, row.email, nowMs);
  if (spent.code_tries < LOGIN_TTL.codeTries) return 'wrong';
  await db.prepare("UPDATE login_requests SET status = 'denied' WHERE id = ? AND status IN ('pending', 'blocked')").bind(id).run();
  return 'denied';
}

export interface Approvable {
  device: string;
  created: number;
}

/**
 * What the approval page shows, without changing anything (mail scanners
 * open every link). Null when the link is unknown, used or expired.
 */
export async function approvable(db: D1Database, link: string, nowMs: number): Promise<Approvable | null> {
  const linkHash = await hashToken(link);
  const row = await db
    .prepare("SELECT device_name, created FROM login_requests WHERE link_hash = ? AND status = 'pending' AND expires >= ?")
    .bind(linkHash, nowMs)
    .first<{ device_name: string; created: number }>();
  if (!row) return null;
  return { device: row.device_name, created: row.created };
}

/**
 * The approver's answer. The right number approves; a wrong number, or
 * "this wasn't me" (null), kills the request. Works once. The address
 * comes back with the answer, for holdAppLogins.
 */
export async function decide(
  db: D1Database,
  link: string,
  typed: number | null,
  nowMs: number,
): Promise<{ status: 'approved' | 'denied' | 'expired'; email?: string }> {
  const row = await db
    .prepare(
      `UPDATE login_requests SET status = CASE WHEN match = ? THEN 'approved' ELSE 'denied' END
        WHERE link_hash = ? AND status = 'pending' AND expires >= ? RETURNING status, email`,
    )
    .bind(typed ?? -1, await hashToken(link), nowMs)
    .first<{ status: 'approved' | 'denied'; email: string }>();
  return row ? { status: row.status, email: row.email } : { status: 'expired' };
}

/** How a finished sign-in left the accounts. */
export type SignInOutcome =
  /** A new account with this email. */
  | 'created'
  /** The device's anonymous account now has the email; nothing moved. */
  | 'added-email'
  /** Signed in to the existing account; the device had no setup to keep. */
  | 'signed-in'
  /** Signed in; the account had no setup, so the device's was moved to it. */
  | 'moved-setup'
  /** Both have a setup: the app asks which to keep, then calls /auth/app/merge. */
  | 'choose';

export type PollResult =
  | { status: 'pending' | 'denied' | 'expired' }
  | {
      status: 'approved';
      token: string;
      email: string;
      outcome: SignInOutcome;
      userId: string;
      device: string;
      /** The anonymous account this sign-in deleted, if any. */
      removed?: string;
    };

/**
 * The app's poll. Once approved, the first poll with the right secret gets
 * the token (and the request is spent); every other answer is a status.
 */
export async function pollAppLogin(db: D1Database, id: string, poll: string, client: Client, nowMs: number): Promise<PollResult> {
  const row = await db
    .prepare('SELECT poll_hash, status, expires FROM login_requests WHERE id = ?')
    .bind(id)
    .first<{ poll_hash: string; status: string; expires: number }>();
  // An unknown request and a wrong secret look the same as an old one.
  if (!row || row.poll_hash !== (await hashToken(poll)) || row.expires < nowMs) return { status: 'expired' };
  if (row.status === 'pending' || row.status === 'blocked') return { status: 'pending' };
  if (row.status !== 'approved') return { status: row.status === 'denied' ? 'denied' : 'expired' };

  const req = await db
    .prepare("SELECT email, device_name, anon_user_id, platform FROM login_requests WHERE id = ? AND status = 'approved'")
    .bind(id)
    .first<{ email: string; device_name: string; anon_user_id: string | null; platform: Client['platform'] }>();
  if (!req) return { status: 'expired' };
  // The platform the app named when it started, if this poll doesn't say.
  if (!client.platform) client = { ...client, platform: req.platform };

  const existing = await db.prepare('SELECT id, email FROM users WHERE email = ?').bind(req.email).first<User>();
  const anon = req.anon_user_id
    ? await db.prepare('SELECT id FROM users WHERE id = ? AND email IS NULL').bind(req.anon_user_id).first<{ id: string }>()
    : null;

  // Every change below runs in one batch with the session and the spend, so
  // a failure part way (a web sign-in giving the email to another account
  // meanwhile, say) leaves the request approved for the next poll, and of
  // two racing polls only one is handed a token.
  const live: Live = { sql: "EXISTS (SELECT 1 FROM login_requests WHERE id = ? AND status = 'approved')", params: [id] };
  const work: D1PreparedStatement[] = [];
  let outcome: SignInOutcome;
  if (!existing && anon) {
    // The device's old anonymous token is replaced by the one returned here.
    work.push(...addEmailTo(db, anon.id, req.email, nowMs, live));
    outcome = 'added-email';
  } else if (!existing) {
    work.push(userFor(db, req.email, nowMs, 'app', live));
    outcome = 'created';
  } else {
    outcome = 'signed-in';
    if (anon) {
      const mine = await loadProfileJson(db, anon.id);
      if (!hasSetup(mine)) {
        work.push(...anonymousGone(db, anon.id, existing.id, live));
      } else if (!hasSetup(await loadProfileJson(db, existing.id))) {
        work.push(profileFor(db, existing.id, mine, nowMs, live), ...anonymousGone(db, anon.id, existing.id, live));
        outcome = 'moved-setup';
      } else {
        // Kept until the app says which setup wins.
        outcome = 'choose';
      }
    }
  }
  const token = newToken();
  const tokenHash = await hashToken(token);
  let out: D1Result[];
  try {
    out = await db.batch([
      ...work,
      sessionFor(db, tokenHash, req.email, 'device', req.device_name, nowMs, client, live),
      db
        .prepare(
          "UPDATE login_requests SET status = 'done' WHERE id = ? AND status = 'approved' AND EXISTS (SELECT 1 FROM sessions WHERE token_hash = ?) RETURNING id",
        )
        .bind(id, tokenHash),
    ]);
  } catch (err) {
    // Nothing was changed: the app's next poll tries again.
    console.error('app sign-in: could not finish, left for the next poll:', err instanceof Error ? err.message : String(err));
    return { status: 'pending' };
  }
  const userId = (out.at(-2)?.results?.[0] as { user_id: string } | undefined)?.user_id;
  // Spent by a racing poll, or the account changed under it: pending lets a
  // request that's still approved finish on the next poll, and a spent one
  // then reads as expired.
  if (!userId || !out.at(-1)?.results?.length) return { status: 'pending' };
  const removed = anon && (outcome === 'signed-in' || outcome === 'moved-setup') ? anon.id : undefined;
  return { status: 'approved', token, email: req.email, outcome, userId, device: req.device_name, removed };
}

/**
 * After a 'choose' outcome: keep the account's setup, or replace it with
 * the device's. The caller proves it holds both tokens: the new one as its
 * session, the old anonymous one in the body. The anonymous account goes.
 */
export async function mergeAnonymous(
  db: D1Database,
  userId: string,
  anonToken: string,
  keep: 'account' | 'device',
  nowMs: number,
): Promise<{ removed: string } | 'not-anonymous'> {
  const anon = await db
    .prepare('SELECT u.id FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND u.email IS NULL')
    .bind(await hashToken(anonToken))
    .first<{ id: string }>();
  if (!anon || anon.id === userId) return 'not-anonymous';
  // The setup and the removal in one batch: half a merge would leave the
  // account with the device's setup and the device still signed in.
  const mine = keep === 'device' ? await loadProfileJson(db, anon.id) : null;
  await removeAnonymous(db, anon.id, userId, mine ? [profileUpsert(db, userId, mine, nowMs)] : []);
  return { removed: anon.id };
}
