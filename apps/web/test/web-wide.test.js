/**
 * The web app in a wide window (docs/agents/window-sizes.md): the same
 * widths in every file that lays it out, the rail in place of the bar, and
 * the Stops tab as list and detail (apps/web/public/app/buses.js).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { page, settle } from './_dom.mjs';
import { read, useLang, web } from './_web.mjs';

/** The body of the first rule for exactly `sel` inside the `@media (min-width: 800px)` blocks of `css`. */
function wideRule(css, sel) {
  for (const block of css.split('@media (min-width: 800px) {').slice(1)) {
    const at = block.indexOf(`\n  ${sel} {`);
    if (at >= 0) return block.slice(block.indexOf('{', at) + 1, block.indexOf('}', at));
  }
  return null;
}

test('the bar along the bottom is a rail down the left edge from 800 wide, and the page starts after it', () => {
  const css = read('assets/tabbar.css');
  assert.match(wideRule(css, '.tabbar'), /flex-direction: column/);
  assert.match(wideRule(css, '.tabbar'), /width: var\(--rail-w\)/);
  assert.match(wideRule(css, 'body.app'), /padding-left: var\(--rail-w\)/);
  // Nothing sits above a bar that isn't there: the map, the toast and Settings' forms reach the bottom.
  assert.match(wideRule(css, ':root'), /--tabbar-h: 0px/);
});

test("Now's sky, the horizon and Settings' bands reach the page's edges beside the rail, not the window's", () => {
  const css = read('app/app.css');
  const half = ':root { --half: calc((100vw - var(--rail-w, 0px)) / 2); }';
  assert.ok(css.includes(half));
  // Every other reach to the edges goes through --half.
  assert.deepEqual(css.replace(half, '').match(/\b(50|100)vw\b/g), null);
  assert.match(css, /\.map-tab \{[^}]*inset: 0 0 calc\(var\(--tabbar-h\) \+ env\(safe-area-inset-bottom\)\) var\(--rail-w\)/);
});

test('every part of the app switches to two panes at the same width', () => {
  const queries = (src) => [...src.matchAll(/min-width: (\d+)px/g)].map((m) => Number(m[1]));
  for (const file of ['app/app.js', 'app/buses.js']) assert.deepEqual([...new Set(queries(read(file)))], [800], file);
  // Settings: side by side from 800; the account page's third column from 1100.
  assert.deepEqual([...new Set(queries(read('account/settings.js')))].sort(), [1100, 800]);
  const account = read('account/account.css');
  assert.match(account, /@media \(max-width: 799\.98px\) \{\n {2}\.settings\.page-open/);
  assert.match(account, /@media \(min-width: 800px\) \{\n {2}\/\* At least 20rem/);
  assert.doesNotMatch(account, /899\.98px/);
});

test('dialogs are centred from 600 wide and at most 560 wide; sign-in and setup stay in the 560 column', () => {
  const account = read('account/account.css');
  assert.match(account, /@media \(min-width: 600px\) \{ \.report-sheet \{ inset: 0; margin: auto;/);
  const max = Number(/\.report-sheet \{[^}]*max-width: (\d+)px/.exec(account)[1]);
  assert.ok(max <= 560, `report sheet ${max} wide`);
  // The wrap's 16 px gutters each side make these 560 in all.
  assert.match(account, /\.signin-step \{ max-width: 528px;/);
  assert.match(account, /\.onboard \{ max-width: 528px;/);
  assert.doesNotMatch(account, /\.signin-step \{[^}]*grid-template-columns/);
  assert.match(read('pair/index.html'), /main \{ padding-top: 12px; max-width: 560px; \}/);
});

useLang('en');
page({ url: 'https://terminus.run/app/#buses', html: '<div id="root"></div>' });
globalThis.ResizeObserver ??= class {
  observe() {}
  disconnect() {}
};
// A window 1280 wide.
globalThis.matchMedia = (q) => {
  const min = /min-width: (\d+)px/.exec(q);
  return { matches: Boolean(min) && Number(min[1]) <= 1280, addEventListener() {}, removeEventListener() {} };
};
const B = await web('app/buses.js');
const P = await web('account/profile.js');
const { html, render } = await web('assets/ui.js');

P.campus.set({
  stops: ['KTR', 'LT13', 'AS5'].map((code) => ({ code, name: code, longName: code, services: ['A1'] })),
  routes: { A1: { seq: ['KTR', 'LT13', 'AS5'], loop: true, color: '#d32f2f', name: 'Loop from KR Bus Ter' } },
});
P.profile.set({ pinnedStops: [] });
// No feed here: nothing answers, so a line is drawn from the campus data.
globalThis.fetch = () => new Promise(() => {});

const root = document.getElementById('root');
const detail = () => root.querySelector('.bt-detail');
const go = async (hash) => {
  location.hash = hash;
  dispatchEvent(new Event('hashchange'));
  await settle();
};

test('Stops in a wide window: the home beside the page opened from it, Back only for a page opened from a page', async () => {
  B.route.set({ kind: 'home' });
  render(html`<${B.BusesTab} visible=${false} />`, root);
  await settle();
  assert.ok(root.querySelector('.bt-split .bt-list .bt-services'), 'the home on the left');
  assert.equal(detail().querySelector('.bt-choose').textContent, 'Choose a stop or a service.');

  // A service picked on the home: its line beside it, the row marked, no Back.
  root.querySelector('.bt-list .bt-service').click();
  await go(location.hash);
  assert.equal(location.hash, '#buses/line/A1');
  assert.equal(detail().querySelector('.bt-head').textContent, 'A1');
  assert.equal(detail().querySelector('.bt-back'), null);
  assert.equal(root.querySelector('.bt-list .bt-service').getAttribute('aria-current'), 'true');
  assert.ok(root.querySelector('.bt-list .bt-services'), 'the home still there');

  // A stop on that line: its page beside the home, with Back to the line.
  detail().querySelector('.bt-stop button').click();
  await go(location.hash);
  assert.equal(location.hash, '#buses/stop/KTR');
  assert.equal(detail().querySelector('.bt-back').getAttribute('aria-label'), 'Back to A1');
  assert.equal(root.querySelector('.bt-list .bt-service').getAttribute('aria-current'), null);

  // The service picked on the home again, with that stop open: the line takes the stop's place, still no Back.
  root.querySelector('.bt-list .bt-service').click();
  await go(location.hash);
  assert.equal(location.hash, '#buses/line/A1');
  assert.equal(detail().querySelector('.bt-back'), null);
  render(null, root);
  await settle();
});
