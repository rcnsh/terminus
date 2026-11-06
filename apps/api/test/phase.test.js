/**
 * A trip's phase and when it next changes (phase.ts), through its interface:
 * a trip, a time, and the feed as fixtures.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  ASSUME_MS,
  CHANGE_GRACE_MS,
  DUE_MS,
  LEAVE_GAP_MS,
  RIDE_GRACE_MS,
  answerPhase,
  phaseOf,
  secondLeavesMs,
  shown,
  tripPhase,
} from '../src/answer/phase.ts';
import { planOfLeave } from '../src/answer/plan.ts';
import { HOME_GRACE_MS, dayState, laterChange, tripEnd } from '../src/answer/trip.ts';
import { cardFor } from '../src/answer/card.ts';
import { GRAPH } from '../src/answer/graph.ts';
import { FROZEN_NOW } from './_stubs.mjs';
import { withoutMeasuredHeadways } from './_headways.mjs';
import { onRide, rideLength } from './_ride.mjs';

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

test('at the stop before the leave-by, the card changes when the bus goes; the Trip object, from nowhere, still wakes for due', async () => {
  const now = FROZEN_NOW;
  const pgp = GRAPH.stops.find((s) => s.code === 'PGP');
  const answer = leaveAt(now + 10 * MIN);
  const bus = { svc: 'D2', board: iso(now + 14 * MIN), arrive: iso(now + 20 * MIN) };
  const there = await tripPhase(tripOf(answer, { bus, at: { lat: pgp.lat, lon: pgp.lon } }), now, fixtureFeed().look);
  assert.equal(phaseOf(there.verdict), 'waiting');
  assert.notEqual(there.changesAt.at, now + 10 * MIN - DUE_MS, 'waiting holds through the leave-by');
  assert.deepEqual(there.wakesAt, { at: now + 10 * MIN - DUE_MS, leave: true });
  const evening = await answerPhase(answer, undefined, { lat: pgp.lat, lon: pgp.lon }, now);
  assert.equal(evening.phase, 'waiting');
  assert.equal(evening.changesAt, null);
  assert.deepEqual(evening.wakesAt, { at: now + 10 * MIN - DUE_MS, leave: true });
  // With no location, the two are the same.
  const away = await tripPhase(tripOf(answer, { bus }), now, fixtureFeed().look);
  assert.deepEqual(away.wakesAt, away.changesAt);
});

test('on a later bus home than planned, you are home once that bus has had time to get you there, not by the plan', async () => {
  const now = FROZEN_NOW;
  const plan = { svc: 'D2', board: iso(now - 30 * MIN), arrive: iso(now - 20 * MIN) };
  // Said to be on the bus 20 min after it (the boarded tap records the bus pulling in).
  const boarded = { ...plan, board: iso(now - 10 * MIN), arrive: iso(now), plate: 'PD123X' };
  const rec = { kind: 'boarded', at: now - 10 * MIN, boarded };
  // When the day says the trip home has got you there (next.ts reads it the same way).
  const homeBy = dayState({ date: '2026-08-27', trips: { 'home:660': rec }, plans: { 'home:660': plan } }).homeBy.get('home:660');
  const trip = tripOf(leaveAt(now - 35 * MIN), { bus: plan, rec, home: { lastEndMs: now - 60 * MIN, homeBy } });
  const { verdict, changesAt } = await tripPhase(trip, now - 5 * MIN, fixtureFeed().look);
  assert.equal(phaseOf(verdict), 'riding');
  const planned = Date.parse(plan.arrive) + HOME_GRACE_MS;
  assert.equal(await phaseAt(trip, planned), 'riding', "the plan's home-by passes on the bus");
  assert.deepEqual(changesAt, { at: Date.parse(boarded.arrive) + RIDE_GRACE_MS, leave: false });
  assert.equal((await tripPhase(trip, changesAt.at, fixtureFeed().look)).verdict.kind, 'home');
});

test("on a bus home whose arrival nobody knows, you are home by the plan's, not an hour after the class", async () => {
  const now = FROZEN_NOW;
  const plan = { svc: 'D2', board: iso(now - 30 * MIN), arrive: iso(now - 20 * MIN) };
  const rec = { kind: 'boarded', at: now - 30 * MIN, boarded: { ...plan, arrive: null } };
  const homeBy = dayState({ date: '2026-08-27', trips: { 'home:660': rec }, plans: { 'home:660': plan } }).homeBy.get('home:660');
  assert.equal(homeBy, Date.parse(plan.arrive) + HOME_GRACE_MS);
  const trip = tripOf(leaveAt(now - 35 * MIN), { bus: plan, rec, home: { lastEndMs: now - 60 * MIN, homeBy } });
  assert.equal((await tripPhase(trip, homeBy, fixtureFeed().look)).verdict.kind, 'home');
});

test('a rule that throws at a later moment fails the call: it is not taken as a change', async () => {
  const now = FROZEN_NOW;
  // A trip home whose home-by reads once, then throws: a bug in a rule, only at later moments.
  const breaking = () => {
    let reads = 0;
    return {
      lastEndMs: now - 60 * MIN,
      get homeBy() {
        if (reads++ > 0) throw new TypeError('a bug');
        return now + 30 * MIN;
      },
    };
  };
  await assert.rejects(tripPhase(tripOf(leaveAt(now + 10 * MIN), { home: breaking() }), now, fixtureFeed().look), TypeError);
  // With a location, the object's view from nowhere is the one that reads it.
  const pgp = GRAPH.stops.find((s) => s.code === 'PGP');
  const located = tripOf(leaveAt(now + 10 * MIN), { home: breaking(), at: { lat: pgp.lat + 0.01, lon: pgp.lon } });
  await assert.rejects(tripPhase(located, now, fixtureFeed().look), TypeError);
});

test('on a bus home that the feed has running late, the trip home is not over at its home-by but when the feed has that bus there', async () => {
  const now = FROZEN_NOW;
  // On the D2 due home at 18:10 (now + 10 min); the feed has it there at 18:25.
  const boarded = { svc: 'D2', board: iso(now - 10 * MIN), arrive: iso(now + 10 * MIN), plate: 'PD123X' };
  const rec = { kind: 'boarded', at: now - 10 * MIN, boarded };
  const homeBy = dayState({ date: '2026-08-27', trips: { 'home:660': rec } }).homeBy.get('home:660');
  assert.equal(homeBy, now + 10 * MIN + HOME_GRACE_MS);
  const live = now + 25 * MIN;
  const feed = fixtureFeed({ live: { D2: iso(live) } });
  const trip = tripOf(leaveAt(now - 15 * MIN), { bus: boarded, rec, home: { lastEndMs: now - 60 * MIN, homeBy } });
  const { verdict, changesAt } = await tripPhase(trip, now, feed.look);
  assert.equal(phaseOf(verdict), 'riding');
  assert.deepEqual(changesAt, { at: live, leave: false }, 'not at the home-by, mid-ride');
  assert.deepEqual(feed.asked, ['live D2'], 'the feed read once, for the bus you are on');
  // A request that doesn't read the feed (past the home-by, no location) still goes by the plan, as before.
  const quiet = fixtureFeed({ live: { D2: iso(live) } });
  assert.equal((await tripPhase(trip, live, quiet.look)).verdict.kind, 'home');
  assert.deepEqual(quiet.asked, []);
  assert.equal(
    (await tripPhase(trip, homeBy, fixtureFeed({ live: { D2: iso(live) } }).look)).verdict.kind,
    'home',
    'past the home-by, no feed read: by the plan',
  );
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

test('the 30 s a sliding leave-by waits never skips a change that does not slide: the bus going', async () => {
  const { default: fixture } = await import('../../../fixtures/answers/class-bus.json', { with: { type: 'json' } });
  const { card: _card, refreshAt: _r, ...answer } = fixture;
  const now = Date.parse(answer.asOf);
  // Leave in 5 s; the plan's bus left long enough ago to count as gone in 20 s.
  const sliding = { ...answer, leave: { ...answer.leave, at: iso(now + 5_000) } };
  const bus = { ...planOfLeave(answer.leave, false, answer.dest.to), board: iso(now + 20_000 - ASSUME_MS) };
  const { verdict, changesAt } = await tripPhase(tripOf(sliding, { bus }), now, fixtureFeed().look);
  assert.equal(phaseOf(verdict), 'due');
  assert.equal(changesAt.at, now + 5_000, 'the Trip object keeps the exact time');
  const card = cardFor(sliding, false, { key: 'k', phase: phaseOf(verdict), changesAt }, null, now);
  assert.equal(Date.parse(card.nextChangeAt), now + 20_000);
});

test('a request whose location decides nothing works out the next change once, as one without a location', async () => {
  const { default: fixture } = await import('../../../fixtures/answers/class-bus.json', { with: { type: 'json' } });
  const { card: _card, refreshAt: _r, ...answer } = fixture;
  const bus = planOfLeave(answer.leave, false, answer.dest.to);
  // The plan's bus gone five minutes ago; the next one to leave for in 10.
  const now = Date.parse(bus.board) + 5 * MIN;
  const fresh = { ...answer, leave: { ...answer.leave, at: iso(now + 10 * MIN), board: iso(now + 15 * MIN) } };
  /** The trip's rules run once per moment tried: counted by what they read of the answer. */
  const cost = async (at) => {
    let reads = 0;
    const counted = new Proxy(fresh, { get: (o, k) => (reads++, o[k]) });
    const out = await tripPhase(tripOf(answer, { bus, fresh: counted, at }), now, fixtureFeed().look);
    return { reads, out };
  };
  const far = await cost({ lat: 1.25, lon: 103.9 });
  const none = await cost(nowhere);
  assert.equal(phaseOf(far.out.verdict), phaseOf(none.out.verdict));
  assert.deepEqual(far.out.wakesAt, none.out.wakesAt);
  assert.equal(far.reads, none.reads);
  // On the bus's road, but no further than you could have walked: seenOnBus says no once, and stays no as the walk grows.
  let asked = 0;
  const counted = new Proxy(bus, { get: (o, k) => (k === 'paid' && asked++, o[k]) });
  const road = onRide(bus.svc, bus.stopCode, bus.alightCode, 150);
  const { verdict } = await tripPhase(tripOf(answer, { bus: counted, fresh, at: road }), now, fixtureFeed().look);
  assert.equal(verdict.kind, 'gone');
  assert.equal(asked, 1);
});

