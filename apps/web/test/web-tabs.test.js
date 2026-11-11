/**
 * The web app's tabs (apps/web/public/app/tabs.js): which one an address
 * opens, and that the bar, the sections and the styles each know all five.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { TABS, tabOf } from '../public/app/tabs.js';

const read = (f) => readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8');

test('Nearby is a tab of its own, second in the bar', () => {
  assert.deepEqual(TABS, ['now', 'nearby', 'buses', 'map', 'settings']);
});

test('an address opens its tab, and Now when it names none', () => {
  assert.equal(tabOf('#nearby'), 'nearby');
  assert.equal(tabOf('#buses'), 'buses');
  assert.equal(tabOf('#buses/stop/COM3'), 'buses');
  assert.equal(tabOf('#buses/line/D1/COM3'), 'buses');
  assert.equal(tabOf('#map'), 'map');
  assert.equal(tabOf('#settings/trips'), 'settings');
  assert.equal(tabOf('#now'), 'now');
  assert.equal(tabOf(''), 'now');
  assert.equal(tabOf('#somewhere-else'), 'now');
});

test('the bar links every tab, in order, and each has its section', () => {
  const src = read('app/app.js');
  const bar = /const TABBAR = \[([\s\S]*?)\n\];/.exec(src)[1];
  assert.deepEqual(
    [...bar.matchAll(/id: '(\w+)'/g)].map((m) => m[1]),
    TABS,
  );
  for (const id of TABS) {
    assert.match(bar, new RegExp(`href: '#${id}'`), id);
    assert.match(src, new RegExp(`<main [^>]*id="tab-${id}"[^>]*ref=\\$\\{keep\\('${id}'\\)\\}`), id);
  }
});

test('Now has no Nearby chip: its chips are places to go', () => {
  const chips = /function Chips\(\) \{([\s\S]*?)\n\}/.exec(read('app/app.js'))[1];
  assert.doesNotMatch(chips, /Nearby|nearby/);
});

test('Nearby draws its own top, so the header and the sky’s ink on it are off there, as on Stops', () => {
  const css = read('app/app.css');
  assert.match(css, /body\.on-buses > \.nav, body\.on-nearby > \.nav \{ display: none; \}/);
  assert.doesNotMatch(css, /:not\(\.on-map, \.on-settings, \.on-buses\)/);
});
