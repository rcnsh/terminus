/**
 * Golden answers: the exact JSON /me/next and /me/nearby return for a set of
 * fixed situations, on the frozen test clock and a fake feed. Refactors must
 * reproduce them byte for byte; a deliberate change is re-recorded with
 *
 *   UPDATE_GOLDEN=1 pnpm test
 *
 * and shows up as a diff in test/fixtures/answers/. The Android and Mac unit
 * tests parse these same files, so a change in shape fails there too.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { installGlobals, makeCtx, makeEnv, makeFetch } from './_stubs.mjs';
import { makeD1, makeEmail } from './_d1.mjs';
import worker from '../src/index.ts';

const DIR = new URL('./fixtures/answers/', import.meta.url);
const UPDATE = process.env.UPDATE_GOLDEN === '1';
const BASE = 'https://bus.example.test';

// Every service at every stop: D2 in 4 and 14 min, A1 in 9, R2 in 6.
const FEED = {};
for (const code of ['PGP', 'PGPR', 'COM3', 'UTOWN', 'KR-MRT', 'KR-MRT-OPP', 'CLB', 'LT27', 'AS5']) {
  FEED[code] = [
    { name: 'D2', arrivalTime: '4', nextArrivalTime: '14', passengers: 'low' },
    { name: 'A1', arrivalTime: '9', nextArrivalTime: '19', passengers: 'high' },
    { name: 'R2', arrivalTime: '6', nextArrivalTime: '18', passengers: 'medium' },
    { name: 'D1', arrivalTime: '7', nextArrivalTime: '17', passengers: 'low' },
  ];
}

async function account(profile) {
  installGlobals(makeFetch({ byStop: FEED }));
  const env = { ...makeEnv(), DB: makeD1(), EMAIL: makeEmail(), EMAIL_FROM: 'x@example.test' };
  const call = async (path, init = {}) => {
    const ctx = makeCtx();
    const res = await worker.fetch(new Request(BASE + path, init), env, ctx);
    await ctx.settle();
    return res;
  };
  await call('/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'you@u.nus.edu' }) });
  const verify = await call('/auth/verify', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `t=${env.EMAIL.lastToken()}` });
  const cookie = verify.headers.get('set-cookie').split(';')[0];
  const put = await call('/me/profile', { method: 'PUT', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(profile) });
  assert.equal(put.status, 200, await put.clone().text());
  return (path) => call(path, { headers: { cookie } }).then((r) => r.json());
}

const THU = 4; // FROZEN_NOW is Thursday 2026-08-27, 09:00 SGT
const places = [{ key: 'mrt', label: 'KR MRT', to: 'KR-MRT' }, { key: 'deck', label: 'The Deck', to: 'THE-DECK' }];
const cls = (arriveByMin, to, label, venue = '') => ({ day: THU, arriveByMin, endMin: arriveByMin + 60, to, label, venue });
const DORM = 'lat=1.2915&lon=103.7828'; // inside PGP
const CLB = 'lat=1.2966&lon=103.7724';
const AT_COM3 = 'lat=1.294431&lon=103.775217';

const CASES = {
  'class-bus': [{ home: { stops: ['PGP'] }, manual: [cls(600, 'UTOWN', 'GEA1000 @ UTown')], places }, '/me/next'],
  'class-walk': [{ home: { stops: ['PGP'] }, manual: [cls(600, 'COM3', 'CS2030 @ COM1', 'COM1')], places }, `/me/next?${CLB}`],
  'class-late': [{ home: { stops: ['PGP'] }, manual: [cls(545, 'UTOWN', 'GEA1000 @ UTown')], places }, '/me/next'],
  'class-from-dorm': [{ home: { stops: ['PGPR', 'PGP'] }, manual: [cls(600, 'UTOWN', 'GEA1000 @ UTown')], places }, `/me/next?${DORM}`],
  'place': [{ home: { stops: ['PGP'] }, places }, '/me/next?place=mrt'],
  'landmark': [{ home: { stops: ['PGP'] }, places }, '/me/next?place=deck'],
  'arrived': [{ home: { stops: ['PGP'] }, places }, `/me/next?to=COM3&${AT_COM3}`],
  'nearby': [{ places }, `/me/next?${CLB}`],
  'rest': [{ home: { stops: ['PGP'] }, dayStartMin: 600, dayEndMin: 1200, manual: [cls(780, 'COM3', 'CS2030 @ COM1')], places }, '/me/next'],
  'home': [{ home: { stops: ['PGPR', 'PGP'] }, manual: [cls(420, 'COM3', 'CS2030 @ COM1')], places }, `/me/next?${DORM}`],
  'setup': [{}, '/me/next'],
  'nearby-list': [{ home: { stops: ['PGP'] } }, `/me/nearby?${DORM}`],
};

for (const [name, [profile, path]] of Object.entries(CASES)) {
  test(`golden: ${name}`, async () => {
    const get = await account(profile);
    const body = await get(path);
    const file = new URL(`${name}.json`, DIR);
    const text = JSON.stringify(body, null, 2) + '\n';
    if (UPDATE || !fs.existsSync(file)) {
      fs.writeFileSync(file, text);
      return;
    }
    assert.equal(text, fs.readFileSync(file, 'utf8'), `${name} changed; if on purpose, UPDATE_GOLDEN=1 pnpm test`);
  });
}
