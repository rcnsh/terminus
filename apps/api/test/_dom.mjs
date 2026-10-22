/**
 * A page for the website's components: happy-dom's document, location and
 * the rest on the globals, beside _web.mjs's module hook. `window` stays
 * globalThis, as _web.mjs sets it, so `window.i18n` and the like still work.
 *
 *   const { page } = await import('./_dom.mjs');
 *   page({ url: 'https://terminus.run/account/', html: '<div id="root"></div>' });
 */
import { Window } from 'happy-dom';
import './_web.mjs';

const GLOBALS = [
  'document',
  'location',
  'history',
  'navigator',
  'Node',
  'Element',
  'HTMLElement',
  'Text',
  'Event',
  'CustomEvent',
  'KeyboardEvent',
  'MouseEvent',
  'MutationObserver',
  'getComputedStyle',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'scrollTo',
  'confirm',
  'alert',
  'addEventListener',
  'removeEventListener',
  'dispatchEvent',
];

/** Opens a page at `url` with `html` in its body; returns happy-dom's window. */
export function page({ url = 'https://terminus.run/account/', html = '' } = {}) {
  const w = new Window({ url });
  w.document.body.innerHTML = html;
  for (const k of GLOBALS) {
    const v = w[k];
    Object.defineProperty(globalThis, k, {
      value: typeof v === 'function' && !/^[A-Z]/.test(k) ? v.bind(w) : v,
      configurable: true,
      writable: true,
    });
  }
  return w;
}

/** Lets rendering, effects and settled promises run. */
export async function settle(rounds = 5) {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
}
