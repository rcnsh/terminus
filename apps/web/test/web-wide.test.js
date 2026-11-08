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

test("Now's Today column ends where the card's does, not at the page's padding", () => {
  assert.match(wideRule(read('app/app.css'), '.app-main.split > .now-side'), /grid-column: 2 \/ 3;/);
});

test('Settings keeps to the 560 column under 800, as Now and Stops do, and takes the window from 800', () => {
  const css = read('app/app.css');
  assert.match(css, /\n\.settings-tab \{ max-width: 560px; padding-bottom: 32px; \}/);
  assert.match(wideRule(css, '.settings-tab'), /max-width: none;/);
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
  assert.match(account, /@media \(min-width: 600px\) \{\n {2}\.report-sheet \{ inset: 0; margin: auto;/);
  const max = Number(/\.report-sheet \{[^}]*max-width: (\d+)px/.exec(account)[1]);
  assert.ok(max <= 560, `report sheet ${max} wide`);
  // The wrap's 16 px gutters each side make these 560 in all.
  assert.match(account, /\.signin-step \{ max-width: 528px;/);
  assert.match(account, /\.onboard \{ max-width: 528px;/);
  assert.doesNotMatch(account, /\.signin-step \{[^}]*grid-template-columns/);
  assert.match(read('pair/index.html'), /main \{ padding-top: 12px; max-width: 560px; \}/);
});

test('chosen is a rounded fill of the accent and nothing else, and only the trailing pane has a moon', () => {
  const css = read('app/app.css');
  const account = read('account/account.css');
  assert.match(read('assets/site.css'), /--chosen: color-mix\(in srgb, var\(--accent\) 12%, transparent\);/);
  const stops = /\n {2}\.bt-split :is\(\.bt-service, \.bt-result\)\[aria-current\][^{]*\{([^}]*)\}/.exec(css)[1];
  assert.match(stops, /border-radius: 12px; background: var\(--chosen\);/);
  assert.match(css, /\.bt-pager-page\.open \.stop-sign \.plate \{ border-color: transparent; background: var\(--chosen\); \}/);
  assert.match(account, /\.settings-row\[aria-current\] \{ background: var\(--chosen\); \}/);
  // No bar, no outline, no coloured chevron.
  assert.doesNotMatch(css + account, /aria-current\][^{]*\{[^}]*(box-shadow|border-color|outline)/);
  assert.doesNotMatch(css + account, /aria-current\] \.chev/);
  assert.match(css, /\.bt-list \.celestial, \.settings-tab \.settings-side \.celestial \{ display: none; \}/);
});

test("Elsewhere sits at the trailing end of the chips' row, and the report's foot is placed beside, never moved", () => {
  const css = read('app/app.css');
  assert.match(css, /\.app-chips \.chip-search \{[^}]*margin-left: auto;/);
  assert.match(wideRule(css, '.app-main.split .app-card > .card-foot.card-foot'), /position: absolute;/);
  // One CardFoot, always in the card: Now going between one column and two doesn't remount the report.
  const app = read('app/app.js');
  assert.equal(app.match(/<\$\{CardFoot\} \/>/g).length, 1);
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

test('Stops search in a wide window: its results take the home pane, as rows with the code and services', async () => {
  B.route.set({ kind: 'home' });
  render(html`<${B.BusesTab} visible=${false} />`, root);
  await settle();
  B.findText.set('lt');
  await settle();
  assert.equal(root.querySelector('.bt-list .bt-no-pins, .bt-list .bt-pins'), null, 'the home gone');
  const hit = root.querySelector('.bt-list #bt-results .bt-result-stop');
  assert.equal(hit.querySelector('.bt-result-name').textContent, 'LT13');
  assert.equal(hit.querySelector('.bt-result-code').textContent, 'LT13');
  assert.deepEqual(
    [...hit.querySelectorAll('.svc-tag')].map((x) => x.textContent.trim()),
    ['A1'],
  );
  hit.click();
  await go(location.hash);
  assert.equal(location.hash, '#buses/stop/LT13');
  assert.equal(root.querySelector('.bt-list #bt-results .bt-result-stop').getAttribute('aria-current'), 'true');
  // Cleared: the home again.
  B.findText.set('');
  await settle();
  assert.equal(root.querySelector('#bt-results'), null);
  render(null, root);
  await settle();
});

test('beside the home, the open pinned stop is asked for by its page alone once its card has times', async () => {
  P.profile.set({ pinnedStops: ['KTR', 'LT13'] });
  B.chosen.set('KTR');
  B.route.set({ kind: 'stop', code: 'KTR' });
  render(html`<${B.BusesTab} visible=${false} />`, root);
  await settle();
  B.signs.set(new Map());
  assert.deepEqual(B.signsToAsk(), ['KTR', 'LT13'], 'no times yet: asked once');
  B.signs.set(new Map([['KTR', { s: { stop: { code: 'KTR', name: 'KTR' }, board: [] }, at: Date.now(), got: Date.now() }]]));
  assert.deepEqual(B.signsToAsk(), ['LT13']);
  render(null, root);
  await settle();
  P.profile.set({ pinnedStops: [] });
});

test('the open pinned card shows the times its page has', async () => {
  const now = Date.now();
  const card = {
    stop: { code: 'KTR', name: 'KTR', longName: 'KTR' },
    walkS: null,
    available: true,
    board: [
      {
        svc: 'A1',
        dest: 'to LT13',
        destPlace: 'LT13',
        etaS: 900,
        quality: 'scheduled',
        later: [
          { etaS: 1500, quality: 'scheduled' },
          { etaS: 2100, quality: 'scheduled' },
        ],
      },
    ],
  };
  P.profile.set({ pinnedStops: ['KTR', 'LT13'] });
  B.chosen.set('KTR');
  B.route.set({ kind: 'stop', code: 'KTR' });
  B.signs.set(new Map([['KTR', { s: card, at: now - 1000, got: now - 1000 }]]));
  // The page's board: live, two buses.
  B.boards.set(
    new Map([
      [
        'KTR',
        {
          stop: { code: 'KTR', name: 'KTR' },
          board: [{ svc: 'A1', etaS: 120, quality: 'live', later: [{ etaS: 720, quality: 'live' }] }],
          available: true,
          at: now,
          got: now,
        },
      ],
    ]),
  );
  render(html`<${B.BusesTab} visible=${false} />`, root);
  await settle();
  const row = root.querySelector('.bt-list .bt-pager-page.open .nearby-row');
  const times = [...row.querySelectorAll('.nb-time')].map((x) => x.textContent.replace(/\s+/g, ''));
  // The page's two live buses stand for the card's first two; then its own guess for the third. Its own words for where it goes.
  assert.deepEqual(times, ['2min', '12', '~35']);
  assert.match(row.textContent, /LT13/);
  render(null, root);
  await settle();
  B.boards.set(new Map());
  B.signs.set(new Map());
  P.profile.set({ pinnedStops: [] });
});

test("wide Settings keeps the phone's grouped cards and chevrons, and Now's foot lines up with Today", () => {
  const account = read('account/account.css');
  // From 800 the groups stay cards with chevrons; only what each has set moves under its name.
  assert.equal(wideRule(account, '.set-group'), null);
  assert.equal(wideRule(account, '.set-item .chev'), null);
  assert.match(wideRule(account, '.set-item .row-text'), /display: grid;/);
  // Send feedback is its name alone at every width.
  assert.match(account, /\n\.set-item\[data-page="feedback"\] \.row-sum \{ display: none; \}/);
  assert.match(wideRule(read('app/app.css'), '.app-main.split .app-card > .card-foot.card-foot'), /left: calc\(50% \+ 24px\);/);
});

test("a kept older /app/ without the rail's place still starts: the app makes it, ahead of the header", () => {
  const src = read('app/app.js');
  assert.doesNotMatch(src, /render\([^\n]*getElementById\('rail'\)\)/);
  assert.match(src, /render\(html`<\$\{Rail\} \/>`, railRoot\(\)\);/);
  const fn = src.slice(src.indexOf('function railRoot() {'), src.indexOf('\n}\n', src.indexOf('function railRoot() {')) + 2);
  const railRoot = new Function(`${fn}; return railRoot;`)();
  const kept = [...document.body.childNodes];
  document.body.innerHTML = '<script></script><header class="wrap nav"></header><div id="app"></div>';
  const made = railRoot();
  assert.equal(made.id, 'rail');
  assert.equal(made.nextElementSibling.tagName, 'HEADER');
  // Found the second time, not made again.
  assert.equal(railRoot(), made);
  assert.equal(document.querySelectorAll('#rail').length, 1);
  document.body.replaceChildren(...kept);
});

test('the open card counts its own guesses on to the board, and never fills in with an old live time', () => {
  const card = {
    stop: { code: 'KTR' },
    board: [
      {
        svc: 'A1',
        etaS: 180,
        quality: 'live',
        later: [
          { etaS: 600, quality: 'live' },
          { etaS: 2700, quality: 'scheduled' },
          { etaS: 3300, quality: 'scheduled' },
        ],
      },
      { svc: 'D2', etaS: 240, eta: '4 min', quality: 'live', later: [{ etaS: 1500, quality: 'scheduled' }] },
    ],
  };
  // Three minutes on, the page's board has one A1 bus and no D2.
  const board = { board: [{ svc: 'A1', etaS: 720, eta: '12 min', quality: 'live', later: [] }], available: true, got: 180_000 };
  const [a1, d2] = B.withBoard(card, 0, board).board;
  assert.equal(a1.etaS, 720);
  // The card's live 600 is three minutes old: not filled in. Its guesses are counted on by 180 s, as estimates.
  assert.deepEqual(
    a1.later.map((x) => [x.etaS, x.quality, x.eta]),
    [
      [2520, 'scheduled', null],
      [3120, 'scheduled', null],
    ],
  );
  // A service the board doesn't have: counted on, and its live time a "~", not live.
  assert.deepEqual([d2.etaS, d2.quality, d2.eta], [60, 'stale', null]);
  assert.deepEqual(
    d2.later.map((x) => x.etaS),
    [1320],
  );
  // A guess due before the board's last bus is dropped.
  const soon = B.withBoard(card, 0, {
    ...board,
    board: [{ svc: 'A1', etaS: 120, quality: 'live', later: [{ etaS: 2600, quality: 'live' }] }],
  });
  assert.deepEqual(
    soon.board[0].later.map((x) => x.etaS),
    [2600, 3120],
  );
});

test("the open card counts the board's buses off its own, so a bus running ahead of its guess isn't shown twice", () => {
  const card = {
    stop: { code: 'KTR' },
    board: [
      {
        svc: 'D1',
        etaS: 100,
        quality: 'live',
        later: [
          { etaS: 700, quality: 'live' },
          { etaS: 1300, quality: 'scheduled' },
        ],
      },
    ],
  };
  // 100 s on: the first bus has gone; the board's two are the card's 700 and its guess at 1300, a little early.
  const board = {
    board: [{ svc: 'D1', etaS: 600, quality: 'live', later: [{ etaS: 1150, quality: 'live' }] }],
    available: true,
    got: 100_000,
  };
  const [d1] = B.withBoard(card, 0, board).board;
  assert.equal(d1.etaS, 600);
  assert.deepEqual(
    d1.later.map((x) => [x.etaS, x.quality]),
    [[1150, 'live']],
  );
});

test("a board row with no next bus (ended) takes none of the card's off, so all its guesses stay", () => {
  const card = {
    stop: { code: 'KTR' },
    board: [
      {
        svc: 'D2',
        etaS: 120,
        quality: 'scheduled',
        later: [
          { etaS: 600, quality: 'scheduled' },
          { etaS: 1200, quality: 'scheduled' },
        ],
      },
    ],
  };
  const board = {
    board: [{ svc: 'D2', etaS: null, quality: 'ended', running: false, stopped: 'ended', later: [] }],
    available: true,
    got: 60_000,
  };
  const [d2] = B.withBoard(card, 0, board).board;
  assert.equal(d2.etaS, null);
  assert.deepEqual(
    d2.later.map((x) => [x.etaS, x.quality]),
    [
      [60, 'scheduled'],
      [540, 'scheduled'],
      [1140, 'scheduled'],
    ],
  );
});

test('a pinned stop closing beside the home keeps the live times its page had, with nothing fetched', async () => {
  const now = Date.now();
  const card = {
    stop: { code: 'KTR', name: 'KTR' },
    walkS: null,
    available: true,
    board: [{ svc: 'A1', dest: 'to LT13', etaS: 900, quality: 'scheduled' }],
  };
  P.profile.set({ pinnedStops: ['KTR', 'LT13'] });
  B.chosen.set('KTR');
  B.route.set({ kind: 'stop', code: 'KTR' });
  B.signs.set(new Map([['KTR', { s: card, at: now - 5000, got: now - 5000 }]]));
  B.boards.set(
    new Map([
      [
        'KTR',
        { stop: { code: 'KTR', name: 'KTR' }, board: [{ svc: 'A1', etaS: 120, quality: 'live' }], available: true, at: now, got: now },
      ],
    ]),
  );
  render(html`<${B.BusesTab} visible=${false} />`, root);
  await settle();
  await go('#buses');
  const kept = B.signs.get().get('KTR');
  assert.equal(kept.at, now, 'as fresh as the page, so not asked for again yet');
  assert.deepEqual([kept.s.board[0].etaS, kept.s.board[0].quality, kept.s.board[0].dest], [120, 'live', 'to LT13']);
  const first = root.querySelector('.bt-pager-page[aria-label="KTR"] .nearby-row .nb-time');
  assert.equal(first.textContent.replace(/\s+/g, ''), '2min');
  render(null, root);
  await settle();
  B.boards.set(new Map());
  B.signs.set(new Map());
  P.profile.set({ pinnedStops: [] });
});

test('beside the home, a pinned stop opened from elsewhere is the card the list shows, and marked', async () => {
  P.profile.set({ pinnedStops: ['KTR', 'LT13', 'AS5'] });
  B.chosen.set('KTR');
  B.route.set({ kind: 'stop', code: 'AS5' });
  render(html`<${B.BusesTab} visible=${false} />`, root);
  await settle();
  assert.equal(root.querySelector('.bt-pins input:checked').nextElementSibling.textContent, 'AS5');
  const open = root.querySelector('.bt-pager-page.open');
  assert.equal(open.getAttribute('aria-label'), 'AS5');
  assert.equal(open.getAttribute('aria-current'), 'true');
  render(null, root);
  await settle();
  P.profile.set({ pinnedStops: [] });
});

test("Stops' sky runs edge to edge at every width, the report has Cancel from 600, and the rail comes before the wordmark", () => {
  const css = read('app/app.css');
  assert.doesNotMatch(css, /\.bt-sky-top, \.buses-tab > \.bt-sky/);
  assert.match(css, /\n\.bt-sky \{ margin: 0 calc\(50% - var\(--half\)\); padding: 0 calc\(var\(--half\) - 50%\);/);
  assert.match(
    css,
    /\.bt-split \.bt-pager-page\.open \.stop-sign, \.bt-split \.bt-pager-page\.open \.stop-sign \.plate \{ border-color: transparent; background: var\(--chosen\); \}/,
  );
  const account = read('account/account.css');
  assert.match(
    account,
    /\.report-cancel \{ display: none; \}\n@media \(min-width: 600px\) \{[^@]*\.report-cancel \{ display: inline-flex;/,
  );
  const page = read('app/index.html');
  assert.ok(page.indexOf('<div id="rail"></div>') < page.indexOf('<header class="wrap nav">'));
});
