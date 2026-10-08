/**
 * Pull to refresh in the web app (apps/web/public/app/pull.js): how far the
 * sky stretches for a finger, where the bus is on the horizon, the words, and the
 * Buses tab fetching again only when its times are old enough to change.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { useLang, web } from './_web.mjs';

useLang('en');
const { OFF_LEFT, PULL, busAt, groundAt, pullWords, rubber, stopAt } = await web('app/pull.js');
const { PULL_FRESH_MS } = await web('app/timing.js');
const { signX } = await web('account/sky.js');
const B = await web('app/buses.js');
const { t } = await web('account/dom.js');

test('the sky follows the finger less the further it goes, and never past its most', () => {
  assert.equal(rubber(0), 0);
  assert.equal(rubber(-40), 0, 'a finger moving up is no pull');
  let last = 0;
  for (const raw of [20, 60, 120, 240, 600, 5000]) {
    const p = rubber(raw);
    assert.ok(p > last && p < raw, `${raw} px of finger`);
    last = p;
  }
  assert.ok(rubber(10_000) <= PULL.max);
  // Arming takes a deliberate pull: more finger than sky, but not a long reach.
  const raw = [...Array(400).keys()].find((r) => rubber(r) >= PULL.arm);
  assert.ok(raw > PULL.arm && raw < 160, `armed after ${raw} px`);
});

test('the bus drives from where the horizon had it to your stop, reaching it just as the pull arms', () => {
  // Horizons as wide as phones and a laptop, in their own numbers (Now's is drawn 1.25 times bigger).
  for (const vw of [288, 312, 344, 640]) {
    const stop = stopAt(vw);
    assert.ok(stop + 38 < signX(vw), 'it pulls up short of the sign');
    for (const from of [OFF_LEFT, 56, stop]) {
      assert.equal(busAt(0, from, vw), from, 'it starts where it was');
      assert.equal(busAt(PULL.arm, from, vw), stop);
      assert.equal(busAt(PULL.max, from, vw), stop, 'and stays there pulled further');
      let last = -Infinity;
      for (let p = 0; p <= PULL.arm; p += 7) {
        assert.ok(busAt(p, from, vw) >= last, 'only ever forwards');
        last = busAt(p, from, vw);
      }
    }
    // A bus already past the stop waits where it is.
    assert.equal(busAt(PULL.arm, stop + 10, vw), stop + 10);
  }
});

test('on a low horizon the bus stands on the hill, tilted with it; on Now the road', () => {
  assert.deepEqual(groundAt(120, false), { y: 70, tilt: 0 });
  for (let x = -40; x < 400; x += 13) {
    const g = groundAt(x, true);
    // The low horizon shows y 6 to 58: the hilltop is inside it, and never steep.
    assert.ok(g.y > 40 && g.y < 58, `ground at ${x}`);
    assert.ok(Math.abs(g.tilt) < 25, `tilt at ${x}`);
  }
});

test('the words say what letting go does, then how it went, in English and Chinese', () => {
  for (const lang of ['en', 'zh']) {
    useLang(lang);
    const all = ['pull', 'armed', 'busy', 'updated', 'fresh', 'failed'].map(pullWords);
    assert.equal(new Set(all).size, all.length, 'each says something different');
    assert.equal(pullWords('busy'), t('Checking…'));
  }
  useLang('zh');
  assert.equal(pullWords('pull'), '下拉刷新');
  assert.equal(pullWords('fresh'), '已是最新');
  useLang('en');
  assert.equal(pullWords('armed'), 'Let go to refresh');
  assert.equal(pullWords('failed'), "Couldn't update");
});

test('Buses fetches again on a pull only when its times are old enough to change', async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  const nearby = () =>
    new Response(JSON.stringify({ stops: [{ stop: { code: 'YIH', name: 'YIH' }, board: [], available: true, distM: 40 }] }), { headers: { 'content-type': 'application/json' } });
  globalThis.fetch = async () => (calls++, nearby());
  try {
    B.nearest.set({ status: 'ready', code: 'YIH', distM: 40 });
    B.boards.set(new Map([['YIH', { stop: { code: 'YIH' }, board: [], at: Date.now() - 2_000 }]]));
    assert.equal(await B.pullRefresh(), 'fresh');
    assert.equal(calls, 0, 'times 2 s old: the server would send the same ones');

    B.boards.set(new Map([['YIH', { stop: { code: 'YIH' }, board: [], at: Date.now() - PULL_FRESH_MS - 1 }]]));
    assert.equal(await B.pullRefresh(), 'updated');
    assert.equal(calls, 1, 'one fetch for one pull');

    B.boards.set(new Map([['YIH', { stop: { code: 'YIH' }, board: [], at: Date.now() - PULL_FRESH_MS - 1 }]]));
    globalThis.fetch = async () => new Response('{}', { status: 503, headers: { 'content-type': 'application/json' } });
    assert.equal(await B.pullRefresh(), 'failed');
  } finally {
    globalThis.fetch = realFetch;
    B.boards.set(new Map());
    B.nearest.set({ status: 'loading' });
  }
});