test('the evening trip home, on the bus you said, rides until that bus has got you there, then is over', async () => {
  const now = FROZEN_NOW;
  const pgp = GRAPH.stops.find((s) => s.code === 'PGP');
  const boarded = { svc: 'D2', board: iso(now - 5 * MIN), arrive: iso(now + 10 * MIN) };
  const rec = { kind: 'boarded', at: now - 5 * MIN, boarded };
  const at = { lat: pgp.lat + 0.01, lon: pgp.lon };
  const riding = await answerPhase(leaveAt(now - 10 * MIN), rec, at, now);
  assert.equal(riding.phase, 'riding');
  const end = Date.parse(boarded.arrive) + RIDE_GRACE_MS;
  assert.deepEqual(riding.changesAt, { at: end, leave: false });
  assert.deepEqual(riding.wakesAt, { at: end, leave: false });
  assert.equal((await answerPhase(leaveAt(now - 10 * MIN), rec, at, end)).phase, 'arrived');
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
  // A trip home, its last class ending ten minutes before the leave-by,
  // home by its bus's arrival and HOME_GRACE_MS, or without one HOME_BY_MIN after the class.
  home: (plan, now) => ({
    bus: plan,
    home: { lastEndMs: now - 10 * MIN, homeBy: Date.parse(tripEnd(plan) ?? plan.board) + HOME_GRACE_MS },
  }),
  homeUnplanned: (plan, now) => ({ bus: plan, home: { lastEndMs: now - 10 * MIN } }),
};

test('for every golden trip, the phase holds until changesAt and differs at it, with a location and without; and the object’s until wakesAt', async () => {
  assert.ok(goldenTrips.length >= 10, `${goldenTrips.length} golden trips`);
  let checked = 0;
  let apart = 0;
  for (const { name, answer, plan } of goldenTrips) {
    const leave = Date.parse(answer.leave.at);
    const end = Date.parse(tripEnd(plan) ?? plan.board);
    // The feed, fixed: the bus a little late by its plate, the second bus a minute late, a later one due.
    const fixtures = {
      live: plan.arrive ? { [plan.svc]: iso(Date.parse(plan.arrive) + 2 * MIN) } : {},
      second: (c) => ({ change: { ...c, board: iso(Date.parse(c.board) + MIN) }, live: true }),
      next: iso(end + 12 * MIN),
    };
    const feed = fixtureFeed(fixtures).look;
    // The feed as far as one request read it, and the plan's times for the rest (as phase.ts's `remembered`).
    const readBy = (asked) => ({
      liveArrival: async (b) => (asked.includes(`live ${b.svc}`) ? feed.liveArrival(b) : null),
      secondBus: async (b) => (asked.includes(`second ${b.change.svc}`) ? feed.secondBus(b) : { change: b.change, live: false }),
      nextArrival: async (b) => (asked.includes(`next ${b.svc}`) ? feed.nextArrival(b) : null),
    });
    const stop = GRAPH.stops.find((s) => s.code === (plan.stopCode ?? answer.stop.code));
    // On the bus's road near the end of the ride, where a location sees you on it.
    const road = (() => {
      try {
        return plan.stopCode && plan.alightCode
          ? onRide(plan.svc, plan.stopCode, plan.alightCode, rideLength(plan.svc, plan.stopCode, plan.alightCode) - 100)
          : null;
      } catch {
        return null;
      }
    })();
    const places = { nowhere, ...(stop ? { atStop: { lat: stop.lat, lon: stop.lon } } : {}), ...(road ? { onRoad: road } : {}) };
    for (const [signal, make] of Object.entries(SIGNALS)) {
      for (const [where, at] of Object.entries(places)) {
        const classAtMs = answer.timing?.classAt ? Date.parse(answer.timing.classAt) : null;
        const made = make(plan, leave);
        // A request that sees you on the bus has the planner save it on the plan (seenOn): later ones start from that.
        let seenFrom = Infinity;
        const tripAt = (ms) => tripOf(answer, { ...made, ...(ms > seenFrom ? { bus: { ...made.bus, seen: true } } : {}), at, classAtMs });
        const what = async (ms) => shown((await tripPhase(tripAt(ms), ms, feed)).verdict);
        const from = leave - 25 * MIN;
        const to = Math.max(end + RIDE_GRACE_MS, leave + 50 * MIN) + 15 * MIN;
        const times = [];
        for (let t = from; t <= to; t += 20_000) times.push(t);
        const seen = [];
        const changes = [];
        const wakes = [];
        const reads = [];
        for (const t of times) {
          const read = fixtureFeed(fixtures);
          const { verdict, changesAt, wakesAt } = await tripPhase(tripAt(t), t, read.look);
          reads.push(readBy(read.asked));
          if (verdict.kind === 'seen' && verdict.seenNow && seenFrom === Infinity) seenFrom = t;
          seen.push(shown(verdict));
          changes.push(changesAt);
          wakes.push(wakesAt);
        }
        // The Trip object's view of the same trip: from nowhere, on the plan as this request leaves it.
        const fromNowhere = async (ms, i) => {
          const bus = times[i] >= seenFrom ? { ...made.bus, seen: true } : made.bus;
          return shown((await tripPhase(tripOf(answer, { ...made, bus, at: nowhere, classAtMs }), ms, reads[i])).verdict);
        };
        for (const [i, t] of times.entries()) {
          const changesAt = changes[i];
          const label = `${name}, ${signal}, ${where}, at ${iso(t)}`;
          const until = changesAt?.at ?? Infinity;
          assert.ok(until > t, `${label}: changes after now`);
          for (let j = i + 1; j < times.length && times[j] < until; j++)
            assert.equal(seen[j], seen[i], `${label}: unchanged at ${iso(times[j])}`);
          if (changesAt) {
            assert.equal(await what(until - 1), seen[i], `${label}: unchanged just before ${iso(until)}`);
            assert.notEqual(await what(until), seen[i], `${label}: changed at ${iso(until)}`);
          }
          // With a location, the object wakes when its own view changes.
          const wake = wakes[i];
          if (at !== nowhere && wake) {
            if (wake.at !== changesAt?.at) apart++;
            const was = await fromNowhere(t, i);
            assert.ok(wake.at > t, `${label}: wakes after now`);
            assert.equal(await fromNowhere(wake.at - 1, i), was, `${label}: object unchanged just before ${iso(wake.at)}`);
            assert.notEqual(await fromNowhere(wake.at, i), was, `${label}: object changed at ${iso(wake.at)}`);
          }
          checked++;
        }
      }
    }
  }
  assert.ok(checked > 10_000, `${checked} moments checked`);
  assert.ok(apart > 100, `${apart} moments where the object wakes other than the card changes`);
});

test('nothing phase.ts imports leads back to it: the trip engine imports one way', () => {
  const src = new URL('../src/', import.meta.url);
  const start = new URL('answer/phase.ts', src).href;
  /** A module's imports that run (not `import type`), as URLs. */
  const importsOf = (href) =>
    [...fs.readFileSync(new URL(href), 'utf8').matchAll(/^\s*(?:import|export)\s+(?!type\s)[^'"]*?from\s+'(\.[^']+)'/gm)].map(
      (m) => new URL(m[1], href).href,
    );
  const seen = new Set();
  const todo = importsOf(start);
  while (todo.length) {
    const href = todo.pop();
    assert.notEqual(href, start, 'an import leads back to phase.ts');
    if (seen.has(href)) continue;
    seen.add(href);
    todo.push(...importsOf(href));
  }
});
