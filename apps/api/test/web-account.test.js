/**
 * The account page's components (account/app.js, settings-pages.js) in a
 * page of their own (_dom.mjs): what they do with the answers they ask for,
 * with the server played by a fetch that answers when the test says.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import fs from 'node:fs';

import { page, settle } from './_dom.mjs';
import { web } from './_web.mjs';

// The sign-in view warms up Settings' modules; while `offline`, that import fails as a dropped connection would.
let offline = false;
registerHooks({
  resolve(spec, ctx, next) {
    if (offline && /(^\.\/|\/account\/)settings\.js$/.test(spec)) throw new TypeError('Failed to fetch dynamically imported module');
    return next(spec, ctx);
  },
});

/** A fetch whose /api/me/next and /api/me/choices answers wait for the test: `next[i].answer(body)`. */
const calls = { next: [], choices: [] };
const deferred = () => {
  const d = {};
  d.promise = new Promise((resolve) => (d.answer = (body, status = 200) => resolve(Response.json(body, { status }))));
  return d;
};
globalThis.fetch = async (input) => {
  const path = String(input).replace(/^https:\/\/terminus\.run/, '');
  if (path === '/api/me') return Response.json({ error: 'Sign in' }, { status: 401 });
  if (path === '/api/auth/config') return Response.json({});
  if (path.startsWith('/api/me/next')) return calls.next[calls.next.push(deferred()) - 1].promise;
  if (path === '/api/me/choices') return calls.choices[calls.choices.push(deferred()) - 1].promise;
  throw new Error(`unexpected fetch ${path}`);
};

const GOLDEN = JSON.parse(fs.readFileSync(new URL('./fixtures/answers/class-bus.json', import.meta.url), 'utf8'));
/** The class-bus answer with the card's title `title`, to tell two answers apart on the page. */
const answer = (title) => ({ ...GOLDEN, card: { ...GOLDEN.card, title } });
const choices = (label) => ({ choices: [{ trip: 1, pref: 'earlier', label }], history: 0 });

page({ html: '<div id="root"></div><div id="who"></div>' });
// Loaded by the time /api/me answers, as it usually is: the warm-up runs straight away, not from the load event.
Object.defineProperty(document, 'readyState', { value: 'complete', configurable: true });
const rejections = [];
process.on('unhandledRejection', (err) => rejections.push(err));
offline = true;
const app = await web('account/app.js');
await settle(20);
offline = false;
const { html, render } = await web('assets/ui.js');
const { lists, saves } = await web('account/profile.js');
const { Choices } = await web('account/settings-pages.js');

/** Draws `vnode` in a box of its own, cleared (effects and timers included) when the test ends. */
function draw(t, vnode) {
  const box = document.createElement('div');
  document.body.append(box);
  render(vnode, box);
  t.after(() => {
    render(null, box);
    box.remove();
  });
  return box;
}

test('signed out, a warm-up of Settings that fails is left for the sign-in to try again', () => {
  assert.ok(document.querySelector('.signin'), 'the sign-in card is up');
  assert.deepEqual(
    rejections.map((e) => String(e)),
    [],
    'nothing is left unhandled',
  );
});

test('the preview shows the newest answer asked for, not the last to arrive', async (t) => {
  const box = draw(t, html`<${app.Preview} me=${{ anonymous: false, email: 'a@u.nus.edu' }} />`);
  await settle();
  assert.equal(calls.next.length, 1, 'asked once on opening');
  // A save asks again while the first is still on its way.
  saves.set((n) => n + 1);
  await settle();
  assert.equal(calls.next.length, 2, 'asked again after a save');
  calls.next[1].answer(answer('After the save'));
  await settle();
  assert.equal(box.querySelector('.big')?.textContent, 'After the save');
  // The first answer lands late, with the card from before the save.
  calls.next[0].answer(answer('Before the save'));
  await settle();
  assert.equal(box.querySelector('.big')?.textContent, 'After the save', 'the older answer does not take its place');
});

test('a failure arriving late does not take a newer answer off the preview', async (t) => {
  const was = calls.next.length;
  const box = draw(t, html`<${app.Preview} me=${{ anonymous: false, email: 'a@u.nus.edu' }} />`);
  await settle();
  saves.set((n) => n + 1);
  await settle();
  assert.equal(calls.next.length, was + 2);
  calls.next[was + 1].answer(answer('Latest'));
  await settle();
  calls.next[was].answer({ error: 'down' }, 503);
  await settle();
  assert.equal(box.querySelector('.big')?.textContent, 'Latest');
  assert.equal(box.textContent.includes('Preview unavailable'), false);
});
