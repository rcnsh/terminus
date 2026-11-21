import test from 'node:test';
import assert from 'node:assert/strict';
import { page, settle } from './_dom.mjs';
import { read, useLang, web } from './_web.mjs';

function shortBlock(css) {
  const open = '\n@media (max-height: 499.98px) {\n';
  const at = css.indexOf(open);
  return at < 0 ? null : css.slice(at + open.length - 1, css.indexOf('\n}', at));
}

useLang('en');
page({ url: 'https://terminus.run/app/', html: '<div id="root"></div>' });
globalThis.ResizeObserver ??= class {
  observe() {}
  disconnect() {}
};
let h = 844;
globalThis.matchMedia = (q) => {
  const max = /max-height: ([\d.]+)px/.exec(q);
  return { matches: Boolean(max) && h <= Number(max[1]), addEventListener() {}, removeEventListener() {} };
};
const ui = await web('assets/ui.js');
const { Horizon } = await web('account/sky.js');

test('short is a window under 500 tall, asked for with the same query in JS and CSS', () => {
  assert.equal(ui.shortBelow, 500);
  assert.equal(ui.SHORT, '(max-height: 499.98px)');
  assert.ok(shortBlock(read('app/app.css')), 'app.css has no short block');
  for (const f of ['app/app.js', 'app/buses.js', 'account/sky.js', 'account/settings.js']) assert.doesNotMatch(read(f), /max-height/, f);
});

async function horizonIn(tall, props) {
  h = tall;
  const root = document.getElementById('root');
  ui.render(null, root);
  ui.render(ui.html`<${Horizon} ...${props} />`, root);
  await settle();
  return root.querySelector('.horizon').className;
}

test("Now's horizon is the low one (just the hills) in a short window, and the full scene otherwise", async () => {
  assert.equal(await horizonIn(844, {}), 'horizon');
  assert.equal(await horizonIn(499, {}), 'horizon low');
  assert.equal(await horizonIn(390, { stop: true, bus: { far: 0.5 } }), 'horizon low');
  assert.equal(await horizonIn(500, {}), 'horizon');
  assert.equal(await horizonIn(390, { on: null }), 'horizon');
  assert.equal(await horizonIn(844, { on: null, low: true }), 'horizon low');
});

test("in a short window the wordmark leads the chips' row, in place of the header", () => {
  const app = read('app/app.js');
  const chips = app.slice(app.indexOf('function Chips()'), app.indexOf('function Where()'));
  assert.match(chips, /const short = useShort\(\);/);
  assert.match(
    chips,
    /role="group"[^>]*>\s*\$\{short && html`<a class="brand" href="\/app\/">[^`]*<span class="wordmark">termi<b>nus<\/b><\/span><\/a>`\}\s*\$\{chip\(t\('Next'\)/,
  );
  const css = shortBlock(read('app/app.css'));
  assert.match(css, /\n {2}body\.app > \.nav \{ display: none; \}/);
});

test('notices sit above the chips in a tall window, and after the card and Go later in a short one', () => {
  const app = read('app/app.js');
  const main = app.slice(app.indexOf('<main class=${split'), app.indexOf('</main>'));
  assert.match(main, /\$\{!short && notices\}\s*<\$\{Chips\} \/>/);
  assert.match(main, /<\$\{CardArea\} \/>\s*<\$\{GoLater\} \/>\s*\$\{short && html`<div class="short-notices">\$\{notices\}<\/div>`\}/);
  assert.match(app, /const notices = html`<\$\{InstallHint\} \/><\$\{Banner\} \/>`;/);
  assert.equal(app.match(/<\$\{InstallHint\} \/>/g).length, 1);
  assert.equal(app.match(/<\$\{Banner\} \/>/g).length, 1);
  assert.match(read('app/app.css'), /\.app-main\.split > :is\(\.go-later, \.go-later-form, \.short-notices\) \{ grid-column: 1; \}/);
});

test("in a short window the bands on Stops and Settings drop their hills, and Now's sky reaches the low one", () => {
  const css = shortBlock(read('app/app.css'));
  assert.match(css, /\n {2}\.page-band \.horizon\.low, \.bt-sky \.horizon\.low \{ display: none; \}/);
  assert.match(css, /\n {2}#tab-now \.horizon\.low \{ height: 52px; \}/);
  assert.match(css, /\n {2}body\.sky-night \.bt-sky \.celestial \.night-sky \{ display: none; \}/);
  assert.match(css, /\n {2}body\.sky #tab-now::before \{ height: calc\(var\(--end\) - 2px\); \}/);
  assert.doesNotMatch(css, /font-size|max-height|overflow: hidden|100dvh|100vh/);
});
