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
      if (st.columns().length) return { results: st.all(...params).map((r) => ({ ...r })), success: true, meta: { changes: 0 } };
      const r = st.run(...params);
      return { success: true, meta: { changes: Number(r.changes) } };
    },
  });

  return {
    _db: db,
    prepare: (sql) => statement(sql),
    async batch(stmts) {
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
      const m = /sign-in code is ([A-Z0-9]{6})/.exec(sent.at(-1)?.text ?? '');
      return m ? m[1] : null;
    },
  };
}
