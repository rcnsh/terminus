/**
 * Chinese (phase 10): the language is picked per request, every message has
 * a translation, and every error the API can send is translated. The answers
 * themselves are checked word for word by the zh goldens (golden.test.js).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { ERRORS_ZH, errorText, langFromHeader, langOfRequest, msgsFor, useProfileLang, withLang, lang } from '../src/i18n.ts';
import { parseProfile } from '../src/profile.ts';
import { json } from '../src/http.ts';

test('Accept-Language: the first supported language by preference', () => {
  assert.equal(langFromHeader(null), 'en');
  assert.equal(langFromHeader(''), 'en');
  assert.equal(langFromHeader('zh-CN,zh;q=0.9,en;q=0.8'), 'zh');
  assert.equal(langFromHeader('zh-Hant-TW'), 'zh', 'Traditional readers get Simplified');
  assert.equal(langFromHeader('en-SG,zh;q=0.9'), 'en');
  assert.equal(langFromHeader('fr-FR,zh-CN;q=0.8,en;q=0.5'), 'zh', 'unsupported languages are skipped');
  assert.equal(langFromHeader('en;q=0.5, zh;q=0.9'), 'zh', 'by q, not by order');
  assert.equal(langFromHeader('ja'), 'en');
  assert.equal(langFromHeader('zh;q=0'), 'en', 'q=0 means not this one');
});

test('?lang= wins over the header; the profile wins over both', () => {
  const req = new Request('https://x.test/api/next?lang=en', { headers: { 'accept-language': 'zh-CN' } });
  assert.equal(langOfRequest(req), 'en');
  assert.equal(langOfRequest(new Request('https://x.test/api/next', { headers: { 'accept-language': 'zh-CN' } })), 'zh');
  // The website's choice, for the pages the Worker serves itself.
  assert.equal(langOfRequest(new Request('https://x.test/auth/verify', { headers: { 'accept-language': 'en', cookie: 'a=1; terminus-lang=zh' } })), 'zh');
  withLang('en', () => {
    useProfileLang('auto');
    assert.equal(lang(), 'en', 'auto keeps the device language');
    useProfileLang('zh');
    assert.equal(lang(), 'zh');
  });
  assert.equal(lang(), 'en', 'outside a request: English');
});

/** Calls a message with sample arguments, so functions can be compared too. */
function say(v) {
  if (typeof v !== 'function') return Array.isArray(v) ? v.join('|') : v;
  const args = Array.from({ length: v.length }, (_, i) => [3, 'D2', 'COM3', '9:41', true][i % 5]);
  return v(...args);
}

// Kept as they are in Chinese: a number format, a holiday's own name passed through.
const SAME = new Set(['holiday']);

test('every message is translated, and reads as Chinese', () => {
  const en = msgsFor('en');
  const zh = msgsFor('zh');
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort());
  for (const key of Object.keys(en)) {
    if (SAME.has(key)) continue;
    const e = say(en[key]);
    const z = say(zh[key]);
    assert.notEqual(z, e, `${key} is the same as the English`);
    assert.match(z, /[一-鿿]/, `${key} has no Chinese in it: ${z}`);
  }
  assert.equal(zh.holiday('Chinese New Year (Observed)'), '农历新年（补假）');
  assert.equal(zh.holiday('Deepavali'), '屠妖节');
});

test('every public holiday in the calendar has a Chinese name', () => {
  const cal = fs.readFileSync(new URL('../data/calendar.json', import.meta.url), 'utf8');
  const names = new Set([...cal.matchAll(/"name":\s*"([^"]+)"/g)].map((x) => x[1]));
  assert.ok(names.size > 5);
  for (const n of names) assert.match(msgsFor('zh').holiday(n), /[一-鿿]/, n);
});

// Errors worded with a value in them: developer-facing checks of a malformed
// profile or request, which the apps never send. Kept English.
const DEV_TEMPLATES = [
  /^\$\{field\}/,
  /^home\.stops must/,
  /^(once|usual|places)(\[|\s)/,
];

test('every error string in the API has a Chinese translation', () => {
  const dir = new URL('../src/', import.meta.url);
  const missing = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.ts') || f === 'openapi.ts' || f === 'i18n.ts') continue;
    const src = fs.readFileSync(new URL(f, dir), 'utf8');
    for (const [, q, text] of src.matchAll(/error: (['"`])((?:\\.|(?!\1).)*)\1/g)) {
      if (q === '`') {
        if (!DEV_TEMPLATES.some((re) => re.test(text))) missing.push(`${f}: a template; use m(): ${text}`);
        continue;
      }
      if (!(text in ERRORS_ZH)) missing.push(`${f}: ${text}`);
    }
    // An error worded by an expression, like a ternary: each string in it.
    for (const [, expr] of src.matchAll(/error: (?!['"`])([^\n]*)/g)) {
      for (const text of literalsIn(expr)) {
        if (!(text in ERRORS_ZH)) missing.push(`${f}: ${text}`);
      }
    }
  }
  assert.deepEqual(missing, []);
});

/**
 * The strings an expression can give, up to the comma or bracket that ends
 * it: the branches of a ternary or `??` (a literal after `?`, `:` or `??`),
 * not the values it compares.
 */
function literalsIn(expr) {
  const out = [];
  let depth = 0;
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < expr.length && expr[j] !== c) j += expr[j] === '\\' ? 2 : 1;
      if (depth === 0 && /(\?|:)\s*$/.test(expr.slice(0, i))) out.push(expr.slice(i + 1, j));
      i = j;
    } else if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) {
      if (depth === 0) break;
      depth--;
    } else if (c === ',' && depth === 0) break;
  }
  return out;
}

test('Chinese spacing: Latin text keeps its space, two Chinese words touch', () => {
  const zh = msgsFor('zh');
  assert.equal(zh.startsAt('CS2030 @ COM1', '09:41'), 'CS2030 @ COM1 09:41 开始', 'two values side by side stay apart');
  assert.equal(zh.offAt('Kent Ridge Ter (Clementi Rd)'), '在 Kent Ridge Ter (Clementi Rd) 下车', 'a bracket counts as Latin');
  assert.match(zh.codeTypeApp('<strong>Pixel 8</strong>'), /^请在 <strong>Pixel 8<\/strong> 上的/, 'so does a tag');
  assert.equal(zh.catchBus('约 09:42', 'R2', 'PGP', null), '在 PGP 搭约 09:42 的 R2');
});

test('json() says the error in the request language', async () => {
  const body = await withLang('zh', () => json({ error: 'sign in first' }, 401)).json();
  assert.equal(body.error, '请先登录');
  assert.equal(await json({ error: 'sign in first' }, 401).json().then((b) => b.error), 'sign in first');
  assert.equal(withLang('zh', () => errorText('something new')), 'something new', 'unknown errors stay English');
});

test('profile lang: auto, en or zh; auto by default', () => {
  const ok = (c) => c !== 'NOPE';
  assert.equal(parseProfile({}, ok, ok).profile.lang, 'auto');
  assert.equal(parseProfile({ lang: 'zh' }, ok, ok).profile.lang, 'zh');
  assert.equal(parseProfile({ lang: 'fr' }, ok, ok).ok, false);
});
