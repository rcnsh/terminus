// The card's journey: the trip as steps, which the app's card styles draw.

import test from 'node:test';
import assert from 'node:assert/strict';
import { cardFor } from '../src/card.ts';
import { ROUTE_COLORS } from '../src/campus.ts';

const load = async (name) => {
  const { default: fixture } = await import(`./fixtures/answers/${name}.json`, { with: { type: 'json' } });
  const { card: _card, refreshAt: _r, ...answer } = fixture;
  return answer;
};

test('a class journey takes the leave-by bus, with its walk, ride, arrival and slack', async () => {
  const j = cardFor(await load('class-bus')).journey;
  assert.equal(j.bus.svc, 'R2');
  assert.equal(j.bus.color, ROUTE_COLORS.R2);
  assert.equal(j.bus.stop, 'PGP');
  assert.equal(j.leave, '~09:36');
  assert.equal(j.walk, '5 min');
  assert.equal(j.ride, '10 min');
  assert.equal(j.to, 'GEA1000 @ UTown');
  // The class's name is too long for the end of a line: the stop is short.
  assert.equal(j.toStop, 'UTown');
  assert.equal(j.slack, '9 min early');
  // The leave-by bus is a headway guess, so not live.
  assert.equal(j.live, false);
  // The backup for a class is the headline bus, to go now on.
  assert.equal(j.backup.board, '09:06');
});

test('a trip journey takes the headline bus, and the other bus is the backup', async () => {
  const j = cardFor(await load('place')).journey;
  assert.equal(j.bus.svc, 'A1');
  assert.equal(j.bus.board, '09:09');
  assert.equal(j.arrive, '09:10');
  assert.equal(j.live, true);
  assert.equal(j.slack, null);
  assert.equal(j.backup.svc, 'D2');
});

test('the journey leaves now once the leave-by has passed, and drops the walk at the stop', async () => {
  const answer = await load('place');
  const late = cardFor({ ...answer, leave: { ...answer.leave, at: answer.asOf } }).journey;
  assert.equal(late.leave, null);
  const waiting = cardFor(answer, false, { key: 'mrt', phase: 'waiting' }).journey;
  assert.equal(waiting.walk, null);
});

test('no journey on foot, on the bus, once there, or for what is nearby', async () => {
  assert.equal(cardFor(await load('evening-home')).journey, null);
  assert.equal(cardFor(await load('class-walk')).journey, null);
  assert.equal(cardFor(await load('arrived')).journey, null);
  assert.equal(cardFor({ ...(await load('place')), mode: 'nearby' }).journey, null);
  assert.equal(cardFor(await load('place'), false, { key: 'mrt', phase: 'riding' }).journey, null);
});

test('the journey gets off where the bus stops across the road', async () => {
  const answer = await load('class-from-dorm');
  const j = cardFor({ ...answer, leave: { ...answer.leave, off: 'Opp NUSS' } }).journey;
  assert.equal(j.off, 'Opp NUSS');
  assert.equal(j.toStop, 'Opp NUSS');
});

test('the journey ends at the stop the bus calls at, not the place\'s first stop', async () => {
  // The Deck has more than one stop; this R2 calls at Opp NUSS.
  const j = cardFor(await load('landmark')).journey;
  assert.equal(j.off, null);
  assert.equal(j.toStop, 'Opp NUSS');
});

test('a trip kept as a plan keeps its journey on every device', async () => {
  const { planOfLeave } = await import('../src/plan.ts');
  const { leaveOf } = await import('../src/trip.ts');
  const answer = await load('class-bus');
  const fresh = cardFor(answer).journey;
  // Another device reads the plan the first one kept (next.ts), not its own leave-by.
  const kept = cardFor({ ...answer, leave: leaveOf(planOfLeave(answer.leave, false, 'UTOWN')) }).journey;
  assert.deepEqual(kept, fresh);
});

test('a plan kept before it carried walk and ride times still has a journey', async () => {
  const { planOfLeave } = await import('../src/plan.ts');
  const { leaveOf } = await import('../src/trip.ts');
  const answer = await load('class-bus');
  const { walkS: _w, rideS: _r, ...old } = planOfLeave(answer.leave, false, 'UTOWN');
  const j = cardFor({ ...answer, leave: leaveOf(old) }).journey;
  assert.ok(j);
  assert.equal(j.bus.svc, 'R2');
  assert.equal(j.walk, '5 min');
  assert.equal(j.toStop, 'UTown');
});

test('a planned trip home shows the planned bus, with the headline bus as its backup', async () => {
  const answer = await load('place');
  const planned = { ...answer.leave, svc: 'D2', board: '2026-08-27T01:14:00Z', at: '2026-08-27T01:08:00Z', walkS: 300, rideS: 120 };
  const j = cardFor({ ...answer, leave: planned }).journey;
  assert.equal(j.bus.svc, 'D2');
  assert.equal(j.backup.svc, 'A1');
});
