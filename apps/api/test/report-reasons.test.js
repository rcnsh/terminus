/**
 * Which "Is this wrong?" reasons a card offers (card.ts reasonsOf), on the
 * real answers in fixtures/answers: a reason only about something the card
 * has, a bus to come or be late, a stop, a walk.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { REPORT_REASONS, reasonsOf } from '../src/answer/card.ts';
import { REASONS } from '../src/ops/feedback.ts';

const answer = (name) => JSON.parse(fs.readFileSync(new URL(`../../../fixtures/answers/${name}.json`, import.meta.url), 'utf8'));
const reasons = (name) => {
  const a = answer(name);
  return reasonsOf(a, a.card.kind, a.card.journey, a.card.phase);
};
const ALL = [...REPORT_REASONS];
const WALK = ['walk-longer', 'wrong-class'];

test('the card offers the reasons the feedback endpoint takes, in its order', () => {
  assert.deepEqual(ALL, Object.keys(REASONS));
});

test('a bus to catch, from a leave-by, a trip or Nearby, offers every reason', () => {
  for (const name of ['class-bus', 'public-wins', 'bus-gone']) assert.deepEqual(reasons(name), ALL, name);
});

test('on the bus, its times or its stop can be off, but it did come', () => {
  for (const name of ['riding', 'riding-live', 'change-riding'])
    assert.deepEqual(reasons(name), ['times-off', 'wrong-stop', ...WALK], name);
});

test('on foot (a walk, no bus left), the bus it was weighed against can be off, but there was none to come', () => {
  for (const name of ['class-walk', 'heat-walk', 'after-last-bus']) assert.deepEqual(reasons(name), ['times-off', ...WALK], name);
});

test('with no trip (a day that is done, a free day, there already, not set up), only the class can be wrong', () => {
  for (const name of ['rest', 'free', 'arrived', 'setup']) assert.deepEqual(reasons(name), ['wrong-class'], name);
});

test('every golden card carries the reasons that fit it', () => {
  for (const file of fs.readdirSync(new URL('../../../fixtures/answers/', import.meta.url)).filter((f) => f.endsWith('.json'))) {
    const name = file.slice(0, -5);
    const a = answer(name);
    if (a.card) assert.deepEqual(a.card.reasons, reasons(name), name);
  }
});
