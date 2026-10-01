/**
 * The website in Chinese (phase 10): every t('...') in its scripts and every
 * bit of text on its pages has a translation in assets/zh.js. The pages are
 * read roughly (text between tags); a fragment counts as covered when it's a
 * key itself or part of a key that is a whole element's HTML.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const PUBLIC = new URL('../../web/public/', import.meta.url);
const read = (p) => fs.readFileSync(new URL(p, PUBLIC), 'utf8');

function zh() {
  const box = { window: {} };
  vm.runInNewContext(read('assets/zh.js'), box);
  return box.window.TERMINUS_ZH;
}

// The privacy policy has a page of its own in Chinese (privacy/zh/), checked below.
const PAGES = ['index.html', 'account/index.html', 'app/index.html', 'pair/index.html', 'status/index.html'];
const SCRIPTS = ['account/app.js', 'account/onboarding.js', 'account/preview.js', 'account/search.js', 'app/app.js', 'assets/landing.js', 'status/status.js'];

// Names and codes that read the same in Chinese.
const SAME = /^(terminus|termi|nus|API|Android|Mac|English|中文|Apple|iPhone|K7QX4M|x-api-key|you@u\.nus\.edu|terminus\.rcn\.sh\/account|------|https:\/\/nusmods\.com\/\S*|[-–·…×↻→\d\s:&;©]+)$/;

test('every t() string in the scripts is translated', () => {
  const dict = zh();
  const missing = [];
  for (const f of SCRIPTS) {
    for (const [, q, s] of read(f).matchAll(/\bt\((['"])((?:\\.|(?!\1).)*)\1/g)) {
      const en = q === '"' ? JSON.parse(`"${s}"`) : s.replace(/\\'/g, "'");
      if (!(en in dict)) missing.push(`${f}: ${en}`);
    }
  }
  assert.deepEqual(missing, []);
});

test('every bit of text on the pages is translated', () => {
  const dict = zh();
  const htmlKeys = Object.keys(dict).filter((k) => k.includes('<')).map((k) => k.replace(/<[^>]+>/g, '\u0000'));
  const covered = (s) => s in dict || htmlKeys.some((k) => k.split('\u0000').map((x) => x.replace(/\s+/g, ' ').trim()).includes(s));
  const missing = [];
  for (const page of PAGES) {
    const body = read(page)
      .replace(/<head>[\s\S]*?<\/head>/, '')
      .replace(/<(script|style|svg)[\s\S]*?<\/\1>/g, '');
    const texts = [...body.matchAll(/>([^<>]+)</g)].map((m) => m[1].replace(/\s+/g, ' ').trim());
    const attrs = [...body.matchAll(/\s(?:placeholder|aria-label|title|alt)="([^"]+)"/g)].map((m) => m[1]);
    for (const s of [...texts, ...attrs]) {
      if (!s || SAME.test(s) || !/[A-Za-z]{2,}/.test(s)) continue;
      if (!covered(s)) missing.push(`${page}: ${s}`);
    }
    const title = /<title>([^<]+)<\/title>/.exec(read(page))?.[1];
    if (title && !(title in dict)) missing.push(`${page}: <title> ${title}`);
  }
  assert.deepEqual(missing, []);
});

test('the Chinese is Chinese', () => {
  for (const [en, z] of Object.entries(zh())) {
    if (SAME.test(en) || en === z) continue;
    assert.match(z, /[一-鿿　-〿＀-￯]/, en);
  }
});

test('the privacy policy has a Chinese translation that names the English as the one that counts', () => {
  const page = read('privacy/zh/index.html');
  assert.match(read('privacy/index.html'), /data-alt-zh="\/privacy\/zh\/"/);
  assert.match(page, /以英文版为准/);
  // Every section of the English has one in the Chinese.
  const count = (s) => (s.match(/<h2>/g) ?? []).length;
  assert.equal(count(page), count(read('privacy/index.html')));
});
