import { registerHooks } from 'node:module';
import fs from 'node:fs';
import vm from 'node:vm';

export const PUBLIC = new URL('../public/', import.meta.url);
export const read = (p) => fs.readFileSync(new URL(p.replace(/^\//, ''), PUBLIC), 'utf8');

registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith('/') && !spec.startsWith('//') && ctx.parentURL?.startsWith(PUBLIC.href))
      return next(new URL(spec.slice(1), PUBLIC).href, ctx);
    return next(spec, ctx);
  },
});

export function memoryStorage(entries = {}) {
  const m = new Map(Object.entries(entries));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => void m.set(k, String(v)),
    removeItem: (k) => void m.delete(k),
    clear: () => m.clear(),
  };
}

Object.defineProperty(globalThis, 'window', { value: globalThis, configurable: true, writable: true });
Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true, writable: true });
globalThis.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

export const web = (path) => import(new URL(path, PUBLIC).href);

let zhTable = null;
export function zh() {
  if (!zhTable) {
    const box = { window: {} };
    vm.runInNewContext(read('assets/zh.js'), box);
    zhTable = box.window.TERMINUS_ZH;
  }
  return zhTable;
}

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

export function useLang(lang) {
  globalThis.i18n = loadI18n({ stored: lang }).i18n;
}
