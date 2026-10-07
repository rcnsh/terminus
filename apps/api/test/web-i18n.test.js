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
const PAGES = ['index.html', 'account/index.html', 'app/index.html', 'pair/index.html', 'status/index.html', 'not-found/index.html'];
const SCRIPTS = [
  'account/app.js',
  'account/settings.js',
  'account/settings-pages.js',
  'account/onboarding.js',
  'account/preview.js',
  'account/journey.js',
  'account/profile.js',
  'account/search.js',
  'account/search-box.js',
  'app/app.js',
  'app/buses.js',
  'app/map.js',
  'assets/landing.js',
  'status/status.js',
  'pair/pair.js',
];

// Names and codes that read the same in Chinese: places and module codes too,
// as on the signs (the landing page's pictures of the app).
const SAME = /^(terminus|termi|nus|API|Android|Mac|English|中文|Apple|iPhone|PGP|UTown|Kent Ridge MRT|[A-Z]{2,3}\d{4}[A-Z]?|K7QX4M|x-api-key|you@u\.nus\.edu|terminus\.rcn\.sh\/account|------|https:\/\/nusmods\.com\/\S*|[-–·…×↻→\d\s:&;©]+)$/;

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

// The card colours the time in "Leave in 4 min" (journey.js LeaveHead) by
// finding it in the headline, in either language.
test('the leave time is inside its headline, in English and Chinese', () => {
  const dict = zh();
  for (const [head, time] of [
    ['Leave in {0} min', '{0} min'],
    ['Leave in {0} min {1} s', '{0} min {1} s'],
    ['Leave in {0} s', '{0} s'],
  ]) {
    assert.ok(head.includes(time), head);
    assert.ok(dict[head].includes(dict[time]), `${head}: ${dict[head]} / ${dict[time]}`);
  }
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

/** Skips a quoted string or a comment starting at `i` in `src`; returns where it ends, or `i` if there's none. */
function skipQuoted(src, i) {
  const c = src[i];
  if (c === "'" || c === '"') {
    for (let j = i + 1; j < src.length; j++) {
      if (src[j] === '\\') j++;
      else if (src[j] === c) return j + 1;
    }
  }
  if (c === '/' && src[i + 1] === '/') return src.indexOf('\n', i) + 1 || src.length;
  if (c === '/' && src[i + 1] === '*') return src.indexOf('*/', i + 2) + 2;
  if (c === '`') return readTemplate(src, i + 1).end;
  return i;
}

/** The template literal whose text starts at `i`: its own text (each ${…} as \uE000) and where it ends. */
function readTemplate(src, i) {
  let text = '';
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') {
      text += src[i + 1];
      i += 2;
    } else if (c === '`') {
      return { text, end: i + 1 };
    } else if (c === '$' && src[i + 1] === '{') {
      text += '\uE000';
      i += 2;
      for (let depth = 1; depth > 0 && i < src.length; ) {
        const skipped = skipQuoted(src, i);
        if (skipped !== i) {
          i = skipped;
          continue;
        }
        if (src[i] === '{') depth++;
        else if (src[i] === '}') depth--;
        i++;
      }
    } else {
      text += c;
      i++;
    }
  }
  return { text, end: i };
}

/** Every html`…` template in `src` (nested ones too), as its text alone. */
function templates(src) {
  const out = [];
  for (let i = src.indexOf('html`'); i !== -1; i = src.indexOf('html`', i + 1)) out.push(readTemplate(src, i + 5).text);
  return out;
}

test('templates have no words of their own: every one goes through t()', () => {
  const missing = [];
  for (const f of SCRIPTS) {
    for (const text of templates(read(f))) {
      // \uE000 marks an expression; \uE001, a tag.
      const attrs = [...text.matchAll(/\s(?:placeholder|aria-label|title|alt)="([^"\uE000]+)"/g)].map((m) => m[1]);
      const words = text.replace(/<[^>]*>/g, '\uE001').split(/[\uE000\uE001]/).map((x) => x.replace(/\s+/g, ' ').trim());
      for (const s of [...words, ...attrs]) {
        if (!s || SAME.test(s) || !/[A-Za-z]{2,}/.test(s)) continue;
        missing.push(`${f}: ${s}`);
      }
    }
  }
  assert.deepEqual(missing, []);
});

test('the Chinese is Chinese', () => {
  for (const [en, z] of Object.entries(zh())) {
    if (SAME.test(en) || en === z) continue;
    assert.match(z, /[一-鿿　-〿＀-￯]/, en);
  }
});

test('the privacy summary and the full policy each have a Chinese translation that names the English as the one that counts', () => {
  for (const dir of ['privacy/', 'privacy/policy/']) {
    const en = read(`${dir}index.html`);
    const page = read(`${dir}zh/index.html`);
    assert.match(en, new RegExp(`data-alt-zh="/${dir}zh/"`));
    assert.match(page, new RegExp(`data-alt-en="/${dir}"`));
    assert.match(page, /以英文版为准/);
    // Every section of the English has one in the Chinese.
    const count = (s) => (s.match(/<h2[\s>]/g) ?? []).length;
    assert.ok(count(en) > 0, dir);
    assert.equal(count(page), count(en), dir);
  }
});
