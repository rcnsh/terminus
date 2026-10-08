/**
 * The suggestions drawn from how trips went (outcomes.ts): exactly when
 * "leave one bus earlier" and "stop reminders" are offered, and when not.
 * Straight against tripPrefs() on the real migrations, at a fixed clock.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { makeD1 } from './_d1.mjs';
import { tripPrefs } from '../src/outcomes.ts';
import { sgtDate } from '../src/trip.ts';

const NOW = Date.parse('2026-08-27T01:00:00Z'); // Thursday 09:00 in Singapore
const DAY = 86_400_000;
const USER = 'u1';
const KEY = '4:600:UTOWN';
const labelOf = (key) => (key === KEY ? 'GEA1000 @ UTown' : null);

function setup(rows) {
  const db = makeD1();
  db._db.prepare("INSERT INTO users (id, email, created, last_seen) VALUES (?, 'a@u.nus.edu', 0, 0)").run(USER);
  for (const [daysAgo, outcome] of rows) {
    const at = NOW - daysAgo * DAY;
    db._db.prepare('INSERT INTO trip_outcomes (user_id, trip_key, day, outcome, at) VALUES (?, ?, ?, ?, ?)').run(USER, KEY, sgtDate(at), outcome, at);
  }
  return db;
}
const suggestion = async (db) => (await tripPrefs(db, USER, NOW, labelOf)).suggestion;

test('three misses in 30 days suggest a bus earlier; two do not', async () => {
  assert.equal((await suggestion(setup([[7, 'missed'], [14, 'missed'], [21, 'missed']]))).id, `earlier:${KEY}`);
  assert.equal(await suggestion(setup([[7, 'missed'], [14, 'missed']])), null);
});

test('a miss older than 30 days does not count toward the three', async () => {
  // Still kept (35 days), but outside the month the count looks at.
  assert.equal(await suggestion(setup([[7, 'missed'], [14, 'missed'], [31, 'missed']])), null);
  assert.equal((await suggestion(setup([[7, 'missed'], [14, 'missed'], [29, 'missed']]))).id, `earlier:${KEY}`);
});

test('"Not going" is offered only when the last three were all skipped', async () => {
  assert.equal((await suggestion(setup([[7, 'skipped'], [14, 'skipped'], [21, 'skipped']]))).id, `quiet:${KEY}`);
  // Newest first: skipped, went, skipped. Not three in a row.
  assert.equal(await suggestion(setup([[7, 'skipped'], [14, 'boarded'], [21, 'skipped']])), null);
  assert.equal(await suggestion(setup([[7, 'skipped'], [14, 'skipped']])), null);
});

test('a turned-down "stop reminders" is not suggested again for 30 days', async () => {
  // Written as a row: turning it down through setPref() also clears the
  // skips, which would hide whether the dismissal itself is honoured.
  const dismissed = (db, at) => db._db.prepare("INSERT INTO trip_prefs (user_id, trip_key, pref, label, set_at) VALUES (?, ?, 'no-quiet', NULL, ?)").run(USER, KEY, at);
  const db = setup([[7, 'skipped'], [14, 'skipped'], [21, 'skipped']]);
  dismissed(db, NOW - DAY);
  assert.equal(await suggestion(db), null);
  const old = setup([[7, 'skipped'], [14, 'skipped'], [21, 'skipped']]);
  dismissed(old, NOW - 31 * DAY);
  assert.equal((await suggestion(old)).id, `quiet:${KEY}`);
});
