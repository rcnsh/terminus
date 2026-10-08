/**
 * Light, dark or the device's own (apps/web/public/assets/theme.js), run as
 * a page runs it: the choice kept on this browser wins over the device's
 * setting, and what follows dark mode by itself is pointed at the choice.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { memoryStorage, read } from './_web.mjs';

/** theme.js on a page with this stored choice, on a device in dark mode or not. */
function page({ stored = null, systemDark = false, storage = memoryStorage(stored ? { 'terminus-theme': stored } : {}) } = {}) {
  const events = [];
  // The installed app's bar colour, one per mode, and a picture with a dark version.
  const nodes = [{ media: '(prefers-color-scheme: light)', dataset: {} }, { media: '(prefers-color-scheme: dark)', dataset: {} }, { media: '(prefers-color-scheme: dark)', dataset: {} }];
  const document = {
    documentElement: { dataset: {} },
    readyState: 'complete',
    querySelectorAll: () => nodes,
    addEventListener() {},
    dispatchEvent: (e) => events.push(e.type),
  };
  const box = { document, localStorage: storage, matchMedia: () => ({ matches: systemDark }), CustomEvent: class { constructor(type) { this.type = type; } } };
  box.window = box;
  vm.runInNewContext(read('assets/theme.js'), box);
  return { theme: box.theme, html: document.documentElement, nodes, events, storage };
}

test('the stored choice, else the device: light, dark, or auto', () => {
  assert.equal(page().theme.pref(), 'auto');
  assert.equal(page({ stored: 'dark' }).theme.pref(), 'dark');
  assert.equal(page({ stored: 'light' }).theme.pref(), 'light');
  assert.equal(page({ stored: 'sepia' }).theme.pref(), 'auto');
  // Storage blocked: the device's.
  const blocked = { getItem: () => { throw new Error('denied'); } };
  assert.equal(page({ storage: blocked }).theme.pref(), 'auto');
});

test('dark: the choice wins over the device; auto follows it', () => {
  assert.equal(page({ systemDark: true }).theme.dark(), true);
  assert.equal(page({ systemDark: false }).theme.dark(), false);
  assert.equal(page({ stored: 'light', systemDark: true }).theme.dark(), false);
  assert.equal(page({ stored: 'dark', systemDark: false }).theme.dark(), true);
});

test('the page is drawn in the choice, and its dark-mode media point at it', () => {
  const dark = page({ stored: 'dark' });
  assert.equal(dark.html.dataset.theme, 'dark');
  assert.deepEqual(dark.nodes.map((n) => n.media), ['not all', 'all', 'all']);
  const light = page({ stored: 'light', systemDark: true });
  assert.equal(light.html.dataset.theme, 'light');
  assert.deepEqual(light.nodes.map((n) => n.media), ['all', 'not all', 'not all']);
  // Auto: no theme of its own, and the media as written.
  const auto = page({ systemDark: true });
  assert.equal(auto.html.dataset.theme, undefined);
  assert.deepEqual(auto.nodes.map((n) => n.media), ['(prefers-color-scheme: light)', '(prefers-color-scheme: dark)', '(prefers-color-scheme: dark)']);
});

test('set() keeps the choice, redraws in it and tells the map; auto forgets it', () => {
  const p = page({ systemDark: true });
  p.theme.set('light');
  assert.equal(p.storage.getItem('terminus-theme'), 'light');
  assert.equal(p.html.dataset.theme, 'light');
  assert.equal(p.theme.dark(), false);
  assert.deepEqual(p.nodes.map((n) => n.media), ['all', 'not all', 'not all']);
  p.theme.set('auto');
  assert.equal(p.storage.getItem('terminus-theme'), null);
  assert.equal(p.html.dataset.theme, undefined);
  assert.equal(p.theme.dark(), true);
  assert.deepEqual(p.nodes.map((n) => n.media), ['(prefers-color-scheme: light)', '(prefers-color-scheme: dark)', '(prefers-color-scheme: dark)']);
  assert.deepEqual(p.events, ['themechange', 'themechange']);
});
