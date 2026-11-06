/**
 * A signal applied to the day (applySignal in trip.ts): the record "On it",
 * "Missed it", "Not going", "I'm there" or undo leaves for the trip, and the
 * outcome it records. No HTTP, no feed: the plate lookup is passed in.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { applySignal } from '../src/answer/trip.ts';
import { GRAPH, GRAPH_PUBLIC } from '../src/answer/graph.ts';

const NOW = Date.parse('2026-08-27T01:00:00Z'); // Thursday 09:00 in Singapore
const iso = (min) => new Date(NOW + min * 60_000).toISOString().replace('.000Z', 'Z');
const THU = 4;
const KEY = `${THU}:600:UTOWN`;
const PROFILE = {
  home: { stops: ['PGP'] },
  trips: [],
  manual: [{ day: THU, arriveByMin: 600, endMin: 660, to: 'UTOWN', label: 'GEA1000 @ UTown', venue: '' }],
  places: [],
  once: [],
};

/** The D2 from PGP to UTown in 4 minutes, as the answer planned before the signal. */
const leave = {
  at: iso(1),
  estimated: false,
  svc: 'D2',
  stop: 'Prince George’s Park',
  board: iso(4),
  arrive: iso(14),
  stopCode: 'PGP',
  toCode: 'UTOWN',
};
const planned = (over = {}, trip = {}) => ({
  answer: { leave, dest: { to: 'UTOWN', label: 'GEA1000 @ UTown', why: 'class' }, ...over },
  trip: { key: KEY, phase: 'waiting', ...trip },
});

/** A plate lookup that records what it was asked. */
function plates(answer = {}) {
  const asked = [];
  const lookup = async (stopCode, svc, graph) => {
    asked.push({ stopCode, svc, graph });
    return answer;
  };
  return { asked, lookup };
}

test('"On it" records the bus pulling in, its plate, with the times moved to when it is due', async () => {
  const { asked, lookup } = plates({ plate: 'PA1234A', at: iso(6) });
  const { rec, outcome } = await applySignal('boarded', KEY, planned(), null, PROFILE, NOW, lookup);
  assert.deepEqual(asked, [{ stopCode: 'PGP', svc: 'D2', graph: GRAPH }]);
  assert.equal(outcome, 'boarded');
  assert.equal(rec.kind, 'boarded');
  assert.equal(rec.label, 'GEA1000 @ UTown');
  assert.deepEqual(rec.boarded, {
    svc: 'D2',
    stop: 'Prince George’s Park',
    board: iso(6),
    arrive: iso(16),
    stopCode: 'PGP',
    alightCode: 'UTOWN',
    plate: 'PA1234A',
  });
});

test('"On it" with no plate keeps the planned times', async () => {
  const { rec } = await applySignal('boarded', KEY, planned(), null, PROFILE, NOW, plates().lookup);
  assert.equal(rec.boarded.board, iso(4));
  assert.equal(rec.boarded.arrive, iso(14));
  assert.equal(rec.boarded.plate, undefined);
});

test('a public bus is looked up on its own route and graph, and recorded as paid', async () => {
  const { asked, lookup } = plates();
  const paid = planned({ leave: { ...leave, svc: '95', paid: true, route: '95/1' } });
  const { rec } = await applySignal('boarded', KEY, paid, null, PROFILE, NOW, lookup);
  assert.deepEqual(asked, [{ stopCode: 'PGP', svc: '95/1', graph: GRAPH_PUBLIC }]);
  assert.equal(rec.boarded.paid, true);
  assert.equal(rec.boarded.route, '95/1');
});

test('after the planned bus has left, "On it" and "Missed it" are about that bus, not the next one', async () => {
  const plan = {
    svc: 'R2',
    stop: 'Prince George’s Park',
    board: iso(0.5),
    arrive: iso(12),
    at: iso(-3),
    stopCode: 'PGP',
    alightCode: 'UTOWN',
  };
  const now = planned({}, { plan });
  const { rec } = await applySignal('boarded', KEY, now, null, PROFILE, NOW, plates().lookup);
  assert.equal(rec.boarded.svc, 'R2');
  assert.equal(rec.boarded.board, iso(0.5));
  const missed = await applySignal('missed', KEY, now, null, PROFILE, NOW, plates().lookup);
  assert.deepEqual(missed, { rec: { kind: 'missed', at: NOW, label: 'GEA1000 @ UTown', missed: iso(0.5) }, outcome: 'missed' });
});

test('"On it" with no bus to be on (a walk) means you have set off', async () => {
  const { asked, lookup } = plates();
  const walk = planned({ leave: { ...leave, svc: null, stop: null, board: null } });
  const { rec, outcome } = await applySignal('boarded', KEY, walk, null, PROFILE, NOW, lookup);
  assert.deepEqual(rec, { kind: 'left', at: NOW, label: 'GEA1000 @ UTown' });
  assert.equal(outcome, 'boarded');
  assert.deepEqual(asked, [], 'no feed read');
});

