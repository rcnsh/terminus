/**
 * A page for the website's components: happy-dom's document, location and
 * the rest on the globals, beside _web.mjs's module hook. `window` stays
 * globalThis, as _web.mjs sets it, so `window.i18n` and the like still work.
 *
 *   const { page } = await import('./_dom.mjs');
 *   page({ url: 'https://terminus.run/account/', html: '<div id="root"></div>' });
 */
import assert from 'node:assert';
import strict from 'node:assert/strict';
import { Window } from 'happy-dom';
import './_web.mjs';

const isNode = (v) => typeof v === 'object' && v !== null && typeof v.nodeType === 'number' && typeof v.nodeName === 'string';

/** A node as one line: <div#side.dash.on>. */
function describe(v) {
  if (!isNode(v)) return v;
  const id = v.id ? `#${v.id}` : '';
  const cls = typeof v.className === 'string' && v.className.trim() ? `.${v.className.trim().split(/\s+/).join('.')}` : '';
  return `<${v.nodeName.toLowerCase()}${id}${cls}>`;
}

/*
 * The equality asserts, made safe for DOM nodes. A failing assert prints
 * its values with every getter called, 1000 levels deep, and happy-dom's
 * getters make new objects as they go: printing one element never ends,
 * and its memory grows until the machine runs out. With a node on either side, a node
 * equals only itself (comparing its insides would walk the same graph), and
 * a failure shows it as one line.
 */
const EQUALITY = ['equal', 'strictEqual', 'deepEqual', 'deepStrictEqual'];
for (const lib of [assert, strict]) {
  for (const name of [...EQUALITY, ...EQUALITY.map((n) => `not${n[0].toUpperCase()}${n.slice(1)}`)]) {
    const real = lib[name];
    lib[name] = function (actual, expected, message) {
      // Exactly the arguments given: Node counts them (too few is an error) and rejects an explicit undefined message.
      if (!isNode(actual) && !isNode(expected)) return Reflect.apply(real, this, arguments);
      if (arguments.length < 2) throw new TypeError(`${name} needs the value expected`);
      if (name.startsWith('not') ? actual !== expected : actual === expected) return undefined;
      if (message instanceof Error) throw message;
      throw new assert.AssertionError({
        message: message ?? `${name}: ${describe(actual)} against ${describe(expected)}`,
        actual: describe(actual),
        expected: describe(expected),
        operator: name,
      });
    };
  }
}

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
