/**
 * A trip's phase and when it next changes (phase.ts), through its interface:
 * a trip, a time, and the feed as fixtures.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { CHANGE_GRACE_MS, DUE_MS, RIDE_GRACE_MS, answerPhase, phaseOf, secondLeavesMs, shown, tripPhase } from '../src/answer/phase.ts';
import { planOfLeave } from '../src/answer/plan.ts';
import { laterChange, tripEnd } from '../src/answer/trip.ts';
import { LEAVE_GAP_MS, cardFor } from '../src/answer/card.ts';
import { GRAPH } from '../src/answer/graph.ts';
import { FROZEN_NOW } from './_stubs.mjs';
import { withoutMeasuredHeadways } from './_headways.mjs';

// Guessed times stand for a bus within a headway; the goldens' one headway keeps that fixed.
withoutMeasuredHeadways();

const MIN = 60_000;
const nowhere = { lat: null, lon: null };
const iso = (ms) => new Date(ms).toISOString().replace('.000Z', 'Z');

/**
 * The feed, as fixtures: the bus you're on's arrival by service, the second
 * bus as the feed has it, the next bus at your stop. `asked` lists each
 * lookup made.
 */
function fixtureFeed({ live = {}, second = null, next = null } = {}) {
  const asked = [];
  return {
    asked,
    look: {
      liveArrival: async (b) => (asked.push(`live ${b.svc}`), live[b.svc] ?? null),
      secondBus: async (b) => (asked.push(`second ${b.change.svc}`), second ? second(b.change) : { change: b.change, live: false }),
      nextArrival: async (b) => (asked.push(`next ${b.svc}`), next),
    },
  };
}

/** A trip with `answer` as its answer and `bus` its plan's bus. */
function tripOf(answer, { rec, bus = null, at = nowhere, home = null, classAtMs = null, fresh = answer } = {}) {
  return { at, rec, home, classAtMs, planned: async () => ({ fresh, answer, bus }) };
}

const phaseAt = async (trip, ms, look = fixtureFeed().look) => phaseOf((await tripPhase(trip, ms, look)).verdict);

const leaveAt = (ms) => ({ asOf: iso(FROZEN_NOW), stop: { code: 'PGP' }, leave: { at: iso(ms), svc: 'D2' }, arrived: false });

test('phases follow the clock until a signal says otherwise, and say when they next change', async () => {
  const now = FROZEN_NOW;
  const idle = leaveAt(now + 10 * MIN);
  assert.equal(await phaseAt(tripOf(idle), now), 'idle');
  assert.deepEqual((await tripPhase(tripOf(idle), now, fixtureFeed().look)).changesAt, { at: now + 10 * MIN - DUE_MS, leave: true });
  assert.equal(await phaseAt(tripOf(leaveAt(now + 4 * MIN)), now), 'due');
  assert.deepEqual((await tripPhase(tripOf(leaveAt(now + 4 * MIN)), now, fixtureFeed().look)).changesAt, {
    at: now + 4 * MIN,
    leave: true,
  });
  assert.equal(await phaseAt(tripOf(leaveAt(now - MIN)), now), 'heading');
  assert.equal((await tripPhase(tripOf(leaveAt(now - MIN)), now, fixtureFeed().look)).changesAt, null, 'heading, with no bus to leave');
  const pgp = GRAPH.stops.find((s) => s.code === 'PGP');
  assert.equal(await phaseAt(tripOf(idle, { at: { lat: pgp.lat, lon: pgp.lon } }), now), 'waiting', 'at the stop');
  assert.equal(await phaseAt(tripOf(leaveAt(now - MIN), { rec: { kind: 'boarded', at: now } }), now), 'riding');
  assert.equal(await phaseAt(tripOf(leaveAt(now - MIN), { rec: { kind: 'missed', at: now } }), now), 'missed');
  assert.equal(await phaseAt(tripOf({ ...leaveAt(now), arrived: true }), now), 'arrived');
});

test('a class trip is over LATE_GRACE_MIN after the class starts: the next trip is planned then', async () => {
  const now = FROZEN_NOW;
  const classAtMs = now + 20 * MIN;
  const { changesAt } = await tripPhase(tripOf(leaveAt(now - MIN), { classAtMs }), now, fixtureFeed().look);
  assert.equal(changesAt.at, classAtMs + 15 * MIN);
});

