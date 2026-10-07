/**
 * The band of sky on the Worker's own pages (pagesky.ts) is the web app's
 * sky: the same hours as daylight.js and the same colours as app.css, in
 * both themes, so the page an email links to looks like the apps at that hour.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { phaseAt as webPhaseAt, PHASES } from '../../web/public/account/daylight.js';
import { PAGE_SKIES, bandCss, bandHtml, phaseAt, sgtMinute } from '../src/pagesky.ts';

const css = fs.readFileSync(new URL('../../web/public/app/app.css', import.meta.url), 'utf8');

/** The custom properties set by the rule whose selector is exactly `sel` (at the start of a line, maybe indented). */
function vars(sel) {
  const m = css.match(new RegExp(`\\n\\s*${sel.replace(/[.[\]()"=:]/g, '\\$&')} \\{([^}]*)\\}`));
  assert.ok(m, `no rule for ${sel}`);
  return Object.fromEntries([...m[1].matchAll(/--([\w-]+):\s*([^;]+);/g)].map((x) => [x[1], x[2].trim()]));
}

test("the page's sky keeps the web app's hours", () => {
  for (let min = 0; min < 1440; min++) assert.equal(phaseAt(min), webPhaseAt(min), `minute ${min}`);
  // Singapore is UTC+8: 00:30 UTC is 08:30 there.
  assert.equal(sgtMinute(Date.UTC(2026, 9, 7, 0, 30)), 8 * 60 + 30);
  assert.equal(sgtMinute(Date.UTC(2026, 9, 7, 17, 0)), 60);
});

test("the page's sky has app.css's colours, on a light page and a dark one", () => {
  const night = vars('body.sky');
  const darkNight = vars(':root[data-theme="dark"] body.sky');
  for (const phase of PHASES) {
    const light = phase === 'night' ? night : { ...night, ...vars(`body.sky-${phase}`) };
    const dark = phase === 'night' ? { ...night, ...darkNight } : { ...night, ...darkNight, ...vars(`:root[data-theme="dark"] body.sky-${phase}`) };
    for (const [theme, want] of [['light', light], ['dark', dark]]) {
      const got = PAGE_SKIES[theme][phase];
      assert.deepEqual(got.sky, [want.s0, want.s1, want.s2, want.s3], `${theme} ${phase} sky`);
      assert.deepEqual([got.far, got.tree, got.city], [want['h-far'], want['h-tree'], want['h-city']], `${theme} ${phase} horizon`);
    }
  }
});

test('the band: the mark over the hills, lights on after dark, light words on a dark sky', () => {
  assert.match(bandHtml('day'), /mark\.svg[\s\S]*<svg class="hz"/);
  assert.doesNotMatch(bandHtml('day'), /class="lit"/);
  assert.match(bandHtml('night'), /class="lit"/);
  assert.match(bandCss('day'), /\.band\{[^}]*--band-ink:#1c1917/);
  assert.match(bandCss('dusk'), /\.band\{[^}]*--band-ink:#f5f3f0/);
  // A dark page always has light words.
  assert.match(bandCss('day'), /prefers-color-scheme:dark\)\{\.band\{[^}]*--band-ink:#f5f3f0/);
});
