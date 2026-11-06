// The unattended renderer (apps/api/scripts/dev/render-timelapse.mjs) drives
// the dashboard's Timelapse by its markup, through the selectors and button
// words in render-timelapse-ui.mjs. This draws the page with a recorded day
// and finds every one of them, so a change to the page fails here rather
// than on the next unattended render.
import test from 'node:test';
import assert from 'node:assert/strict';
import { page, settle } from './_dom.mjs';
import { memoryStorage, read, web } from './_web.mjs';

const { render } = await web('assets/ui.js');
const { UI, WORDS } = await import('../../api/scripts/dev/render-timelapse-ui.mjs');

const DATE = '2026-11-06';
const T0 = Date.parse(`${DATE}T08:00:00+08:00`);

/** A day of one D2 bus, read twice an hour apart, gzipped as the API sends it. */
function dayFile() {
  const file = {
    v: 1,
    date: DATE,
    t0: T0,
    pollMs: 30_000,
    origin: [103.77, 1.29],
    q: 100_000,
    routes: {
      D2: {
        color: '#8e44c9',
        line: [
          [103.77, 1.29],
          [103.78, 1.3],
        ],
        loop: false,
      },
    },
    services: ['D2'],
    plates: ['PD1'],
    samples: [
      [0, 0, 0, 0, 0, 10],
      // The last reading 40 s past the minute: the end handle shows 09:00.
      [3_640_000, 0, 0, 500, 500, 600],
    ],
    stops: [{ code: 'A', lat: 1.29, lon: 103.77, core: true }],
  };
  return new Response(new Blob([JSON.stringify(file)]).stream().pipeThrough(new CompressionStream('gzip')));
}

const button = (root, scope, word) =>
  [...(scope ? (root.querySelector(scope)?.querySelectorAll('button, a') ?? []) : root.querySelectorAll('button, a'))].find(
    (b) => b.textContent.trim() === word,
  );

test("every selector and button render-timelapse.mjs uses is on the dashboard's Timelapse", async (t) => {
  const w = page({ url: 'https://terminus.run/admin/#/timelapse', html: '<div id="admin"></div>' });
  globalThis.Image = w.Image;
  globalThis.sessionStorage = memoryStorage();
  globalThis.fetch = async (url) => {
    if (String(url) === '/api/timelapse/days')
      return Response.json({ days: [{ date: DATE, closed: true, bytes: 1_000 }], recording: null });
    if (String(url) === `/api/timelapse/days/${DATE}`) return dayFile();
    return Response.json({}, { status: 404 });
  };
  await web('admin/admin.js?renderer');
  const root = document.getElementById('admin');
  t.after(() => render(null, root));
  await settle();

  // Signing in.
  assert.equal(Boolean(root.querySelector(UI.token)), true, UI.token);
  assert.equal(Boolean(button(root, null, WORDS.open)), true, WORDS.open);
  root.querySelector(UI.token).value = 'token';
  root
    .querySelector(UI.token)
    .closest('form')
    .dispatchEvent(new Event('submit', { cancelable: true }));
  // The section loads with import(), then the day: the timeline's handles come last.
  for (let i = 0; i < 200 && !root.querySelector(UI.from); i++) await settle();

  // Drawn only during or after an export: looked for in the section's source.
  const later = {
    progress: /class="job[^"]*"[\s\S]*?class="meta"/,
    failed: /class="bad job"/,
    note: /<div class="timelapse">\s*\$\{v\.note && html`<p class="bad">/,
  };
  assert.equal(
    Boolean(root.querySelector(UI.from)),
    true,
    `the timeline's handles: ${root.querySelector('.timelapse')?.textContent.slice(0, 200)}`,
  );
  for (const [name, sel] of Object.entries(UI)) {
    if (name === 'token') continue;
    if (later[name]) assert.match(read('admin/timelapse/timelapse.js'), later[name], `${name}: ${sel}`);
    else assert.equal(Boolean(root.querySelector(sel)), true, `${name}: ${sel}`);
  }
  assert.equal(Boolean(root.querySelector(`${UI.day} option[value="${DATE}"]`)), true, 'the day is picked by its date');
  for (const [group, words] of [
    [UI.shape, WORDS.shape],
    [UI.map, WORDS.map],
    [UI.overlay, WORDS.overlay],
  ]) {
    for (const word of Object.values(words)) assert.equal(Boolean(button(root, group, word)), true, `${group}: ${word}`);
  }
  assert.equal(Boolean(button(root, UI.length, WORDS.length(60))), true, WORDS.length(60));
  assert.equal(root.querySelector(UI.exportButton)?.textContent.trim(), WORDS.export);
  assert.match(read('admin/timelapse/timelapse.js'), new RegExp(`>${WORDS.download}<`), WORDS.download);

  // The handles move by the keys the script presses: an arrow a minute, with Shift ten.
  const from = root.querySelector(UI.from);
  const at = () => from.getAttribute('aria-valuetext');
  assert.equal(at(), '08:00');
  from.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  await settle();
  assert.equal(at(), '08:01');
  from.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true }));
  await settle();
  assert.equal(at(), '08:11');
  // From a time between minutes, the first press moves what the handle shows.
  const to = root.querySelector(UI.to);
  assert.equal(to.getAttribute('aria-valuetext'), '09:00');
  to.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
  await settle();
  assert.equal(to.getAttribute('aria-valuetext'), '08:59');
});
