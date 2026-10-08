/**
 * For tests of the website's browser modules (apps/web/public), which load
 * in Node as written, with no build step:
 *
 * - Absolute imports between them ('/assets/ui.js') resolve to the site's
 *   files, as the browser resolves them against the page. Load the modules
 *   with `await web('app/buses.js')` after importing this file: a static
 *   import would be resolved before the hook is in place.
 * - The few browser globals they touch as they load (window, localStorage,
 *   matchMedia) are stand-ins.
 * - assets/i18n.js runs in a sandbox (loadI18n), so a test can read the
 *   page in English or Chinese as a browser would set it.
 */
import { registerHooks } from 'node:module';
import fs from 'node:fs';
import vm from 'node:vm';

export const PUBLIC = new URL('../../web/public/', import.meta.url);
export const read = (p) => fs.readFileSync(new URL(p.replace(/^\//, ''), PUBLIC), 'utf8');

registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith('/') && !spec.startsWith('//') && ctx.parentURL?.startsWith(PUBLIC.href)) return next(new URL(spec.slice(1), PUBLIC).href, ctx);
    return next(spec, ctx);
  },
});

/** A Storage held in memory. */
export function memoryStorage(entries = {}) {
  const m = new Map(Object.entries(entries));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => void m.set(k, String(v)),
    removeItem: (k) => void m.delete(k),
    clear: () => m.clear(),
  };
}

// The page's globals: `window` is the global object, as in a browser.
Object.defineProperty(globalThis, 'window', { value: globalThis, configurable: true, writable: true });
Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true, writable: true });
globalThis.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

/** A module of the site ('account/journey.js'), loaded with the hook above in place. */
export const web = (path) => import(new URL(path, PUBLIC).href);

let zhTable = null;
/** assets/zh.js's translations. */
export function zh() {
  if (!zhTable) {
    const box = { window: {} };
    vm.runInNewContext(read('assets/zh.js'), box);
    zhTable = box.window.TERMINUS_ZH;
  }
  return zhTable;
}

/**
 * Runs assets/i18n.js as a page would: with this browser's stored choice
 * (`stored`, localStorage), its `cookie`, its `languages`, and zh.js already
 * loaded (`withZh`). Returns window.i18n with what the script did to the page.
 */
export function loadI18n({ stored = null, cookie = '', languages = ['en-SG', 'en'], language = languages[0], withZh = true } = {}) {
  const storage = memoryStorage(stored ? { 'terminus-lang': stored } : {});
  const written = [];
  const classes = new Set();
  const documentElement = { dataset: {}, lang: '', classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c) } };
  const document = {
    documentElement,
    cookie,
    readyState: 'complete',
    title: 'terminus',
    body: null,
    write: (s) => written.push(s),
    querySelector: () => null,
    addEventListener() {},
  };
  const box = {
    document,
    localStorage: storage,
    navigator: { languages, language },
    location: { search: '', replace() {}, reload() {} },
    setTimeout: () => 0,
  };
  box.window = box;
  if (withZh) box.TERMINUS_ZH = zh();
  vm.runInNewContext(read('assets/i18n.js'), box);
  return { i18n: box.i18n, document, storage, written, classes };
}

/** Words the site in `lang` ('en' or 'zh') from here on, as i18n.js would have. */
export function useLang(lang) {
  globalThis.i18n = loadI18n({ stored: lang }).i18n;
}
