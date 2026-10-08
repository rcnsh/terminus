/**
 * The website's language (apps/web/public/assets/i18n.js), run as a page
 * would run it: which language a browser gets, and t()'s blanks.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadI18n, zh } from './_web.mjs';

test("t() fills {0} and {1}, a missing value with nothing", () => {
  const { t } = loadI18n({ stored: 'en' }).i18n;
  assert.equal(t('Leave in {0} min {1} s', 1, 5), 'Leave in 1 min 5 s');
  assert.equal(t('{0} and {0} again', 'D1'), 'D1 and D1 again');
  assert.equal(t('Leave in {0} min {1} s', 1), 'Leave in 1 min  s');
  assert.equal(t('No blanks'), 'No blanks');
  assert.equal(t('Zero: {0}', 0), 'Zero: 0');
  assert.equal(t('Null: {0}', null), 'Null: ');
});

test('in Chinese, t() gives the translation with its blanks filled, else the English', () => {
  const { t } = loadI18n({ stored: 'zh' }).i18n;
  const table = zh();
  assert.ok(table['Leave in {0} min']);
  assert.equal(t('Leave in {0} min', 4), table['Leave in {0} min'].replace('{0}', '4'));
  assert.equal(t('Not a sentence the site has {0}', 'D1'), 'Not a sentence the site has D1');
  // English pages never use the table, even when it is loaded.
  assert.equal(loadI18n({ stored: 'en' }).i18n.t('Leave in {0} min', 4), 'Leave in 4 min');
});

test("the choice made on this browser first, then the browser's own languages", () => {
  const lang = (o) => loadI18n(o).i18n.lang;
  assert.equal(lang({ stored: 'zh', languages: ['en-GB'] }), 'zh');
  assert.equal(lang({ stored: 'en', languages: ['zh-CN'] }), 'en');
  // Nothing chosen: the first of the browser's languages the site has.
  assert.equal(lang({ languages: ['fr-FR', 'zh-TW', 'en'] }), 'zh');
  assert.equal(lang({ languages: ['en-GB', 'zh-CN'] }), 'en');
  assert.equal(lang({ languages: ['ZH'] }), 'zh');
  assert.equal(lang({ languages: ['fr', 'de'] }), 'en');
  // "zhuang" isn't Chinese for this.
  assert.equal(lang({ languages: ['zha'] }), 'en');
  assert.equal(lang({ languages: [], language: 'zh-SG' }), 'zh');
  // Something else stored counts as no choice.
  assert.equal(lang({ stored: 'fr', languages: ['zh-CN'] }), 'zh');
  assert.equal(loadI18n({ stored: 'fr' }).i18n.pref(), 'auto');
});

test('the cookie follows the choice, for the pages the server makes, and never makes it', () => {
  // Chosen here, no cookie yet: the cookie is set to it.
  assert.match(loadI18n({ stored: 'zh' }).document.cookie, /^terminus-lang=zh; path=\/; max-age=31536000/);
  // A cookie left from an earlier choice, none chosen now: the browser's language, and the cookie cleared.
  const left = loadI18n({ cookie: 'terminus-lang=zh', languages: ['en-SG'] });
  assert.equal(left.i18n.lang, 'en');
  assert.match(left.document.cookie, /^terminus-lang=; path=\/; max-age=0/);
  // Already right: left alone.
  assert.equal(loadI18n({ stored: 'en', cookie: 'a=1; terminus-lang=en' }).document.cookie, 'a=1; terminus-lang=en');
  assert.equal(loadI18n({ cookie: 'a=1' }).document.cookie, 'a=1');
});

test('a Chinese page: zh.js loaded first, its language on <html>, the API asked in Chinese', () => {
  const page = loadI18n({ stored: 'zh', withZh: false });
  assert.deepEqual(page.written, ['<script src="/assets/zh.js"></script>']);
  assert.equal(page.document.documentElement.lang, 'zh-Hans');
  assert.equal(page.i18n.header, 'zh-Hans');
  assert.equal(page.i18n.locale, 'zh-CN');
  // Shown once translated.
  assert.equal(page.classes.has('i18n-wait'), false);
  const en = loadI18n({ stored: 'en' });
  assert.deepEqual(en.written, []);
  assert.equal(en.document.documentElement.lang, 'en');
  assert.equal(en.i18n.header, 'en');
  assert.equal(en.i18n.locale, undefined);
});
