/**
 * Measured ride times (phase 8.2): rides detection saw start and end become
 * seconds per stop for each service and hour, which the planner uses in
 * place of the guess once there are enough of them.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { FROZEN_NOW, installGlobals, makeCtx, makeEnv, makeFetch } from './_stubs.mjs';
import { makeD1 } from './_d1.mjs';
import { GRAPH } from '../src/graph.ts';
import { RIDE } from '../src/config.ts';
import { MIN_RIDES, TABLE_KEY, buildTable, forgetTable, hopSecondsFor, recordRide, refreshTable } from '../src/ridetimes.ts';
import { answerFor } from '../src/answer.ts';

const iso = (ms) => new Date(ms).toISOString();
/** A detected D2 ride from PGP to UTown (6 stops), leaving at `leftMs`. */
const ride = (leftMs) => ({ svc: 'D2', stop: 'PGP', board: iso(leftMs), departed: iso(leftMs), arrive: null, stopCode: 'PGP', alightCode: 'UTOWN', plate: 'PX1' });
const HOPS = 6;

test('a ride is kept only when both ends were seen and the time makes sense', async () => {
  const db = makeD1();
  assert.equal(await recordRide(db, GRAPH, ride(FROZEN_NOW), FROZEN_NOW + HOPS * 100_000), HOPS * 100);
  assert.equal(await recordRide(db, GRAPH, { ...ride(FROZEN_NOW), departed: undefined }, FROZEN_NOW + 600_000), null, 'a tapped boarding: no start time');
  assert.equal(await recordRide(db, GRAPH, ride(FROZEN_NOW), FROZEN_NOW + 60_000), null, 'six stops in a minute is a mistake');
  assert.equal(await recordRide(db, GRAPH, ride(FROZEN_NOW), FROZEN_NOW + 3 * 3_600_000), null, 'three hours is someone who stayed on');
  const rows = db._db.prepare('SELECT svc, from_code, to_code, hops, seconds, hour, plate FROM ride_times').all().map((r) => ({ ...r }));
  assert.deepEqual(rows, [{ svc: 'D2', from_code: 'PGP', to_code: 'UTOWN', hops: HOPS, seconds: 600, hour: 9, plate: 'PX1' }]);
});

test('seconds per stop by service and by hour, each only with enough rides', async () => {
  const db = makeD1();
  // Nine rides: not enough for anything.
  for (let i = 0; i < MIN_RIDES - 1; i++) await recordRide(db, GRAPH, ride(FROZEN_NOW - i * 86_400_000), FROZEN_NOW - i * 86_400_000 + HOPS * 120_000);
  assert.deepEqual((await buildTable(db, FROZEN_NOW)).svcs, {});
  // One more at 9 am, and ten at 2 pm that are quicker.
  await recordRide(db, GRAPH, ride(FROZEN_NOW - 20 * 86_400_000), FROZEN_NOW - 20 * 86_400_000 + HOPS * 120_000);
  const pm = FROZEN_NOW + 5 * 3_600_000;
  for (let i = 0; i < MIN_RIDES; i++) await recordRide(db, GRAPH, ride(pm - i * 86_400_000), pm - i * 86_400_000 + HOPS * 80_000);
  const table = await buildTable(db, FROZEN_NOW);
  assert.equal(table.svcs.D2.n, 2 * MIN_RIDES);
  assert.equal(table.svcs.D2.s, 100);
  assert.deepEqual(table.svcs.D2.hours, { 9: 120, 14: 80 });
  const hop = hopSecondsFor(table, FROZEN_NOW);
  assert.equal(hop('D2'), 120, 'the hour has its own');
  assert.equal(hopSecondsFor(table, FROZEN_NOW + 2 * 3_600_000)('D2'), 100, '11 am: the service overall');
  assert.equal(hop('R2'), null, 'no rides: the guess');
  assert.equal(hopSecondsFor(null, FROZEN_NOW), undefined);
});

test('the cron makes the table once a day and prunes rides older than it keeps', async () => {
  const env = { ...makeEnv(), DB: makeD1() };
  await recordRide(env.DB, GRAPH, ride(FROZEN_NOW - 200 * 86_400_000), FROZEN_NOW - 200 * 86_400_000 + HOPS * 100_000);
  for (let i = 0; i < MIN_RIDES; i++) await recordRide(env.DB, GRAPH, ride(FROZEN_NOW - i * 86_400_000), FROZEN_NOW - i * 86_400_000 + HOPS * 110_000);
  assert.equal(await refreshTable(env, FROZEN_NOW), true);
  assert.equal(await refreshTable(env, FROZEN_NOW + 3_600_000), false, 'once a day');
  assert.equal(env.DB._db.prepare('SELECT COUNT(*) AS n FROM ride_times').get().n, MIN_RIDES, 'the old ride is gone');
  const table = JSON.parse(env.KV._map.get(TABLE_KEY));
  assert.equal(table.svcs.D2.s, 110);
});

test('the planner uses measured times where it has them, and the guess elsewhere', async () => {
  const feed = { PGP: [{ name: 'D2', arrivalTime: '3', nextArrivalTime: '13', passengers: 'low' }] };
  installGlobals(makeFetch({ byStop: feed }));
  const input = { lat: null, lon: null, to: 'UTOWN', originCode: 'PGP' };
  const ask = async (kv) => {
    forgetTable();
    const env = { ...makeEnv(kv) };
    const a = await answerFor(env, makeCtx(), { ...input }, 'UTown', FROZEN_NOW);
    return Date.parse(a.arriveAt) - Date.parse(a.departsAt);
  };
  const guess = await ask(undefined);
  assert.equal(guess, HOPS * RIDE.secondsPerHop * 1000);
  const { makeKV } = await import('./_stubs.mjs');
  const measured = await ask(makeKV({ [TABLE_KEY]: { made: iso(FROZEN_NOW), svcs: { D2: { n: 40, s: 150, hours: { 9: 130 } } } } }));
  assert.equal(measured, HOPS * 130 * 1000);
  forgetTable();
});
