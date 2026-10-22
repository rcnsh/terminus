/**
 * The planner's entry (nextFor in src/next.ts), called as the routes and the
 * Trip object call it: a rider and an ask, no request, no D1, no Trip object.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DAY_ASK, nextFor } from '../src/next.ts';
import { DEFAULT_PROFILE } from '../src/profile.ts';
import { NO_PREFS } from '../src/outcomes.ts';
import { answerFor } from '../src/answer.ts';

const NOW = Date.parse('2026-08-27T02:00:00Z'); // a Thursday, 10:00 in Singapore
const asked = [];
const collect = async (_env, _ctx, codes, at) => {
  asked.push(...codes);
  const arrivals = [{ svc: 'D2', etaS: 240, crowd: null, plate: null, berth: null }];
  return new Map(codes.map((code) => [code, { code, arrivals, fetchedAt: at, stale: false, available: true }]));
};
const deps = { collectArrivals: collect, answerFor: (e, c, i, l, n) => answerFor(e, c, { ...i, log: false }, l, n, collect) };
const ctx = { waitUntil() {}, passThroughOnException() {} };
const rider = (profile) => ({ userId: 'u1', profile: { ...DEFAULT_PROFILE, ...profile }, day: null, prefs: NO_PREFS });

test('a favourite asked for is answered from where you are, in the ask clock, and changes nothing', async () => {
  const r = rider({ places: [{ key: 'utown', label: 'UTown', to: 'UTOWN' }] });
  const ask = { at: { lat: 1.2966, lon: 103.7764 }, place: 'utown', to: null, h12: true };
  const { body, trip, update } = await nextFor({}, ctx, deps, r, ask, NOW);
  assert.equal(body.dest?.to, 'UTOWN');
  assert.equal(trip.key, null, 'an asked-for trip is not tracked');
  assert.deepEqual(update, {});
  assert.equal(body.refreshAt, undefined, 'a place never changes by itself');
  assert.ok(asked.length > 0, 'its stops were read through the deps');
  assert.match(JSON.stringify(body.card), /[ap]m/i, '12-hour, as the ask said');
});

test('the day with nothing on it is a free day, and nothing to save', async () => {
  const { body, trip, update } = await nextFor({}, ctx, deps, rider({}), DAY_ASK, NOW);
  assert.equal(trip.phase, 'idle');
  assert.ok(body.refreshAt, 'the day itself moves on');
  assert.deepEqual(update, {});
});
