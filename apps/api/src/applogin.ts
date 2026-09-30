/**
 * Signing in an app, confirmed from the email (modelled on RFC 8628, device
 * authorisation). The app starts a request and the email carries two ways to
 * confirm it: a code to type into the app, and a link, for reading mail on
 * another device, to a page that asks which number the app shows. The app
 * polls and picks up its token once either is done.
 *
 * Why a code first: university filters (NUS's among them) hold back mail
 * that is only a link, and a code needs no click. Typing it into the app
 * proves the inbox and the device are in the same hands.
 *
 * Why not open the app from the link: the Mac (and an iOS sideload) can't
 * take universal links without a paid Apple team, and people often read mail
 * on a different device from the one they are signing in.
 *
 * Why the number: without it anyone could type your address into their app
 * and you might approve an email you weren't expecting. Choosing the number
 * your own screen shows proves you are looking at the device being signed in.
 *
 * The app holds `poll`; the email holds different secrets (`code`, `link`),
 * so the app that started a request can never confirm it by itself.
 */

import type { Env } from './types.ts';
import { type Client, type User, ACCOUNT_TTL, ensureUser, hashToken, inboxKey, loadProfileJson, newPairCode, newToken, openSession, saveProfileJson } from './accounts.ts';

export const LOGIN_TTL = {
  requestMs: 15 * 60_000,
  /** One email per address per this window, shared with the web's sign-in links. */
  cooldownMs: ACCOUNT_TTL.linkCooldownMs,
  /** Wrong codes before the request dies. */
  codeTries: ACCOUNT_TTL.codeTries,
} as const;

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
 * was sent an email in the last minute. A blocked address gets a request that
 * looks the same and never completes, so the reply doesn't reveal the blocklist.
 */
