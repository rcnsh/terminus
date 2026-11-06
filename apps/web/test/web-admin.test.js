// The operator dashboard (admin/): what its pages work out from /api/admin/stats.
import test from 'node:test';
import assert from 'node:assert/strict';
import { page, settle } from './_dom.mjs';
import { memoryStorage, web } from './_web.mjs';

const { derive, keyRows } = await web('admin/views.js');
const { render } = await web('assets/ui.js');

test("the dashboard's days are Singapore days, and the week leaves today's few hours out", () => {
  // 06:00 on Fri 24 Oct in Singapore, 22:00 UTC on the 23rd.
  const now = '2026-10-23T22:00:00Z';
  // The server sends a row per Singapore day: 100 a day for 14 full days, then 10 so far today.
  const days = Array.from({ length: 15 }, (_, i) => new Date(Date.UTC(2026, 9, 10 + i)).toISOString().slice(0, 10));
  const daily = days.map((day, i) => ({ day, kind: 'answer', n: i === 14 ? 10 : 100 }));
  const d = derive({ now, accounts: { total: 0 }, analytics: { daily } });
  assert.equal(d.d14.at(-1), '2026-10-24');
  assert.equal(d.d14.length, 14);
  assert.equal(d.answers.at(-1), 10, "today's bar holds this morning's answers");
  assert.equal(d.answers.at(-2), 100);
  // Seven full days against the seven before: the same, not down by today's missing hours.
  assert.equal(d.answers7, 700);
  assert.equal(d.answersChange, 0);
});

test("each API key's requests: today and the 7 full days before it, what was turned away, its commonest route, and unlisted keys counted apart", () => {
  const d14 = Array.from({ length: 14 }, (_, i) => new Date(Date.UTC(2026, 9, 11 + i)).toISOString().slice(0, 10));
  const s = {
    apiKeys: {
      list: [
        { id: 'k1', name: 'Bot', hint: 'abcd', email: 'a@u.nus.edu', userId: 'u1' },
        { id: 'k2', name: 'Idle', hint: 'efgh', email: null, userId: 'u2' },
      ],
    },
    analytics: {
      keys: [
        { keyId: 'k1', day: '2026-10-16', outcome: 'ok', n: '500' },
        { keyId: 'k1', day: '2026-10-17', outcome: 'ok', n: '30' },
        { keyId: 'k1', day: '2026-10-23', outcome: 'limited', n: '4' },
        { keyId: 'k1', day: '2026-10-24', outcome: 'ok', n: '10' },
        { keyId: 'k1', day: '2026-10-24', outcome: 'limited', n: '25' },
        { keyId: 'gone', day: '2026-10-20', outcome: 'ok', n: '7' },
      ],
      keyRoutes: [
        { keyId: 'k1', route: '/api/buses', n: '40' },
        { keyId: 'k1', route: '/api/next', n: '29' },
      ],
    },
  };
  const { rows, unlisted, counted } = keyRows(s, d14);
  assert.deepEqual(
    rows.map((r) => [r.id, r.today, r.n7, r.limited7, r.route]),
    [
      ['k1', 35, 34, 4, '/api/buses'],
      ['k2', 0, 0, 0, ''],
    ],
    'the 16th is before the week; today is apart from it',
  );
  assert.equal(unlisted, 7);
  assert.equal(counted, true);
  assert.equal(keyRows({ apiKeys: s.apiKeys, analytics: { error: 'x' } }, d14).rows[0].n7, 0, 'Analytics Engine failing: no counts');
});

/** A fetch whose /api/admin/stats answers wait for the test: `asked[i].answer(status, body)`. */
const asked = [];
const deferred = () => {
  const d = {};
  d.promise = new Promise((resolve) => (d.answer = (status, body = {}) => resolve(Response.json(body, { status }))));
  return d;
};
const STATS = { now: '2026-10-23T02:00:00Z', accounts: { total: 3 } };

test('the dashboard: a failed first load can be tried again, and Lock wins over a reply still on its way', async (t) => {
  // A page without charts: happy-dom has no layout for them to measure.
  page({ url: 'https://terminus.run/admin/#/reports', html: '<div id="admin"></div>' });
  globalThis.ResizeObserver ??= class {
    observe() {}
    disconnect() {}
  };
  globalThis.sessionStorage = memoryStorage({ 'terminus-operator-token': 'session' });
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), '/api/admin/stats');
    asked.push({ token: init.headers['x-health-token'], ...deferred() });
    return asked.at(-1).promise;
  };
  await web('admin/admin.js');
  const root = document.getElementById('admin');
  t.after(() => render(null, root));
  const button = (text) => [...root.querySelectorAll('button')].find((b) => b.textContent.trim() === text);

  asked[0].answer(500);
  await settle();
  assert.match(root.textContent, /The stats answered 500\./);
  assert.ok(button('Try again'), 'a way out of the error besides reloading');
  button('Try again').click();
  await settle();
  assert.equal(asked.length, 2);
  asked[1].answer(200, STATS);
  await settle();
  assert.ok(button('Lock'), 'the dashboard is up');

  // A refresh on its way when Lock is pressed: its reply is dropped, not shown with the session gone.
  button('Refresh').click();
  await settle();
  assert.equal(asked.length, 3);
  button('Lock').click();
  await settle();
  asked[2].answer(200, STATS);
  await settle();
  // A boolean: a failing assert would print happy-dom's whole element graph.
  assert.equal(Boolean(button('Lock')), false, 'still locked');
  assert.equal(sessionStorage.getItem('terminus-operator-token'), null);
});

