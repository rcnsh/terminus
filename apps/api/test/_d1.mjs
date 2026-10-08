/**
 * D1 on top of node:sqlite, so the account tests run the real migration SQL
 * with no network. Covers the subset of the D1 API the Worker uses:
 * prepare().bind().first()/all()/run() and batch().
 */

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';

const MIGRATIONS = new URL('../migrations/', import.meta.url);

export function makeD1() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  for (const f of readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql')).sort()) {
    db.exec(readFileSync(new URL(f, MIGRATIONS), 'utf8'));
  }

  const statement = (sql, params = []) => ({
    bind: (...p) => statement(sql, p),
    async first(col) {
      const row = db.prepare(sql).get(...params);
      if (row === undefined) return null;
      const plain = { ...row };
      return col ? plain[col] : plain;
    },
    async all() {
      return { results: db.prepare(sql).all(...params).map((r) => ({ ...r })), success: true };
    },
    async run() {
      // Like D1: a statement that returns rows gives them back, in batch() too.
      const st = db.prepare(sql);
      if (st.columns().length) {
        const results = st.all(...params).map((r) => ({ ...r }));
        // D1 counts the rows an UPDATE/DELETE ... RETURNING changed; a plain
        // SELECT changes none (changes() would still hold the last write's count).
        const writes = /^\s*(?:INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql);
        const changes = writes ? Number(db.prepare('SELECT changes() AS n').get().n) : 0;
        return { results, success: true, meta: { changes } };
      }
      const r = st.run(...params);
      return { success: true, meta: { changes: Number(r.changes) } };
    },
  });

  // D1 runs each batch whole, one at a time: two in flight at once (a
  // session's touch left to waitUntil, and the request's own) queue here
  // rather than nest their transactions.
  let batches = Promise.resolve();
  return {
    _db: db,
    prepare: (sql) => statement(sql),
    batch(stmts) {
      const run = batches.then(async () => {
        db.exec('BEGIN');
        try {
          const out = [];
          for (const s of stmts) out.push(await s.run());
          db.exec('COMMIT');
          return out;
        } catch (err) {
          db.exec('ROLLBACK');
          throw err;
        }
      });
      batches = run.catch(() => {});
      return run;
    },
    /** Test helper: run SQL directly. */
    exec: (sql) => db.exec(sql),
  };
}

/** Records sign-in emails instead of sending them. */
export function makeEmail() {
  const sent = [];
  return {
    sent,
    async send(msg) {
      sent.push(msg);
      return { messageId: `stub-${sent.length}` };
    },
    /** The token from the most recent sign-in link. */
    lastToken() {
      const m = /\/auth\/verify\?t=([A-Za-z0-9_-]+)/.exec(sent.at(-1)?.text ?? '');
      return m ? m[1] : null;
    },
    /** The code from the most recent sign-in email. */
    lastCode() {
      // English or Chinese ("登录验证码是 X").
      const m = /(?:sign-in code is|登录验证码是) ([A-Z0-9]{6})/.exec(sent.at(-1)?.text ?? '');
      return m ? m[1] : null;
    },
  };
}