test('a leave-by sliding just ahead of now asks for a refetch no sooner than 30 s; the Trip object keeps the exact time', async () => {
  const { default: fixture } = await import('../../../fixtures/answers/class-bus.json', { with: { type: 'json' } });
  const { card: _card, refreshAt: _r, ...answer } = fixture;
  const now = Date.parse(answer.asOf);
  // A late bus: leave in 5 s, and the next fetch would say 5 s again.
  const sliding = { ...answer, leave: { ...answer.leave, at: iso(now + 5_000) } };
  const due = await answerPhase(sliding, undefined, nowhere, now);
  assert.equal(due.phase, 'due');
  assert.deepEqual(due.changesAt, { at: now + 5_000, leave: true });
  const card = cardFor(sliding, false, { key: 'k', phase: due.phase, changesAt: due.changesAt }, null, now);
  assert.equal(Date.parse(card.nextChangeAt), now + LEAVE_GAP_MS);
  // A leave-by further off is kept to the second.
  const later = { ...answer, leave: { ...answer.leave, at: iso(now + 90_000) } };
  const { phase, changesAt } = await answerPhase(later, undefined, nowhere, now);
  assert.equal(Date.parse(cardFor(later, false, { key: 'k', phase, changesAt }, null, now).nextChangeAt), now + 90_000);
});

/* On a bus: one, or two with a change (transfer.ts). */

/** A leave-by for K at PGP to Kent Vale, then P to College Green. */
const TWO_BUS_LEAVE = {
  at: '2026-08-27T01:17:40Z',
  estimated: false,
  svc: 'K',
  stop: 'PGP',
  stopCode: 'PGP',
  board: '2026-08-27T01:23:00Z',
  arrive: '2026-08-27T01:55:38Z',
  note: null,
  walkS: 300,
  rideS: 855,
  toStop: 'College Gr',
  toCode: 'CG',
  change: {
    svc: 'P',
    from: 'Kent Vale',
    fromCode: 'KV',
    stop: 'Kent Vale',
    stopCode: 'KV',
    reach: '2026-08-27T01:37:15Z',
    board: '2026-08-27T01:42:00Z',
    rideS: 818,
    estimated: false,
  },
};
const reach = Date.parse(TWO_BUS_LEAVE.change.reach);
const board = Date.parse(TWO_BUS_LEAVE.change.board);
const onTwo = (plan) => tripOf(leaveAt(FROZEN_NOW), { rec: { kind: 'boarded', at: FROZEN_NOW, boarded: plan } });
/** Where on the two buses: the first, the change stop, or the second. */
const stageAt = async (plan, ms, look) => {
  const { verdict } = await tripPhase(onTwo(plan), ms, look ?? fixtureFeed().look);
  return verdict.on === null ? 'there' : verdict.on.phase === 'waiting' ? 'change' : verdict.on.b.change ? 'first' : 'second';
};

test('a trip that changes buses is on the first bus, at the change, then on the second, and says when each comes', async () => {
  const plan = planOfLeave(TWO_BUS_LEAVE, true, 'CG');
  assert.equal(await stageAt(plan, reach - 1), 'first');
  assert.equal((await tripPhase(onTwo(plan), reach - MIN, fixtureFeed().look)).changesAt.at, reach);
  assert.equal(await stageAt(plan, reach), 'change');
  assert.equal((await tripPhase(onTwo(plan), reach, fixtureFeed().look)).changesAt.at, board + CHANGE_GRACE_MS);
  const late = fixtureFeed({ live: { K: iso(reach + 2 * MIN) } });
  assert.equal(await stageAt(plan, reach + MIN, late.look), 'first', 'the feed still has the first bus on its way');
  assert.equal((await tripPhase(onTwo(plan), reach + MIN, late.look)).changesAt.at, reach + 2 * MIN);
  assert.equal(await stageAt(plan, board + CHANGE_GRACE_MS - 1), 'change');
  assert.equal(await stageAt(plan, board + CHANGE_GRACE_MS), 'second');
  const end = Date.parse(tripEnd(plan));
  assert.equal((await tripPhase(onTwo(plan), board + CHANGE_GRACE_MS, fixtureFeed().look)).changesAt.at, end + RIDE_GRACE_MS);
  assert.equal(await stageAt(plan, end + RIDE_GRACE_MS), 'there');
});

test('a guessed second bus keeps you at the change for a headway, and a later one from the feed for as long as it is due', async () => {
  const plan = planOfLeave(TWO_BUS_LEAVE, true, 'CG');
  const guess = { ...plan, change: { ...plan.change, estimated: true } };
  const latest = secondLeavesMs(guess.change);
  assert.ok(latest > board + MIN, 'a guess leaves by a headway after it');
  assert.equal(await stageAt(guess, board + CHANGE_GRACE_MS), 'change');
  assert.equal(await stageAt(guess, latest + CHANGE_GRACE_MS - 1), 'change');
  assert.equal(await stageAt(guess, latest + CHANGE_GRACE_MS), 'second');
  const later = iso(board + 2 * MIN);
  const due = fixtureFeed({ second: (c) => ({ change: { ...c, board: later }, live: true }) });
  assert.equal(await stageAt(plan, board + CHANGE_GRACE_MS, due.look), 'change', 'the feed still has the second bus due');
  assert.equal((await tripPhase(onTwo(plan), board + CHANGE_GRACE_MS, due.look)).changesAt.at, board + 2 * MIN + CHANGE_GRACE_MS);
});