test('"On it" again while on the first bus of a change keeps that bus', async () => {
  const was = {
    kind: 'boarded',
    at: NOW - 60_000,
    boarded: { svc: 'D2', stop: 'PGP', board: iso(-1), arrive: iso(5), change: { svc: 'A1' } },
  };
  const day = { date: '2026-08-27', trips: { [KEY]: was } };
  const now = planned({}, { phase: 'riding', rec: was });
  const { rec } = await applySignal('boarded', KEY, now, day, PROFILE, NOW, plates().lookup);
  assert.equal(rec, was);
});

test('a signal about another of the day’s trips is named from the timetable and has no bus', async () => {
  const other = planned({}, { key: 'home:660' });
  const { rec } = await applySignal('boarded', KEY, other, null, PROFILE, NOW, plates().lookup);
  assert.deepEqual(rec, { kind: 'left', at: NOW, label: 'GEA1000 @ UTown' });
});

test('undo forgets the record and the outcome; a trip home records none', async () => {
  const { asked, lookup } = plates();
  assert.deepEqual(await applySignal('reset', KEY, planned(), null, PROFILE, NOW, lookup), { rec: null, outcome: 'clear' });
  const home = planned({}, { key: 'home:660' });
  assert.deepEqual(await applySignal('reset', 'home:660', home, null, PROFILE, NOW, lookup), { rec: null, outcome: 'clear' });
  const skipped = await applySignal('skipped', 'home:660', home, null, PROFILE, NOW, lookup);
  assert.equal(skipped.rec.kind, 'skipped');
  assert.equal(skipped.outcome, null, 'nothing to learn from skipping a trip home');
  assert.equal((await applySignal('skipped', KEY, planned(), null, PROFILE, NOW, lookup)).outcome, 'skipped');
  assert.equal((await applySignal('arrived', KEY, planned(), null, PROFILE, NOW, lookup)).outcome, 'arrived');
  assert.deepEqual(asked, [], 'only "On it" reads the feed');
});

/** K from PGP to Kent Vale, then P on to UTown: the second bus as a leave-by's change. */
const TO_KV = { svc: 'P', from: 'Kent Vale', fromCode: 'KV', stop: 'Kent Vale', stopCode: 'KV', rideS: 600, estimated: false };

test('"On it" on a trip that changes buses moves the second bus by how late the first is', async () => {
  const two = planned({
    leave: { ...leave, svc: 'K', arrive: iso(30), change: { ...TO_KV, reach: iso(12), board: iso(15) } },
  });
  // The K pulling in 6 minutes after the plan's: at Kent Vale at 18, after the planned P at 15.
  const { asked, lookup } = plates({ plate: 'PA1234A', at: iso(10) });
  const { rec, outcome } = await applySignal('boarded', KEY, two, null, PROFILE, NOW, lookup);
  assert.deepEqual(asked, [{ stopCode: 'PGP', svc: 'K', graph: GRAPH }]);
  assert.equal(outcome, 'boarded');
  assert.deepEqual(rec.boarded, {
    svc: 'K',
    stop: 'Prince George’s Park',
    board: iso(10),
    arrive: iso(18),
    stopCode: 'PGP',
    alightCode: 'KV',
    plate: 'PA1234A',
    change: {
      svc: 'P',
      stop: 'Kent Vale',
      board: iso(18),
      arrive: iso(33),
      stopCode: 'KV',
      rideS: 600,
      alightCode: 'UTOWN',
      estimated: true,
    },
  });
});

test('after the planned bus of a trip that changes buses has left, "On it" is about that plan, both buses', async () => {
  const plan = {
    svc: 'K',
    stop: 'Prince George’s Park',
    board: iso(0.5),
    arrive: iso(9),
    leave: iso(-3),
    stopCode: 'PGP',
    alightCode: 'KV',
    change: { svc: 'P', stop: 'Kent Vale', board: iso(12), arrive: iso(25), stopCode: 'KV', rideS: 600, alightCode: 'UTOWN' },
  };
  // The answer has moved on to the next D2; the K that pulls in is 3½ minutes after the plan's.
  const { asked, lookup } = plates({ plate: 'PA1234A', at: iso(4) });
  const { rec } = await applySignal('boarded', KEY, planned({}, { plan }), null, PROFILE, NOW, lookup);
  assert.deepEqual(asked, [{ stopCode: 'PGP', svc: 'K', graph: GRAPH }]);
  assert.deepEqual(rec.boarded, {
    svc: 'K',
    stop: 'Prince George’s Park',
    board: iso(4),
    arrive: iso(12.5),
    stopCode: 'PGP',
    alightCode: 'KV',
    plate: 'PA1234A',
    change: {
      svc: 'P',
      stop: 'Kent Vale',
      board: iso(12.5),
      arrive: iso(25.5),
      stopCode: 'KV',
      rideS: 600,
      alightCode: 'UTOWN',
      estimated: true,
    },
  });
});
