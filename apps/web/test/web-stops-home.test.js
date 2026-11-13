/**
 * The Stops tab's home as drawn (apps/web/public/app/buses.js): which pinned
 * stop is on screen after one is unpinned, here or on its own page.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { page, settle } from './_dom.mjs';
import { useLang, web } from './_web.mjs';

useLang('en');
page({ url: 'https://terminus.run/app/#buses', html: '<div id="root"></div>' });
// happy-dom has no layout to measure the pager's height with.
globalThis.ResizeObserver ??= class {
  observe() {}
  disconnect() {}
};
const B = await web('app/buses.js');
const P = await web('account/profile.js');
const { html, render } = await web('assets/ui.js');

const STOPS = ['COM3', 'YIH', 'UTOWN'];
P.campus.set({ stops: STOPS.map((code) => ({ code, name: code, longName: code })), routes: {} });
globalThis.fetch = async (url) => {
  const codes = new URL(url, 'http://x').searchParams.get('codes')?.split(',') ?? [];
  const stops = codes.map((code) => ({ stop: { code, name: code, longName: code }, walkS: null, available: true, board: [] }));
  return new Response(JSON.stringify({ stops, asOf: new Date().toISOString() }), { headers: { 'content-type': 'application/json' } });
};

const root = document.getElementById('root');
const shown = () => root.querySelector('.bt-pins input:checked')?.nextElementSibling?.textContent ?? null;
const draw = async () => {
  render(html`<${B.BusesTab} visible=${false} />`, root);
  await settle();
};
const away = async () => {
  render(null, root);
  await settle();
};

test('a stop unpinned on its own page: back on the home, the stop that took its place shows, else the one before it', async () => {
  B.route.set({ kind: 'home' });
  P.profile.set({ pinnedStops: STOPS });
  B.chosen.set('YIH');
  await draw();
  assert.equal(shown(), 'YIH');
  // Off to YIH's page (the home goes), unpinned there with its star, then back.
  await away();
  P.profile.set({ pinnedStops: ['COM3', 'UTOWN'] });
  await draw();
  assert.equal(shown(), 'UTOWN');
  assert.equal(B.chosen.get(), 'UTOWN');

  // The last one unpinned the same way: the one before it.
  await away();
  P.profile.set({ pinnedStops: ['COM3'] });
  await draw();
  assert.equal(shown(), 'COM3');
  await away();
});

test('a stop unpinned with the home on screen: the stop that took its place shows', async () => {
  P.profile.set({ pinnedStops: STOPS });
  B.chosen.set('COM3');
  await draw();
  assert.equal(shown(), 'COM3');
  P.profile.set({ pinnedStops: ['YIH', 'UTOWN'] });
  await settle();
  assert.equal(shown(), 'YIH');
  await away();
});

test('the home opens with its title in the band Nearby and Settings have, its search just under the hills', async () => {
  B.route.set({ kind: 'home' });
  P.profile.set({ pinnedStops: [] });
  await draw();
  const band = root.querySelector('.page-band');
  const find = root.querySelector('.bt-find');
  assert.equal(band?.querySelector('.tab-title').textContent, 'Stops');
  assert.ok(find?.querySelector('input'), 'a search box');
  assert.equal(band.nextElementSibling, find, 'the search straight under the band');
  await away();
});
