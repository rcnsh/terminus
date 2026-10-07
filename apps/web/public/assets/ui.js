// The website's UI: Preact and its hooks, with htm for templates (vendor/,
// copied by scripts/vendor-preact.sh), and the few helpers every page shares.
// No build step: pages import this file as it is. Components are written as
//
//   html`<button class="btn" onClick=${go}>${t('Go there')}</button>`
//
// Every word on screen goes through t() (account/dom.js), so the Chinese in
// assets/zh.js applies; web-i18n.test.js checks templates for bare English.

import { Fragment, createContext, h, render } from '../vendor/preact-10.29.8/preact.mjs';
import { useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useReducer, useRef, useState } from '../vendor/preact-10.29.8/hooks.mjs';
import htm from '../vendor/preact-10.29.8/htm.mjs';

export const html = htm.bind(h);
export { Fragment, createContext, h, render, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useReducer, useRef, useState };

/**
 * A value shared by components, and by code outside them, that redraws the
 * components using it when it changes. Set it to a new object rather than
 * changing the one inside: a store holds one value, not a copy of it.
 */
export function store(value) {
  const subs = new Set();
  return {
    get: () => value,
    set(next) {
      value = typeof next === 'function' ? next(value) : next;
      // A copy: a subscriber may unsubscribe while it's told.
      for (const f of Array.from(subs)) f(value);
    },
    subscribe(f) {
      subs.add(f);
      return () => subs.delete(f);
    },
  };
}

/** A store's value, redrawing this component whenever it's set. */
export function useStore(s) {
  const [, redraw] = useReducer((n) => n + 1, 0);
  const seen = useRef(s.get());
  useLayoutEffect(() => {
    // Set between the first draw and now: draw again with it.
    if (s.get() !== seen.current) redraw();
    return s.subscribe((v) => {
      seen.current = v;
      redraw();
    });
  }, [s]);
  return s.get();
}

/** Whether a media query matches, following it as it changes. */
export function useMedia(query) {
  const mq = useMemo(() => window.matchMedia(query), [query]);
  const [on, set] = useState(mq.matches);
  useEffect(() => {
    const f = () => set(mq.matches);
    mq.addEventListener('change', f);
    return () => mq.removeEventListener('change', f);
  }, [mq]);
  return on;
}

/** location.hash, following it as it changes. */
export function useHash() {
  const [hash, set] = useState(location.hash);
  useEffect(() => {
    const f = () => set(location.hash);
    window.addEventListener('hashchange', f);
    return () => window.removeEventListener('hashchange', f);
  }, []);
  return hash;
}

/** Runs `f` every `ms` while this component is drawn; null pauses it. */
export function useInterval(f, ms) {
  const latest = useRef(f);
  latest.current = f;
  useEffect(() => {
    if (ms == null) return;
    const id = setInterval(() => latest.current(), ms);
    return () => clearInterval(id);
  }, [ms]);
}

/**
 * A sentence from zh.js with markup in it (a link inside it): t() of a
 * constant, as text with its tags. Our own strings only, never data.
 */
export const Rich = ({ as = 'span', text, ...props }) => h(as, { ...props, dangerouslySetInnerHTML: { __html: text } });

/** What t() is given for a blank that Fill fills with a node. */
export const MARK = '\u0000';

/**
 * A translated sentence with nodes in its blanks, in the sentence's own
 * order (Chinese puts them elsewhere): Fill({ text: t('Sent to {0}.', MARK),
 * parts: [html`<strong>${email}</strong>`] }).
 */
export function Fill({ text, parts }) {
  return text.split(MARK).flatMap((bit, i) => (i < parts.length ? [bit, parts[i]] : [bit]));
}

/** An inline icon: `paths` is SVG markup we wrote, never data. */
export const Icon = ({ paths, size, ...props }) =>
  h('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true', ...(size ? { width: size, height: size } : {}), ...props, dangerouslySetInnerHTML: { __html: paths } });

/** Prefers reduced motion, read when asked. */
export const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/*
 * One status line for screen readers on each page, unseen, in the page from
 * the start: a live region only speaks a change, so it must be there before
 * the words are. Parts that redraw often (the card, Nearby, the offline
 * banner) say a short line here when what they mean changes, instead of
 * being live regions themselves and read out whole on every redraw.
 */
let spoken = null;
let lastSaid = '';
let sayTimer = null;
function speaker() {
  if (spoken?.isConnected) return spoken;
  spoken = Object.assign(document.createElement('div'), { className: 'sr-only' });
  spoken.setAttribute('role', 'status');
  document.body.append(spoken);
  return spoken;
}
if (globalThis.document?.body) speaker();

/**
 * Says `text` once on the page's status line, unless it was the last thing
 * said: the same card drawn again says nothing. `again`: say it even so.
 */
export function announce(text, { again = false } = {}) {
  if (!text || (!again && text === lastSaid)) return;
  lastSaid = text;
  const el = speaker();
  // Emptied first, then filled a moment later: the same words twice are a change.
  el.textContent = '';
  clearTimeout(sayTimer);
  sayTimer = setTimeout(() => (el.textContent = text), 50);
}

/**
 * A row's Remove (`button`) pressed: once the row has gone, the focus goes to
 * the row now in its place (or the one before, at the end of the list), else
 * to `fallback`, a heading with tabindex="-1". Without it, focus would be
 * lost to the top of the page.
 */
export function refocusAfterRemove(button, fallback) {
  const row = button.closest('li, details');
  const list = row?.parentElement;
  const rows = () => (list?.isConnected ? [...list.children].filter((c) => c.matches('li, details')) : []);
  const at = rows().indexOf(row);
  focusSoon(() => {
    // Not yet redrawn: the row is still there.
    if (row?.isConnected) return null;
    const left = rows();
    const next = left[Math.min(at, left.length - 1)];
    return next?.querySelector('summary, button, a, select, input') ?? fallback;
  });
}

/**
 * Focuses `el` once it's on the page, after the redraw under way: `el` is a
 * function returning the element, asked again until it is there (or 10 tries).
 */
export function focusSoon(el, tries = 10) {
  requestAnimationFrame(() => {
    const node = typeof el === 'function' ? el() : el;
    if (node?.isConnected && node.getClientRects().length) node.focus({ preventScroll: false });
    else if (tries > 1) focusSoon(el, tries - 1);
  });
}
