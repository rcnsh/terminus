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
