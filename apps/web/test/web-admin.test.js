// The operator dashboard (admin/): what its pages work out from /api/admin/stats.
import test from 'node:test';
import assert from 'node:assert/strict';
import { page, settle } from './_dom.mjs';
import { memoryStorage, web } from './_web.mjs';

const { derive } = await web('admin/views.js');
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

/** A fetch whose /api/admin/stats answers wait for the test: `asked[i].answer(status, body)`. */
const asked = [];
const deferred = () => {
  const d = {};
  d.promise = new Promise((resolve) => (d.answer = (status, body = {}) => resolve(Response.json(body, { status }))));
  return d;
};
const STATS = { now: '2026-10-23T02:00:00Z', accounts: { total: 3 } };

test('the dashboard: a failed first load can be tried again', async (t) => {
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
});
