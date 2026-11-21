import { Fragment, createContext, h, render } from '../vendor/preact-10.29.8/preact.mjs';
import {
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from '../vendor/preact-10.29.8/hooks.mjs';
import htm from '../vendor/preact-10.29.8/htm.mjs';

export const html = htm.bind(h);
export {
  Fragment,
  createContext,
  h,
  render,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
};

export function store(value) {
  const subs = new Set();
  return {
    get: () => value,
    set(next) {
      value = typeof next === 'function' ? next(value) : next;
      for (const f of Array.from(subs)) f(value);
    },
    subscribe(f) {
      subs.add(f);
      return () => subs.delete(f);
    },
  };
}

export function useStore(s) {
  const [, redraw] = useReducer((n) => n + 1, 0);
  const seen = useRef(s.get());
  useLayoutEffect(() => {
    if (s.get() !== seen.current) redraw();
    return s.subscribe((v) => {
      seen.current = v;
      redraw();
    });
  }, [s]);
  return s.get();
}

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

export const shortBelow = 500;
export const SHORT = `(max-height: ${shortBelow - 0.02}px)`;
export const useShort = () => useMedia(SHORT);

export function useHash() {
  const [hash, set] = useState(location.hash);
  useEffect(() => {
    const f = () => set(location.hash);
    window.addEventListener('hashchange', f);
    return () => window.removeEventListener('hashchange', f);
  }, []);
  return hash;
}

export function useInterval(f, ms) {
  const latest = useRef(f);
  latest.current = f;
  useEffect(() => {
    if (ms == null) return;
    const id = setInterval(() => latest.current(), ms);
    return () => clearInterval(id);
  }, [ms]);
}

export const Rich = ({ as = 'span', text, ...props }) => h(as, { ...props, dangerouslySetInnerHTML: { __html: text } });

export const MARK = '\u0000';

export function Fill({ text, parts }) {
  return text.split(MARK).flatMap((bit, i) => (i < parts.length ? [bit, parts[i]] : [bit]));
}

export const Icon = ({ paths, size, ...props }) =>
  h('svg', {
    viewBox: '0 0 24 24',
    'aria-hidden': 'true',
    ...(size ? { width: size, height: size } : {}),
    ...props,
    dangerouslySetInnerHTML: { __html: paths },
  });

export const Bar = ({ w, h = null }) =>
  html`<span class="sk-line" style=${{ width: w }} aria-hidden="true"><span class="sk" style=${h ? { height: h } : undefined}></span></span>`;

export const Skeleton = ({ said, quiet = false, cls = null, inner = null, children }) =>
  html`<div class=${cls} aria-busy="true"><div class=${inner} aria-hidden="true">${children}</div><p class="sr-only" role=${quiet ? undefined : 'status'}>${said}</p></div>`;

export const widthOf = (set, i) => set[i % set.length];

export const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

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

export function announce(text, { again = false } = {}) {
  if (!text || (!again && text === lastSaid)) return;
  lastSaid = text;
  const el = speaker();
  el.textContent = '';
  clearTimeout(sayTimer);
  sayTimer = setTimeout(() => (el.textContent = text), 50);
}

export function refocusAfterRemove(button, fallback) {
  noteRow(button)(fallback);
}

export function noteRow(button) {
  const row = button.closest('li, details');
  const list = row?.parentElement;
  const rows = () => (list?.isConnected ? [...list.children].filter((c) => c.matches('li, details')) : []);
  const at = rows().indexOf(row);
  return (fallback) =>
    focusSoon(() => {
      if (row?.isConnected) return null;
      const left = rows();
      const next = left[Math.min(at, left.length - 1)];
      return next?.querySelector('summary, button, a, select, input') ?? (typeof fallback === 'function' ? fallback() : fallback);
    });
}

export function focusSoon(el, { preventScroll = false } = {}, tries = 10) {
  requestAnimationFrame(() => {
    const node = typeof el === 'function' ? el() : el;
    if (node?.isConnected && node.getClientRects().length) node.focus({ preventScroll });
    else if (tries > 1) focusSoon(el, { preventScroll }, tries - 1);
  });
}