export async function startAppLogin(env: Env, db: D1Database, input: StartInput, origin: string, nowMs: number): Promise<Started | 'cooldown'> {
  const { email } = input;
  const inbox = inboxKey(email);
  const coolKey = `mail:${await hashToken(inbox)}`;
  const recent = await db
    .prepare('SELECT 1 FROM login_requests WHERE email = ? AND created > ? UNION ALL SELECT 1 FROM magic_links WHERE email = ? AND created > ?')
    .bind(email, nowMs - LOGIN_TTL.cooldownMs, email, nowMs - LOGIN_TTL.cooldownMs)
    .first();
  if (recent || (await env.KV.get(coolKey).catch(() => null))) return 'cooldown';
  const blocked = await db.prepare('SELECT 1 FROM blocklist WHERE email IN (?, ?)').bind(email, inbox).first();

  const id = crypto.randomUUID();
  const poll = newToken();
  const link = newToken();
  // Same alphabet as pairing codes: no 0/O or 1/I/L to misread.
  const code = newPairCode();
  const match = randomMatch();
  const expires = nowMs + LOGIN_TTL.requestMs;
  await db.batch([
    db.prepare('DELETE FROM login_requests WHERE expires < ?').bind(nowMs),
    // One pending request per address: the newest one wins.
    db.prepare("UPDATE login_requests SET status = 'denied' WHERE email = ? AND status IN ('pending', 'approved')").bind(email),
    db
      .prepare(
        `INSERT INTO login_requests (id, email, poll_hash, link_hash, code_hash, match, device_name, platform, anon_user_id, status, created, expires)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(id, email, await hashToken(poll), await hashToken(link), await hashToken(code), match, input.name, input.client.platform, input.anonUserId, blocked ? 'blocked' : 'pending', nowMs, expires),
  ]);
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
 * Worded like the web's sign-in email: the code up front, in the subject too,
 * since a lone link under "Sign in to ..." is the shape of a phishing mail.
 * The device's number is never in it: it's only on the device's screen.
 */
async function sendApproval(env: Env, email: string, device: string, code: string, link: string, origin: string): Promise<void> {
  const site = new URL(origin).host;
  const why = `You're getting this because someone entered this address in the terminus app (${site}, NUS shuttle bus times) on ${device}. If that wasn't you, ignore this email: nothing happens without the code.`;
  await env.EMAIL!.send({
    from: { email: env.EMAIL_FROM!, name: 'terminus' },
    to: email,
    subject: `Your terminus code: ${code}`,
    text: `Your terminus sign-in code is ${code}

Type it in terminus on ${device}. It works once and expires in 15 minutes. Never give it to anyone.

Reading this on another device? Open this link instead and choose the number ${device} is showing:
${link}

${why}`,
    html: `<p>Your terminus sign-in code is</p>
<p style="font-size:28px;font-weight:700;letter-spacing:4px;font-family:ui-monospace,Menlo,monospace">${code}</p>
<p>Type it in terminus on <strong>${escapeHtml(device)}</strong>. It works once and expires in 15 minutes. Never give it to anyone.</p>
<p>Reading this on another device? <a href="${link}">Open this link</a> instead and choose the number ${escapeHtml(device)} is showing.</p>
<p style="color:#666;font-size:13px">${escapeHtml(why)}</p>`,
  });
}

/**
 * The code from the email, typed into the app that asked. Right: the
 * request is approved (the caller then collects the token as a poll would).
 * Wrong five times, or for another request: it dies.
 */
export async function enterCode(db: D1Database, id: string, poll: string, code: string, nowMs: number): Promise<'approved' | 'wrong' | 'denied' | 'expired'> {
  const row = await db
    .prepare('SELECT poll_hash, code_hash, code_tries, status, expires FROM login_requests WHERE id = ?')
    .bind(id)
    .first<{ poll_hash: string; code_hash: string; code_tries: number; status: string; expires: number }>();
  if (!row || row.poll_hash !== (await hashToken(poll)) || row.expires < nowMs) return 'expired';
  if (row.status === 'approved') return 'approved';
  if (row.status === 'denied') return 'denied';
  // A blocked address was never sent a code: every guess is simply wrong.
  if (row.status !== 'pending' && row.status !== 'blocked') return 'expired';
  if (row.status === 'pending' && (await hashToken(code)) === row.code_hash) {
    const ok = await db.prepare("UPDATE login_requests SET status = 'approved' WHERE id = ? AND status = 'pending' RETURNING id").bind(id).first();
    return ok ? 'approved' : 'expired';
  }
  const dead = row.code_tries + 1 >= LOGIN_TTL.codeTries;
  await db
    .prepare(`UPDATE login_requests SET code_tries = code_tries + 1${dead ? ", status = 'denied'" : ''} WHERE id = ?`)
    .bind(id)
    .run();
  return dead ? 'denied' : 'wrong';
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export interface Approvable {
  device: string;
  created: number;
  /** Three numbers, the right one among them, in an order fixed per request. */
  choices: number[];
}

/**
 * What the approval page shows, without changing anything (mail scanners
 * open every link). Null when the link is unknown, used or expired.
 */
export async function approvable(db: D1Database, link: string, nowMs: number): Promise<Approvable | null> {
  const linkHash = await hashToken(link);
  const row = await db
    .prepare("SELECT match, device_name, created FROM login_requests WHERE link_hash = ? AND status = 'pending' AND expires >= ?")
    .bind(linkHash, nowMs)
    .first<{ match: number; device_name: string; created: number }>();
  if (!row) return null;
  return { device: row.device_name, created: row.created, choices: choicesFor(row.match, linkHash) };
}

/**
 * Two decoys from the link's hash, so a reload shows the same three numbers
 * in the same order: a page that reshuffled would look like a different request.
 */
export function choicesFor(match: number, seedHex: string): number[] {
  const seed = [...seedHex.matchAll(/../g)].map((m) => parseInt(m[0], 16));
  const out = [match];
  for (let i = 0; out.length < 3; i++) {
    const n = 10 + (((seed[i % seed.length] << 8) | seed[(i + 1) % seed.length]) + i) % 90;
    if (!out.includes(n)) out.push(n);
  }
  const at = seed[seed.length - 1] % 3;
  [out[0], out[at]] = [out[at], out[0]];
  return out;
}

/**
 * The approver's choice. The right number approves; a wrong number, or
 * "this wasn't me" (null), kills the request. Works once.
 */
export async function decide(db: D1Database, link: string, picked: number | null, nowMs: number): Promise<'approved' | 'denied' | 'expired'> {
  const row = await db
    .prepare(
      `UPDATE login_requests SET status = CASE WHEN match = ? THEN 'approved' ELSE 'denied' END
        WHERE link_hash = ? AND status = 'pending' AND expires >= ? RETURNING status, device_name`,
    )
    .bind(picked ?? -1, await hashToken(link), nowMs)
    .first<{ status: 'approved' | 'denied' }>();
  return row?.status ?? 'expired';
}

/** How a finished sign-in left the accounts. */
export type Outcome =
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
      outcome: Outcome;
      userId: string;
      device: string;
      /** The anonymous account this sign-in deleted, if any. */
      removed?: string;
    };

/** A profile worth keeping: somewhere to go or somewhere to start. */
export function hasSetup(json: unknown): boolean {
  const p = json as { home?: { stops?: unknown[] } | null; trips?: unknown[]; manual?: unknown[]; places?: unknown[] } | null;
  if (!p) return false;
  return Boolean(p.home?.stops?.length || p.trips?.length || p.manual?.length || p.places?.length);
}

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

  // Spent here, so two racing polls can't both be handed a token.
  const req = await db
    .prepare("UPDATE login_requests SET status = 'done' WHERE id = ? AND status = 'approved' RETURNING email, device_name, anon_user_id, platform")
    .bind(id)
    .first<{ email: string; device_name: string; anon_user_id: string | null; platform: Client['platform'] }>();
  if (!req) return { status: 'expired' };
  // The platform the app named when it started, if this poll doesn't say.
  if (!client.platform) client = { ...client, platform: req.platform };

  const existing = await db.prepare('SELECT id, email FROM users WHERE email = ?').bind(req.email).first<User>();
  const anon = req.anon_user_id
    ? await db.prepare('SELECT id FROM users WHERE id = ? AND email IS NULL').bind(req.anon_user_id).first<{ id: string }>()
    : null;

  let userId: string;
  let outcome: Outcome;
  if (!existing && anon) {
    await db.prepare('UPDATE users SET email = ?, email_added = ? WHERE id = ? AND email IS NULL').bind(req.email, nowMs, anon.id).run();
    // The device's old anonymous token is replaced by the one returned here.
    await db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(anon.id).run();
    userId = anon.id;
    outcome = 'added-email';
  } else if (!existing) {
    userId = (await ensureUser(db, req.email, nowMs, 'app')).id;
    outcome = 'created';
  } else {
    userId = existing.id;
    outcome = 'signed-in';
    if (anon) {
      const mine = await loadProfileJson(db, anon.id);
      if (!hasSetup(mine)) {
        await removeAnonymous(db, anon.id, userId);
      } else if (!hasSetup(await loadProfileJson(db, userId))) {
        await saveProfileJson(db, userId, mine, nowMs);
        await removeAnonymous(db, anon.id, userId);
        outcome = 'moved-setup';
      } else {
        // Kept until the app says which setup wins.
        outcome = 'choose';
      }
    }
  }
  const token = await openSession(db, userId, 'device', req.device_name, nowMs, client);
  const removed = anon && (outcome === 'signed-in' || outcome === 'moved-setup') ? anon.id : undefined;
  return { status: 'approved', token, email: req.email, outcome, userId, device: req.device_name, removed };
}

/** Deletes an anonymous account once it's been signed in elsewhere; its reports move with it. */
async function removeAnonymous(db: D1Database, anonId: string, intoUserId: string): Promise<void> {
  await db.batch([
    db.prepare('UPDATE feedback SET user_id = ? WHERE user_id = ?').bind(intoUserId, anonId),
    db.prepare('DELETE FROM users WHERE id = ? AND email IS NULL').bind(anonId),
  ]);
}

/**
 * After an 'choose' outcome: keep the account's setup, or replace it with
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
  if (keep === 'device') {
    const mine = await loadProfileJson(db, anon.id);
    if (mine) await saveProfileJson(db, userId, mine, nowMs);
  }
  await removeAnonymous(db, anon.id, userId);
  return { removed: anon.id };
}
