/**
 * Which bus a trip is about (plan.ts): the rules on their own, without the
 * API around them. The trip tests (trip.test.js) cover them end to end.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { SAME_BUS_MS, choosePlan, planOfLeave, sameBus } from '../src/plan.ts';
import { WAIT_EARLY_MS } from '../src/trip.ts';
import { reachedEarly } from '../src/profile.ts';
import { FROZEN_NOW, installGlobals, makeFetch } from './_stubs.mjs';

const NOW = Date.parse('2026-08-27T01:00:00Z'); // 09:00 SGT
const iso = (ms) => new Date(ms).toISOString();
const min = 60_000;
/** A plan: `board` minutes from now, leave two minutes before, arriving ten after. */
const bus = (board, extra = {}) => ({
  svc: 'D2',
  stop: 'PGP',
  stopCode: 'PGP',
  board: iso(NOW + board * min),
  leave: iso(NOW + (board - 2) * min),
  arrive: iso(NOW + (board + 10) * min),
  alightCode: 'UTOWN',
  ...extra,
});
const CLASS_AT = NOW + 40 * min;
const choose = (x) => choosePlan({ located: true, classAtMs: CLASS_AT, nowMs: NOW, ...x });

test('a leave-by becomes a plan; a walk is none', () => {
  const l = { at: iso(NOW), estimated: true, svc: 'D2', stop: 'PGP', board: iso(NOW + 2 * min), arrive: iso(NOW + 12 * min), note: 'packed', stopCode: 'PGP' };
  assert.deepEqual(planOfLeave(l, true, 'UTOWN'), {
    svc: 'D2', stop: 'PGP', board: l.board, leave: l.at, located: true, arrive: l.arrive, note: 'packed', estimated: true, stopCode: 'PGP', alightCode: 'UTOWN',
  });
  assert.equal(planOfLeave({ ...l, svc: null, board: null }, true, 'UTOWN'), null);
  assert.equal(planOfLeave(null, true, 'UTOWN'), null);
});

test('the same bus: same service and stop, within a few minutes', () => {
  assert.ok(sameBus(bus(10), bus(10, { board: iso(NOW + 10 * min + SAME_BUS_MS) })));
  assert.ok(!sameBus(bus(10), bus(10, { board: iso(NOW + 10 * min + SAME_BUS_MS + 1) })));
  assert.ok(!sameBus(bus(10), bus(10, { svc: 'R2' })));
  assert.ok(!sameBus(bus(10), bus(10, { stopCode: 'PGPR' })));
  assert.ok(!sameBus(undefined, bus(10)));
});

test('the first plan is saved; the same bus again is not', () => {
  assert.deepEqual(choose({ stored: undefined, made: bus(30) }), { bus: bus(30), save: true });
  const again = bus(30, { board: iso(NOW + 30 * min + 40_000) });
  assert.deepEqual(choose({ stored: bus(30, { located: true }), made: again }), { bus: again, save: false });
});

test('the same bus is saved again when its times become live', () => {
  const r = choose({ stored: bus(30, { located: true, estimated: true }), made: bus(30) });
  assert.equal(r.save, true);
});

test('from its leave-by the plan is frozen, whatever the answer says', () => {
  const stored = bus(1, { located: true }); // left to leave a minute ago
  assert.deepEqual(choose({ stored, made: bus(12, { svc: 'R2' }) }), { bus: stored, save: false });
  assert.deepEqual(choose({ stored, made: null, located: false }), { bus: stored, save: false });
});

test("without a location, the phone's plan is shown, not the device's own", () => {
  const stored = bus(30, { located: true });
  assert.deepEqual(choose({ stored, made: bus(25, { svc: 'R2' }), located: false }), { bus: stored, save: false });
  // That same bus in this answer, its time moved on since: this answer's times, the plan unchanged.
  const same = bus(32);
  assert.deepEqual(choose({ stored, made: same, located: false }), { bus: same, save: false });
  // A plan made without a location is replaced by one with.
  assert.deepEqual(choose({ stored: bus(30), made: bus(25, { svc: 'R2' }) }), { bus: bus(25, { svc: 'R2' }), save: true });
});

test('at the stop, the bus you were told stays while it still gets you there in time', () => {
  const stored = bus(10, { located: true }); // leave-by in 8 minutes: within the window
  assert.ok(NOW >= Date.parse(stored.leave) - WAIT_EARLY_MS);
  const other = bus(14, { svc: 'R2' });
  assert.deepEqual(choose({ stored, made: other }), { bus: stored, save: false });
  // It would make you late: the other one.
  assert.deepEqual(choose({ stored, made: other, classAtMs: NOW + 15 * min }), { bus: other, save: true });
  // Too early to be at the stop for it: the answer's bus.
  assert.deepEqual(choose({ stored: bus(25, { located: true }), made: other }), { bus: other, save: true });
  // A trip home has no class to be late for: the answer's bus.
  assert.deepEqual(choose({ stored, made: other, classAtMs: null }), { bus: other, save: true });
});

test('a class reached before it starts is where you are', () => {
  installGlobals(makeFetch({}));
  const cls = (arriveByMin, to) => ({ day: 4, arriveByMin, endMin: arriveByMin + 60, to, label: to, venue: '' });
  const profile = { home: { stops: ['PGP'] }, places: [], usual: [], once: [], trips: [], manual: [cls(600, 'UTOWN'), cls(720, 'COM3')] };
  const done = new Set(['4:600:UTOWN']);
  assert.equal(reachedEarly(profile, FROZEN_NOW, done)?.to, 'UTOWN', 'at 09:00, before 10:00');
  assert.equal(reachedEarly(profile, FROZEN_NOW + 61 * min, done), null, 'once it has started, no');
  assert.equal(reachedEarly(profile, FROZEN_NOW, new Set()), null, 'not reached');
});
