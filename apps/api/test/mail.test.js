/**
 * The emails' HTML (src/mail.ts): what each must say, in both languages,
 * with whatever a user typed escaped.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { deviceAddedHtml, feedbackHtml, operatorHtml, signInHtml } from '../src/mail.ts';
import { msgsFor, withLang } from '../src/i18n.ts';

const origin = 'https://terminus.rcn.sh';
const link = `${origin}/auth/verify?t=abc_DEF-123`;

test('the website sign-in email has the code, the link as a button, and why it came', async () => {
  const why = msgsFor('en').codeWhyWeb('terminus.run');
  const html = await signInHtml({ origin, beta: false, code: 'K7Q2XZ', link, why });
  assert.match(html, /^<!DOCTYPE html/);
  assert.match(html, /<html[^>]* lang="en"/);
  assert.match(html, />K7Q2XZ</);
  assert.ok(html.includes(`href="${link}"`));
  assert.ok(html.includes(msgsFor('en').codeLinkButton));
  assert.ok(html.includes('If that wasn&#x27;t you') || html.includes("If that wasn't you"));
  assert.doesNotMatch(html, />beta</);
});

test('the app sign-in email names the device, escaped, and is in Chinese when asked', async () => {
  const device = '<b>Pixel</b> & co';
  const html = await withLang('zh', () => signInHtml({ origin, beta: true, code: 'K7Q2XZ', link, device, why: 'x' }));
  assert.match(html, /<html[^>]* lang="zh-Hans"/);
  assert.ok(html.includes(msgsFor('zh').codeHeading));
  assert.ok(html.includes(msgsFor('zh').codeOtherDeviceButton));
  assert.ok(!html.includes('<b>Pixel</b>'), 'a device name is text, never markup');
  assert.ok(html.includes('&lt;b&gt;Pixel&lt;/b&gt; &amp; co'));
  assert.match(html, />beta</, 'the beta says so');
});

test('the device-added email links to the account page', async () => {
  const html = await deviceAddedHtml({ origin, beta: false, device: 'MacBook Air', when: '2026-10-11 09:30 Singapore time', site: origin });
  assert.ok(html.includes(`href="${origin}/account"`));
  assert.ok(html.includes('terminus was added to MacBook Air'));
});

test('an operator email keeps commands and responses in a box, as written', async () => {
  const text = 'The NUS bus feed stopped answering.\n\nTo undo it, from apps/api:\n  pnpm exec cf kv keys delete x\n\nNUS\'s full response:\n{"code":"401"}';
  const html = await operatorHtml({ origin, beta: false, subject: 'terminus: NUS bus feed is down', text });
  assert.match(html, /<h1[^>]*>NUS bus feed is down<\/h1>/);
  assert.match(html, />To undo it, from apps\/api:<\/p><pre[^>]*>pnpm exec cf kv keys delete x<\/pre>/);
  assert.match(html, />NUS&#x27;s full response:<\/p><pre[^>]*>\{&quot;code&quot;:&quot;401&quot;\}<\/pre>/);
});

test('a stop suggestion shows the building, the stop and the entry to paste, with their words as text', async () => {
  const html = await feedbackHtml({
    origin, beta: false, id: 'fb_1', what: 'A better stop for a building', from: 'Web', at: Date.parse('2026-10-11T03:05:00Z'),
    reason: null, note: 'Use <EA>', details: [['Building', 'E4'], ['The stop they use', 'EA (EA)']], entry: '"E4": {"stops":["EA"]}', withAnswer: false,
  });
  assert.match(html, /<h1[^>]*>A better stop for a building<\/h1>/);
  assert.match(html, /Web · 11 Oct 2026, 11:05 Singapore time/);
  assert.ok(html.includes('Use &lt;EA&gt;'), 'their note is text, never markup');
  assert.match(html, />The stop they use<\/td><td[^>]*>EA \(EA\)</);
  assert.match(html, /<pre[^>]*>&quot;E4&quot;: \{&quot;stops&quot;:\[&quot;EA&quot;\]\}<\/pre>/);
  assert.ok(html.includes(`href="${origin}/admin"`));
  assert.match(html, /Report fb_1\. Who sent it is on the dashboard/);
});

test('a wrong answer shows the reason they picked', async () => {
  const html = await feedbackHtml({ origin, beta: false, id: 'fb_2', what: 'A wrong answer', from: 'Android 3.1.0', at: 0, reason: 'The bus never came', note: '', details: [], entry: null, withAnswer: true });
  assert.match(html, /<span[^>]*>The bus never came<\/span>/);
  assert.match(html, /Who sent it and the answer they saw are on the dashboard/);
});
