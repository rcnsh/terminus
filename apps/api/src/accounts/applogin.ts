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
  cooldownMs: ACCOUNT_TTL.linkCooldownMs,
  codeTries: ACCOUNT_TTL.codeTries,
  heldMs: 6 * 3_600_000,
} as const;

const heldKey = async (email: string) => `held:${await hashToken(inboxKey(email))}`;

export async function holdAppLogins(env: Env, email: string): Promise<void> {
  await env.KV.put(await heldKey(email), '1', { expirationTtl: LOGIN_TTL.heldMs / 1000 }).catch(() => {});
}

export interface StartInput {
  email: string;
  name: string;
  client: Client;
  anonUserId: string | null;
}

export interface Started {
  request: string;
  poll: string;
  match: number;
  expires: number;
}

function randomMatch(): number {
  return 10 + (crypto.getRandomValues(new Uint32Array(1))[0] % 90);
}

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
  if (!blocked && !(await mailBudgetLeft(env, inbox, nowMs))) return 'cooldown';
  if (!(await takeGlobalMail(env, 'app'))) return 'busy';
  if (!blocked && !(await takeMailBudget(env, inbox, nowMs))) return 'cooldown';

  const id = crypto.randomUUID();
  const poll = newToken();
  const link = newToken();
  const code = newEmailCode();
  const match = randomMatch();
  const expires = nowMs + LOGIN_TTL.requestMs;
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
      await db.prepare('DELETE FROM login_requests WHERE id = ?').bind(id).run();
      throw err;
    }
  }
  await env.KV.put(coolKey, '1', { expirationTtl: Math.max(60, LOGIN_TTL.cooldownMs / 1000) }).catch(() => {});
  return { request: id, poll, match, expires };
}

export function mailDevice(name: string): string {
  const words = name.trim().split(/\s+/);
  const n = words.findIndex((w) => /\d/.test(w));
  return (n < 0 ? words : words.slice(0, n)).join(' ');
}

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
  if (row.status !== 'pending' && row.status !== 'blocked') return 'expired';
  if (!(await codesLeft(env, row.email, nowMs))) return 'locked';
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

export async function approvable(db: D1Database, link: string, nowMs: number): Promise<Approvable | null> {
  const linkHash = await hashToken(link);
  const row = await db
    .prepare("SELECT device_name, created FROM login_requests WHERE link_hash = ? AND status = 'pending' AND expires >= ?")
    .bind(linkHash, nowMs)
    .first<{ device_name: string; created: number }>();
  if (!row) return null;
  return { device: row.device_name, created: row.created };
}

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

export type SignInOutcome = 'created' | 'added-email' | 'signed-in' | 'moved-setup' | 'choose';

export type PollResult =
  | { status: 'pending' | 'denied' | 'expired' }
  | {
      status: 'approved';
      token: string;
      email: string;
      outcome: SignInOutcome;
      userId: string;
      device: string;
      removed?: string;
    };

export async function pollAppLogin(db: D1Database, id: string, poll: string, client: Client, nowMs: number): Promise<PollResult> {
  const row = await db
    .prepare('SELECT poll_hash, status, expires FROM login_requests WHERE id = ?')
    .bind(id)
    .first<{ poll_hash: string; status: string; expires: number }>();
  if (!row || row.poll_hash !== (await hashToken(poll)) || row.expires < nowMs) return { status: 'expired' };
  if (row.status === 'pending' || row.status === 'blocked') return { status: 'pending' };
  if (row.status !== 'approved') return { status: row.status === 'denied' ? 'denied' : 'expired' };

  const req = await db
    .prepare("SELECT email, device_name, anon_user_id, platform FROM login_requests WHERE id = ? AND status = 'approved'")
    .bind(id)
    .first<{ email: string; device_name: string; anon_user_id: string | null; platform: Client['platform'] }>();
  if (!req) return { status: 'expired' };
  if (!client.platform) client = { ...client, platform: req.platform };

  const existing = await db.prepare('SELECT id, email FROM users WHERE email = ?').bind(req.email).first<User>();
  const anon = req.anon_user_id
    ? await db.prepare('SELECT id FROM users WHERE id = ? AND email IS NULL').bind(req.anon_user_id).first<{ id: string }>()
    : null;

  const live: Live = { sql: "EXISTS (SELECT 1 FROM login_requests WHERE id = ? AND status = 'approved')", params: [id] };
  const work: D1PreparedStatement[] = [];
  let outcome: SignInOutcome;
  if (!existing && anon) {
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
    console.error('app sign-in: could not finish, left for the next poll:', err instanceof Error ? err.message : String(err));
    return { status: 'pending' };
  }
  const userId = (out.at(-2)?.results?.[0] as { user_id: string } | undefined)?.user_id;
  if (!userId || !out.at(-1)?.results?.length) return { status: 'pending' };
  const removed = anon && (outcome === 'signed-in' || outcome === 'moved-setup') ? anon.id : undefined;
  return { status: 'approved', token, email: req.email, outcome, userId, device: req.device_name, removed };
}

export async function mergeAnonymous(
  db: D1Database,
  userId: string,
  anonToken: string,
  keep: 'account' | 'device',
  nowMs: number,
): Promise<{ removed: string } | 'not-anonymous'> {
  const anon = await db
    .prepare('SELECT u.id FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND u.email IS NULL AND s.paired = 0')
    .bind(await hashToken(anonToken))
    .first<{ id: string }>();
  if (!anon || anon.id === userId) return 'not-anonymous';
  const mine = keep === 'device' ? await loadProfileJson(db, anon.id) : null;
  await removeAnonymous(db, anon.id, userId, mine ? [profileUpsert(db, userId, mine, nowMs)] : []);
  return { removed: anon.id };
}
