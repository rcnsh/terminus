/**
 * The web app in a short window, under 500 tall (docs/agents/window-sizes.md):
 * a phone on its side. The width still picks the layout; only the top of
 * the page goes compact. Now's horizon is the low one, the wordmark leads
 * the chips' row, notices go under the card's buttons, and the bands on
 * Stops and Settings end under their words.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { page, settle } from './_dom.mjs';
import { read, useLang, web } from './_web.mjs';

/** The body of the `@media (max-height: 499.98px)` block in `css`, or null. */
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
/** A window `h` tall, answering max-height queries as a browser would. */
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
  // Height is asked for nowhere else: one rule for the whole app.
  for (const f of ['app/app.js', 'app/buses.js', 'account/sky.js', 'account/settings.js']) assert.doesNotMatch(read(f), /max-height/, f);
});

/** The class of the horizon drawn for `props` in a window `tall` px tall. */
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
  // A horizon in a sky of its own (the website's pages) keeps what it asked for.
  assert.equal(await horizonIn(390, { on: null }), 'horizon');
  assert.equal(await horizonIn(844, { on: null, low: true }), 'horizon low');
});

test("in a short window the wordmark leads the chips' row, in place of the header", () => {
  const app = read('app/app.js');
  const chips = app.slice(app.indexOf('function Chips()'), app.indexOf('function Where()'));
  assert.match(chips, /const short = useShort\(\);/);
  // First in the row, before Next.
  assert.match(
    chips,
    /role="group"[^>]*>\s*\$\{short && html`<a class="brand" href="\/app\/">[^`]*<span class="wordmark">termi<b>nus<\/b><\/span><\/a>`\}\s*\$\{chip\(t\('Next'\)/,
  );
  const css = shortBlock(read('app/app.css'));
  assert.match(css, /\n {2}body\.app > \.nav \{ display: none; \}/);
});

test("notices sit above the chips in a tall window, and under the card's buttons in a short one", () => {
  const app = read('app/app.js');
  const main = app.slice(app.indexOf('<main class=${split'), app.indexOf('</main>'));
  // Above the chips only when not short; handed to the card when short, and nowhere else.
  assert.match(main, /\$\{!short && notices\}\s*<\$\{Chips\} \/>/);
  assert.match(main, /<\$\{CardArea\} notices=\$\{short \? notices : null\} \/>/);
  assert.match(app, /const notices = html`<\$\{InstallHint\} \/><\$\{Banner\} \/>`;/);
  assert.equal(app.match(/<\$\{InstallHint\} \/>/g).length, 1);
  assert.equal(app.match(/<\$\{Banner\} \/>/g).length, 1);
  // In the card: after its body (the steps and buttons), before its foot.
  assert.match(app, /\$\{body\}\s*\$\{notices\}\s*<\$\{CardFoot\} \/>/);
});

test("in a short window the bands on Stops and Settings drop their hills, and Now's sky reaches the low one", () => {
  const css = shortBlock(read('app/app.css'));
  assert.match(css, /\n {2}\.page-band \.horizon\.low, \.bt-sky \.horizon\.low \{ display: none; \}/);
  assert.match(css, /\n {2}#tab-now \.horizon\.low \{ height: 52px; \}/);
  assert.match(css, /\n {2}body\.sky #tab-now::before \{ height: calc\(var\(--end\) - 2px\); \}/);
  // Nothing gets a fixed height or a smaller font: content still scrolls, controls keep their sizes.
  assert.doesNotMatch(css, /font-size|max-height|overflow: hidden|100dvh|100vh/);
});
