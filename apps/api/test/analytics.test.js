/**
 * Which answers are logged to Analytics Engine: the ones someone asked for,
 * not the ones the server works out for itself (the Trip object's wakes,
 * each class's leave-by on /me/day). On the frozen clock and a fake feed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { installGlobals, makeAnalytics, makeCtx, makeEnv, makeFetch, makeKV } from './_stubs.mjs';
import { makeD1, makeEmail } from './_d1.mjs';
import worker from '../src/index.ts';
import { answerFor, unlogged } from '../src/answer.ts';
import { tripCardFor } from '../src/me.ts';
import { GRAPH } from '../src/graph.ts';

const BASE = 'https://bus.example.test';
const THU = 4;
const FEED = {};
for (const code of ['PGP', 'PGPR', 'COM3', 'UTOWN', 'KR-MRT', 'CLB']) {
  FEED[code] = [{ name: 'D2', arrivalTime: '4', nextArrivalTime: '14', passengers: 'low', arrivalTime_veh_plate: 'PA1234A' }];
}
const cls = (arriveByMin, to, label) => ({ day: THU, arriveByMin, endMin: arriveByMin + 60, to, label, venue: '' });
const PROFILE = { home: { stops: ['PGP'] }, manual: [cls(600, 'UTOWN', 'GEA1000 @ UTown'), cls(720, 'COM3', 'CS2030 @ COM1')] };

async function setup() {
  const fetchImpl = makeFetch({ byStop: FEED });
  installGlobals(fetchImpl);
  const ae = makeAnalytics();
  const env = { ...makeEnv(makeKV(), ae), DB: makeD1(), EMAIL: makeEmail(), EMAIL_FROM: 'x@example.test' };
  const call = async (path, { method = 'GET', cookie, body } = {}) => {
    const headers = {};
    if (cookie) headers.cookie = cookie;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const ctx = makeCtx();
    const res = await worker.fetch(new Request(BASE + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env, ctx);
    await ctx.settle();
    return res;
  };
  await call('/api/auth/login', { method: 'POST', body: { email: 'you@u.nus.edu' } });
  const verify = await worker.fetch(
    new Request(`${BASE}/auth/verify`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `t=${env.EMAIL.lastToken()}` }),
    env,
    makeCtx(),
  );
  const cookie = verify.headers.get('set-cookie').split(';')[0];
  assert.equal((await call('/api/me/profile', { method: 'PUT', cookie, body: PROFILE })).status, 200);
  ae.events.length = 0;
  return { env, ae, call, cookie };
}

test('/api/me/day plans every class without logging each as an answer', async () => {
  const { ae, call, cookie } = await setup();
  const day = await (await call('/api/me/day', { cookie })).json();
  assert.ok(day.items.some((i) => i.leave?.at), 'the leave-bys were worked out');
  assert.equal(ae.rows('answer').length, 0);
  assert.equal(ae.rows('arrival').length, 0);
});

test('/api/me/next, which someone asked for, is still logged', async () => {
  const { ae, call, cookie } = await setup();
  assert.equal((await call('/api/me/next', { cookie })).status, 200);
  assert.ok(ae.rows('answer').length >= 1);
});

test("the Trip object's card is worked out without logging", async () => {
  const { env, ae } = await setup();
  const { id: userId } = await env.DB.prepare('SELECT id FROM users').first();
  const seen = [];
  const deps = {
    graph: GRAPH,
    answerFor: (e, ctx, input, label, nowMs) => {
      seen.push(input.log);
      return answerFor(e, ctx, input, label, nowMs);
    },
    collectArrivals: async () => new Map(),
  };
  const ctx = makeCtx();
  const card = await tripCardFor(env, ctx, deps, userId, null, Date.now(), async () => {});
  await ctx.settle();
  assert.ok(card, 'a card for a day with classes');
  assert.ok(seen.length > 0);
  assert.ok(seen.every((l) => l === false), 'every answer it asked for was unlogged');
  assert.equal(ae.rows('answer').length, 0);
});

test('unlogged() keeps the other deps and only adds log: false', async () => {
  const calls = [];
  const deps = { graph: GRAPH, answerFor: async (_e, _c, input) => calls.push(input), extra: 1 };
  const quiet = unlogged(deps);
  assert.equal(quiet.graph, GRAPH);
  assert.equal(quiet.extra, 1);
  await quiet.answerFor(null, null, { to: 'UTOWN' }, null, 0);
  assert.deepEqual(calls, [{ to: 'UTOWN', log: false }]);
});