test('the timelapse token opens the Timelapse alone: no stats asked for, no other section', async (t) => {
  const w = page({ url: 'https://terminus.run/admin/#/timelapse', html: '<div id="admin"></div>' });
  globalThis.Image = w.Image;
  globalThis.sessionStorage = memoryStorage();
  const calls = [];
  let days = 404;
  globalThis.fetch = async (url, init) => {
    calls.push([String(url), init?.headers?.['x-health-token']]);
    if (String(url) === '/api/timelapse/days') return Response.json({ days: [], recording: null }, { status: days });
    return Response.json({}, { status: 404 });
  };
  // A fresh copy: the test above has its own, signed out.
  await web('admin/admin.js?timelapse');
  const root = document.getElementById('admin');
  t.after(() => render(null, root));
  await settle();
  // Booleans and strings only: a failing assert on an element prints happy-dom's whole graph.
  const box = () => root.querySelector('#timelapse-token');
  assert.equal(Boolean(box()), true, "the timelapse token's form, on the timelapse's address");
  assert.equal(Boolean(box().closest('details')?.open), true, 'and open there');
  const submit = async (token) => {
    box().value = token;
    box()
      .closest('form')
      .dispatchEvent(new Event('submit', { cancelable: true }));
    await settle(10);
  };

  // A refused token stays at the gate, with why, and keeps nothing.
  await submit('wrong');
  assert.match(root.querySelector('.gate-msg')?.textContent ?? '', /timelapse token was not accepted/);
  assert.equal(sessionStorage.getItem('terminus-operator-token'), null);

  days = 200;
  await submit('tl-token');
  // The section's module loads with import(): wait for it, briefly.
  for (let i = 0; i < 100 && !/No days recorded yet/.test(root.textContent); i++) await settle();
  assert.match(root.textContent.slice(-200), /No days recorded yet/);
  assert.deepEqual(
    calls.map(([url, token]) => `${url} ${token}`),
    ['/api/timelapse/days wrong', '/api/timelapse/days tl-token', '/api/timelapse/days tl-token'],
  );
  assert.deepEqual(
    [...root.querySelectorAll('.side nav a')].map((a) => a.textContent.trim()),
    ['Timelapse'],
  );
  assert.equal(sessionStorage.getItem('terminus-timelapse-only'), '1');

  // Another section's address still shows the Timelapse: the token opens nothing else.
  location.hash = '#/reports';
  await settle(10);
  assert.equal(root.querySelector('.dash-h h1')?.textContent, 'Timelapse');
  assert.equal(calls.length, 3, 'no stats asked for');

  root.querySelector('.side-foot button')?.click();
  await settle();
  assert.equal(Boolean(root.querySelector('.side')), false, 'locked');
  assert.equal(sessionStorage.getItem('terminus-timelapse-only'), null);
});

test('the operator reaches the Timelapse when the stats fail: it needs none of them', async (t) => {
  const w = page({ url: 'https://terminus.run/admin/#/timelapse', html: '<div id="admin"></div>' });
  globalThis.Image = w.Image;
  globalThis.sessionStorage = memoryStorage({ 'terminus-operator-token': 'op' });
  globalThis.fetch = async (url) =>
    String(url) === '/api/timelapse/days' ? Response.json({ days: [], recording: null }) : Response.json({}, { status: 500 });
  await web('admin/admin.js?stats-down');
  const root = document.getElementById('admin');
  t.after(() => render(null, root));
  for (let i = 0; i < 100 && !/No days recorded yet/.test(root.textContent); i++) await settle();
  assert.match(root.textContent.slice(-200), /No days recorded yet/);
  // Every other section needs the stats: it says why, with a way to try again.
  location.hash = '#/reports';
  await settle(10);
  assert.match(root.textContent, /The stats answered 500\./);
});

test('a refused timelapse token leaves the address as it was', async (t) => {
  page({ url: 'https://terminus.run/admin/#/reports', html: '<div id="admin"></div>' });
  globalThis.sessionStorage = memoryStorage();
  globalThis.fetch = async () => Response.json({}, { status: 404 });
  await web('admin/admin.js?refused');
  const root = document.getElementById('admin');
  t.after(() => render(null, root));
  await settle();
  const box = root.querySelector('#timelapse-token');
  box.value = 'wrong';
  box.closest('form').dispatchEvent(new Event('submit', { cancelable: true }));
  await settle(10);
  assert.match(root.querySelector('.gate-msg')?.textContent ?? '', /timelapse token was not accepted/);
  assert.equal(location.hash, '#/reports');
});
