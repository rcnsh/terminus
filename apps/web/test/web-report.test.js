/**
 * The "Is this wrong?" sheet's chips (apps/web/public/account/preview.js):
 * the reasons the server says fit the card (card.reasons), on real answers
 * from fixtures/answers, and every reason for a card from a server that
 * doesn't say.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import classBus from '../../../fixtures/answers/class-bus.json' with { type: 'json' };
import rest from '../../../fixtures/answers/rest.json' with { type: 'json' };
import riding from '../../../fixtures/answers/riding.json' with { type: 'json' };
import { page, settle } from './_dom.mjs';
import { useLang, web } from './_web.mjs';

useLang('en');
page({ url: 'https://terminus.run/app/', html: '<div id="root"></div>' });
// happy-dom has no modal dialogs.
HTMLElement.prototype.showModal ??= function () {
  this.setAttribute('open', '');
};
HTMLElement.prototype.close ??= function () {
  this.removeAttribute('open');
};
const sent = [];
globalThis.fetch = async (_url, init) => {
  sent.push(JSON.parse(init.body));
  return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
};
const { html, render } = await web('assets/ui.js');
const P = await web('account/preview.js');
const keys = (card) => P.reasonsFor(card).map(([key]) => key);
const ALL = P.REPORT_REASONS.map(([key]) => key);

test('a card with a bus to catch offers every reason', () => {
  assert.deepEqual(keys(classBus.card), ALL);
});

test('on the bus, "Bus never came" is not offered', () => {
  assert.deepEqual(keys(riding.card), ['times-off', 'wrong-stop', 'walk-longer', 'wrong-class']);
});

test('a day that is done offers only "Wrong class"', () => {
  assert.deepEqual(keys(rest.card), ['wrong-class']);
});

test('a card from a server that sends no reasons offers them all', () => {
  const { reasons: _, ...old } = rest.card;
  assert.deepEqual(keys(old), ALL);
  assert.deepEqual(keys(undefined), ALL);
});

test('a reason picked on an earlier opening is not sent once the answer no longer offers it', async () => {
  const root = document.getElementById('root');
  const draw = async (a) => {
    render(html`<${P.Report} answer=${a} email="you@u.nus.edu" />`, root);
    await settle();
  };
  const click = async (sel, text) => {
    [...root.querySelectorAll(sel)].find((b) => text === undefined || b.textContent === text).click();
    await settle();
  };
  await draw(classBus);
  await click('.report-open');
  await click('.report-chip', 'Bus never came');
  await click('.report-cancel');
  // The card moves on: now on the bus, where it did come.
  await draw(riding);
  await click('.report-open');
  assert.ok(![...root.querySelectorAll('.report-chip')].some((b) => b.textContent === 'Bus never came'));
  assert.equal(root.querySelector('.report-chip[aria-pressed="true"]'), null, 'nothing shows as picked');
  assert.ok(root.querySelector('.report-send').disabled, 'nothing to send');
  root.querySelector('form').dispatchEvent(new Event('submit', { cancelable: true }));
  await settle();
  assert.deepEqual(sent, []);
  render(null, root);
});
