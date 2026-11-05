/**
 * The pinned card's height on the Stops tab (apps/web/public/app/buses.js):
 * it keeps the tallest answer, not the skeleton drawn while one comes or the
 * last page, so a one-line "No buses due" at night leaves no gap under it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { page, settle } from './_dom.mjs';
import { useLang, web } from './_web.mjs';

useLang('en');
page({ url: 'https://terminus.run/app/#buses', html: '<div id="root"></div>' });

// happy-dom has no layout: a page is as tall as the test says, the pager as its tallest page.
const SKELETON = 300;
const NO_BUSES = 100;
const PIN_ANOTHER = 180;
const BOARD = 400;
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
  configurable: true,
  get() {
    if (this.classList.contains('bt-pager')) return Math.max(0, ...[...this.children].map((c) => c.offsetHeight));
    if (!this.classList.contains('bt-pager-page')) return 0;
    if (this.querySelector('.bt-add')) return PIN_ANOTHER;
    if (!this.hasAttribute('data-answered')) return SKELETON;
    return this.getAttribute('aria-label') === 'COM3' ? BOARD : NO_BUSES;
  },
});
const observers = [];
globalThis.ResizeObserver = class {
  constructor(fn) {
    this.fn = fn;
    observers.push(this);
  }
  observe() {}
  disconnect() {}
};
const resized = () => observers.forEach((o) => o.fn([]));

const B = await web('app/buses.js');
const P = await web('account/profile.js');
const { html, render } = await web('assets/ui.js');

P.campus.set({
  stops: [
    { code: 'PGP', name: 'PGP', longName: 'Prince George’s Park', services: ['A1', 'A2', 'D2'] },
    { code: 'COM3', name: 'COM3', longName: 'COM3', services: ['D1', 'D2'] },
  ],
  routes: {},
});
let answer;
const answered = new Promise((resolve) => (answer = resolve));
globalThis.fetch = async (url) => {
  await answered;
  const codes = new URL(url, 'http://x').searchParams.get('codes')?.split(',') ?? [];
  const stops = codes.map((code) => ({ stop: { code, name: code, longName: code }, walkS: null, available: true, board: [] }));
  return new Response(JSON.stringify({ stops, asOf: new Date().toISOString() }), { headers: { 'content-type': 'application/json' } });
};

test('a skeleton or the last page does not hold the pinned card open over a one-line answer', async () => {
  const root = document.getElementById('root');
  B.route.set({ kind: 'home' });
  P.profile.set({ pinnedStops: ['PGP'] });
  render(html`<${B.BusesTab} visible=${false} />`, root);
  await settle();
  resized();
  const pager = root.querySelector('.bt-pager');
  assert.ok(pager.textContent.includes('Checking'), 'the stop is still on its way');

  answer();
  await settle(20);
  resized();
  assert.ok(pager.textContent.includes('No buses due'));
  assert.equal(pager.style.height, `${NO_BUSES}px`);
  assert.equal(pager.style.minHeight, '');
  render(null, root);
});

test('the tallest stop unpinned: the card is as tall as the stops left', async () => {
  const root = document.getElementById('root');
  B.chosen.set('PGP');
  P.profile.set({ pinnedStops: ['PGP', 'COM3'] });
  render(html`<${B.BusesTab} visible=${false} />`, root);
  await settle(20);
  resized();
  const pager = root.querySelector('.bt-pager');
  assert.equal(pager.style.height, `${BOARD}px`);

  P.profile.set({ pinnedStops: ['PGP'] });
  await settle(20);
  resized();
  assert.equal(pager.style.height, `${NO_BUSES}px`);
  render(null, root);
});
