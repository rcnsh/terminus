/**
 * Faults that must cost only what they touch: Turnstile's own error, a push
 * address the export can't read, a metric that won't write, or a trip's
 * state that can't be read. Each is logged or reported
 * as itself, and never takes the request down with it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { makeD1 } from './_d1.mjs';
import { checkTurnstile, exportAccount } from '../src/accounts.ts';
import { logAnswer, logCronError, logError, logPoll } from '../src/analytics.ts';
import { loadDay } from '../src/trip.ts';

const NOW = Date.parse('2026-08-27T01:00:00Z');

/** Runs fn with console.error captured. */
async function logged(fn) {
  const lines = [];
  const err = console.error;
  console.error = (...a) => lines.push(a.map(String).join(' '));
  try {
    return { value: await fn(), lines };
  } finally {
    console.error = err;
  }
}

test("Turnstile's own internal error, even in a 200, is 'unavailable', not the visitor failing", async () => {
  const env = { TURNSTILE_SECRET: 's', TURNSTILE_SITE_KEY: 'site', TURNSTILE_HOSTNAMES: 'terminus.run' };
  const { value, lines } = await logged(() => checkTurnstile(env, 'visitor-token-7', null, async () => Response.json({ success: false, 'error-codes': ['internal-error'] })));
  assert.equal(value, 'unavailable');
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^Turnstile siteverify failed: 200 internal-error/);
  assert.ok(!lines[0].includes('visitor-token-7'));
});

test("a wrong secret is ours, so 'unavailable' and logged; hostnames unset refuse every pass", async () => {
  const env = { TURNSTILE_SECRET: 's', TURNSTILE_SITE_KEY: 'site', TURNSTILE_HOSTNAMES: 'terminus.run' };
  const wrong = await logged(() => checkTurnstile(env, 'visitor-token-7', null, async () => Response.json({ success: false, 'error-codes': ['invalid-input-secret'] })));
  assert.equal(wrong.value, 'unavailable');
  assert.match(wrong.lines[0], /^Turnstile siteverify failed: 200 invalid-input-secret/);
  const pass = async () => Response.json({ success: true, action: 'signin', hostname: 'terminus.run' });
  assert.equal(await checkTurnstile(env, 'visitor-token-7', null, pass), 'ok');
  const unset = await logged(() => checkTurnstile({ ...env, TURNSTILE_HOSTNAMES: '' }, 'visitor-token-7', null, pass));
  assert.equal(unset.value, 'failed');
  assert.match(unset.lines[0], /TURNSTILE_HOSTNAMES is not/);
});

test('the export shows a web push address it cannot parse as it is, rather than failing', async () => {
  const db = makeD1();
  db._db.prepare("INSERT INTO users (id, email, created, last_seen) VALUES ('u1', 'a@u.nus.edu', 0, 0)").run();
  const insert = db._db.prepare("INSERT INTO sessions (token_hash, user_id, kind, name, created, last_seen, push_token) VALUES (?, 'u1', 'device', ?, 0, 0, ?)");
  insert.run('h1', 'Broken', 'web:{"endpoint":');
  insert.run('h2', 'Browser', 'web:{"endpoint":"https://push.example.test/x"}');
  insert.run('h3', 'Pixel', 'fcm-token');
  const out = await exportAccount(db, { id: 'u1', email: 'a@u.nus.edu' });
  const byName = Object.fromEntries(out.sessions.map((d) => [d.name, d.push]));
  assert.deepEqual(byName.Broken, { service: 'web', address: '{"endpoint":' });
  assert.deepEqual(byName.Browser, { service: 'web', address: { endpoint: 'https://push.example.test/x' } });
  assert.deepEqual(byName.Pixel, { service: 'firebase', address: 'fcm-token' });
});

test('an analytics write that throws is swallowed by every logger', () => {
  let tries = 0;
  const env = { AE: { writeDataPoint: () => (tries++, (() => { throw new Error('AE quota'); })()) } };
  const answer = { stop: { code: 'PGP', confidence: 1 }, quality: 'live', arrivals: [{ svc: 'D2', etaS: 60 }], label: 'x' };
  assert.doesNotThrow(() => logAnswer(env, { answer, best: null, dest: 'UTOWN', hadCoords: false, walkAllS: null }));
  assert.doesNotThrow(() => logError(env, '/api/me/devices/abc'));
  assert.doesNotThrow(() => logCronError(env, 'upstream'));
  assert.doesNotThrow(() => logPoll(env, 'upstream', 'D2', 3));
  assert.equal(tries, 4, 'each one tried to write');
});

test("a trip's state that can't be read is logged and the answer goes on without it", async () => {
  const env = { TRIPS: { idFromName: (n) => n, get: () => ({ fetch: async () => { throw new Error('storage reset'); } }) } };
  const { value, lines } = await logged(() => loadDay(env, 'u1', NOW));
  assert.equal(value, null);
  assert.deepEqual(lines, ['trip state unavailable Error']);
  const refusing = { TRIPS: { idFromName: (n) => n, get: () => ({ fetch: async () => new Response('overloaded', { status: 503 }) }) } };
  assert.equal(await loadDay(refusing, 'u1', NOW), null);
});