test('boarding a later first bus that misses the planned second one keeps you at the change, not on the second at once', async () => {
  const plan = planOfLeave(TWO_BUS_LEAVE, true, 'CG');
  const there = reach + 10 * MIN;
  const late = { ...plan, arrive: iso(there), change: laterChange(plan.change, TWO_BUS_LEAVE.change.reach, 10 * MIN) };
  assert.equal(await stageAt(late, there + CHANGE_GRACE_MS), 'change');
});

test('the feed is asked only for what the phase needs now, and working out the next change asks it nothing more', async () => {
  const plan = planOfLeave(TWO_BUS_LEAVE, true, 'CG');
  const feed = fixtureFeed();
  const { changesAt } = await tripPhase(onTwo(plan), reach - MIN, feed.look);
  assert.equal(changesAt.at, reach);
  assert.deepEqual(feed.asked, ['live K'], 'the first bus only: not the change stop, nor the stop you get off at');
  const atChange = fixtureFeed();
  await tripPhase(onTwo(plan), reach + MIN, atChange.look);
  assert.deepEqual(atChange.asked, ['live K', 'second P']);
  // Nothing asked for a trip not on a bus.
  const none = fixtureFeed();
  await tripPhase(tripOf(leaveAt(FROZEN_NOW + 10 * MIN)), FROZEN_NOW, none.look);
  assert.deepEqual(none.asked, []);
});

/* The rule the Trip object's wakes rest on: nothing changes before changesAt, and something does at it. */

const GOLDEN = new URL('../../../fixtures/answers/', import.meta.url);
/** Each golden answer with a bus to catch, as a trip's answer and its plan. */
const goldenTrips = fs
  .readdirSync(GOLDEN)
  .filter((f) => f.endsWith('.json'))
  .map((f) => [f.replace('.json', ''), JSON.parse(fs.readFileSync(new URL(f, GOLDEN), 'utf8'))])
  .filter(([, a]) => a.leave?.svc && a.leave.board && a.leave.at)
  .map(([name, { card: _card, refreshAt: _r, ...answer }]) => ({
    name,
    answer,
    plan: planOfLeave(answer.leave, false, answer.dest?.to ?? ''),
  }));

/** The ways a trip can go: nothing said, seen on the bus, said to be on it, set off, missed. */
const SIGNALS = {
  quiet: (plan) => ({ bus: plan }),
  seen: (plan) => ({ bus: { ...plan, seen: true } }),
  boarded: (plan, now) => ({ bus: plan, rec: { kind: 'boarded', at: now, boarded: plan } }),
  left: (plan, now) => ({ bus: plan, rec: { kind: 'left', at: now } }),
  missed: (plan, now) => ({ bus: plan, rec: { kind: 'missed', at: now } }),
};

test('for every golden trip, the phase holds until changesAt and differs at it', async () => {
  assert.ok(goldenTrips.length >= 10, `${goldenTrips.length} golden trips`);
  let checked = 0;
  for (const { name, answer, plan } of goldenTrips) {
    const leave = Date.parse(answer.leave.at);
    const end = Date.parse(tripEnd(plan) ?? plan.board);
    // The feed, fixed: the bus a little late by its plate, the second bus a minute late, a later one due.
    const feed = fixtureFeed({
      live: plan.arrive ? { [plan.svc]: iso(Date.parse(plan.arrive) + 2 * MIN) } : {},
      second: (c) => ({ change: { ...c, board: iso(Date.parse(c.board) + MIN) }, live: true }),
      next: iso(end + 12 * MIN),
    }).look;
    const places = { nowhere };
    for (const [signal, make] of Object.entries(SIGNALS)) {
      for (const [where, at] of Object.entries(places)) {
        const classAtMs = answer.timing?.classAt ? Date.parse(answer.timing.classAt) : null;
        const trip = tripOf(answer, { ...make(plan, leave), at, classAtMs });
        const what = async (ms) => shown((await tripPhase(trip, ms, feed)).verdict);
        const from = leave - 25 * MIN;
        const to = end + RIDE_GRACE_MS + 15 * MIN;
        const times = [];
        for (let t = from; t <= to; t += 20_000) times.push(t);
        const seen = await Promise.all(times.map(what));
        for (const [i, t] of times.entries()) {
          const { changesAt } = await tripPhase(trip, t, feed);
          const label = `${name}, ${signal}, ${where}, at ${iso(t)}`;
          const until = changesAt?.at ?? Infinity;
          assert.ok(until > t, `${label}: changes after now`);
          for (let j = i + 1; j < times.length && times[j] < until; j++)
            assert.equal(seen[j], seen[i], `${label}: unchanged at ${iso(times[j])}`);
          if (changesAt) {
            assert.equal(await what(until - 1), seen[i], `${label}: unchanged just before ${iso(until)}`);
            assert.notEqual(await what(until), seen[i], `${label}: changed at ${iso(until)}`);
          }
          checked++;
        }
      }
    }
  }
  assert.ok(checked > 10_000, `${checked} moments checked`);
});
