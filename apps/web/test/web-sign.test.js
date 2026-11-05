/**
 * A stop's sign (apps/web/public/app/sign.js), as the Stops tab's pinned
 * card draws it: with nothing running, the services that call there are
 * listed greyed, with when each starts again, and still open their line.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { page, settle } from './_dom.mjs';
import { useLang, web } from './_web.mjs';

useLang('en');
page({ url: 'https://terminus.run/app/#buses', html: '<div id="root"></div>' });

const S = await web('app/sign.js');
const { html, render } = await web('assets/ui.js');

const row = (svc, over) => ({
  svc,
  etaS: 240,
  quality: 'live',
  ambiguousBerth: false,
  later: [],
  color: '#d93636',
  towards: ['KR MRT'],
  via: [],
  crowd: null,
  endsAt: null,
  running: true,
  eta: '4 min',
  laterText: null,
  toText: 'to KR MRT',
  ...over,
});
const stopped = (svc) =>
  row(svc, {
    etaS: null,
    quality: 'ended',
    running: false,
    stopped: 'ended',
    resumesAt: new Date(Date.now() + 8 * 3600_000).toISOString(),
    eta: null,
  });
const sign = (board) => ({ stop: { code: 'PGP', name: 'PGP', longName: 'PGP' }, walkS: null, available: true, board });

const draw = async (board, onLine = () => {}) => {
  const root = document.getElementById('root');
  render(html`<${S.StopSign} s=${sign(board)} pinned=${null} onStop=${() => {}} onLine=${onLine} />`, root);
  await settle();
  return root;
};

test('nothing running: the services that call there, greyed, each with when it starts again, opening its line', async () => {
  const opened = [];
  const root = await draw([stopped('A1'), stopped('D2')], (svc, at) => opened.push([svc, at]));
  assert.ok(root.textContent.includes('No buses due'));
  const rows = [...root.querySelectorAll('.bt-row.stopped')];
  assert.deepEqual(
    rows.map((r) => r.querySelector('.bt-chip').textContent.trim()),
    ['A1', 'D2'],
  );
  assert.ok(rows[0].textContent.includes('Stopped for today'));
  assert.match(rows[0].textContent, /Starts at|Back tomorrow at/);
  rows[1].click();
  assert.deepEqual(opened, [['D2', 'PGP']]);
  render(null, root);
});

test('something running: only the running services, as Nearby shows them', async () => {
  const root = await draw([row('A1'), stopped('D2')]);
  assert.equal(root.querySelectorAll('.nearby-row').length, 1);
  assert.equal(root.querySelectorAll('.bt-row.stopped').length, 0);
  assert.ok(!root.textContent.includes('D2'));
  render(null, root);
});

test('a public bus that has stopped: no line to open, as when it runs', async () => {
  const opened = [];
  const root = await draw([{ ...stopped('95'), paid: true, color: null }], (svc) => opened.push(svc));
  const r = root.querySelector('.bt-row.stopped');
  assert.equal(r.tagName, 'DIV');
  r.click();
  assert.deepEqual(opened, []);
  render(null, root);
});

test('no live data: says so, without the stopped services', async () => {
  const root = document.getElementById('root');
  render(
    html`<${S.StopSign} s=${{ ...sign([stopped('A1')]), available: false }} pinned=${null} onStop=${() => {}} onLine=${() => {}} />`,
    root,
  );
  await settle();
  assert.ok(root.textContent.includes('No times right now'));
  assert.equal(root.querySelectorAll('.bt-row.stopped').length, 0);
  render(null, root);
});
