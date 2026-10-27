// The operator dashboard: /api/admin/stats, opened with a passkey (passkey.js),
// whose session is kept in this tab's sessionStorage only. Adding a passkey
// takes the HEALTH_TOKEN. English only: it's for the operator.
//
// A sidebar of sections (views.js), each its own address (#/answers), so a
// section can be linked to and the back button works. The stats refresh
// every minute while the tab is in front, keeping what's drawn until the
// new numbers arrive. Keys: 1–9 and 0 open a section, r refreshes, / searches.

import { html, render, store, useEffect, useMemo, useRef, useState, useStore } from '/assets/ui.js';
import { addPasskey, passkeysWork, signIn } from '/admin/passkey.js';
import { ago, when } from '/admin/parts.js';
import { Model } from '/admin/model.js';
import { Accounts, Answers, Arrivals, Collection, Crashes, Devices, Feed, Overview, Reports, SECTIONS, derive } from '/admin/views.js';

const KEY = 'terminus-operator-token';
const AUTO = 'terminus-admin-auto';
const SIDE = 'terminus-admin-side';
const EVERY_MS = 60_000;

/** The stats once unlocked, or the token form (with why), or a line saying what went wrong. */
const view = store({ locked: false, msg: '', stats: null, note: '', loading: false, at: 0 });

function token() {
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}

function remember(t) {
  try {
    if (t) sessionStorage.setItem(KEY, t);
    else sessionStorage.removeItem(KEY);
  } catch {
    // Without storage the token lasts until the page reloads.
  }
}

let memory = null;
/** Bumped by forget(): a stats reply asked for before then is dropped, not shown with the session gone. */
let session = 0;

/** Drops the token, from the tab and from this page. */
function forget() {
  remember(null);
  memory = null;
  session++;
}

const signedOut = (msg = '') => view.set({ locked: true, msg, stats: null, note: '', loading: false, at: 0 });

async function load() {
  const t = memory ?? token();
  if (!t) return signedOut();
  if (view.get().loading) return undefined;
  view.set((v) => ({ ...v, loading: true }));
  const asked = session;
  // Given up on after a while: a hung call would leave old stats up with no word of it.
  const res = await fetch('/api/admin/stats', {
    headers: { 'x-health-token': t },
    cache: 'no-store',
    signal: AbortSignal.timeout?.(20_000),
  }).catch(() => null);
  if (asked !== session || (memory ?? token()) !== t) return undefined;
  if (!res) return view.set((v) => ({ ...v, loading: false, note: "Couldn't reach terminus." }));
  if (res.status === 404) {
    forget();
    return signedOut('Signed out. Sign in again.');
  }
  if (!res.ok) return view.set((v) => ({ ...v, loading: false, note: `The stats answered ${res.status}.` }));
  try {
    const stats = await res.json();
    if (asked !== session) return undefined;
    view.set({ locked: false, msg: '', stats, note: '', loading: false, at: Date.now() });
  } catch (err) {
    // A stats reply this page can't read: say so, not a blank page.
    view.set((v) => ({ ...v, loading: false, note: `Couldn't show the stats: ${err.message}` }));
  }
}

/** Turns a collection switch on or off; the stats then show it as it is now. */
async function flip(name, on) {
  const res = await fetch('/api/admin/collect', {
    method: 'POST',
    headers: { 'x-health-token': memory ?? token(), 'content-type': 'application/json' },
    body: JSON.stringify({ name, on }),
  }).catch(() => null);
  if (!res) throw new Error("Couldn't reach terminus.");
  if (!res.ok) throw new Error(`The switch answered ${res.status}.`);
  const collect = await res.json();
  view.set((v) => ({ ...v, stats: v.stats && { ...v.stats, collect } }));
}

/** Hides a crash report until it's reported again; the stats then leave it out. */
async function dismiss(fingerprint) {
  const res = await fetch('/api/admin/crashes/dismiss', {
    method: 'POST',
    headers: { 'x-health-token': memory ?? token(), 'content-type': 'application/json' },
    body: JSON.stringify({ fingerprint }),
  }).catch(() => null);
  if (!res) throw new Error("Couldn't reach terminus.");
  if (!res.ok) throw new Error(`Dismissing answered ${res.status}.`);
  view.set((v) => ({
    ...v,
    stats: v.stats?.analytics && {
      ...v.stats,
      analytics: { ...v.stats.analytics, appErrors: (v.stats.analytics.appErrors ?? []).filter((e) => e.fingerprint !== fingerprint) },
    },
  }));
}

function lock() {
  forget();
  signedOut();
}

/** Keeps the session and opens the dashboard; or says what went wrong. */
async function unlockWith(get, setBusy) {
  setBusy(true);
  view.set((v) => ({ ...v, msg: '' }));
  try {
    memory = await get();
    remember(memory);
    await load();
  } catch (err) {
    view.set((v) => ({ ...v, msg: err.message }));
  } finally {
    setBusy(false);
  }
}

const KEY_ICON = html`<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="7.5" cy="15.5" r="5.5" /><path d="m21 2-9.6 9.6M15.5 7.5l3 3L22 7l-3-3" /></svg>`;

/** The card the gate shows: the mark, the title, and what's below. */
function GateCard({ sub, children }) {
  return html`
    <div class="gate">
      <div class="card gate-card">
        <span class="gate-icon">${KEY_ICON}</span>
        <h1>Dashboard</h1>
        <p class="hint">${sub}</p>
        ${children}
      </div>
    </div>
  `;
}

function Unlock({ msg }) {
  const box = useRef(null);
  const [busy, setBusy] = useState(false);
  if (!passkeysWork())
    return html`<${GateCard} sub="This browser can’t use passkeys. Open the dashboard in a current Chrome, Safari or Firefox." />`;
  return html`
    <${GateCard} sub="For the operator of terminus. Sign in with the passkey on this device.">
      <div class="unlock">
        <button type="button" class="btn accent" disabled=${busy} onClick=${() => unlockWith(signIn, setBusy)}>
          ${busy ? 'Waiting for your passkey…' : 'Sign in with a passkey'}
        </button>
        <p class="gate-msg" role="status">${msg}</p>
        <details class="add" open=${/add one|operator token|token was not/i.test(msg)}>
          <summary>First time on this device? Add a passkey</summary>
          <form
            onSubmit=${(e) => {
              e.preventDefault();
              const token = box.current.value.trim();
              box.current.value = '';
              unlockWith(() => addPasskey(token, navigator.userAgentData?.platform || navigator.platform || ''), setBusy);
            }}
          >
            <label for="token">Operator token</label>
            <div class="row">
              <input id="token" ref=${box} type="password" autocomplete="off" placeholder="HEALTH_TOKEN" required />
              <button type="submit" class="btn" disabled=${busy}>Add passkey</button>
            </div>
            <p class="hint">The <code>HEALTH_TOKEN</code> secret, once per device. It isn’t kept.</p>
          </form>
        </details>
      </div>
    <//>
  `;
}

/** The section and its options from the address: #/reports?open=fb-1. */
function parseHash() {
  const [path, qs] = location.hash.replace(/^#\/?/, '').split('?');
  const id = SECTIONS.some(([s]) => s === path) ? path : 'overview';
  return { id, query: Object.fromEntries(new URLSearchParams(qs ?? '')) };
}

function useRoute() {
  const [route, setRoute] = useState(parseHash);
  useEffect(() => {
    const on = () => {
      setRoute(parseHash());
      document.querySelector('.dash-main')?.scrollTo?.({ top: 0 });
      window.scrollTo({ top: 0 });
    };
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  return route;
}

/** Whether the stats refresh by themselves, as last chosen on this browser. */
function useAuto() {
  const [auto, setAuto] = useState(() => {
    try {
      return localStorage.getItem(AUTO) !== 'off';
    } catch {
      return true;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(AUTO, auto ? 'on' : 'off');
    } catch {
      // Kept for this page only.
    }
    if (!auto) return undefined;
    const tick = () => document.visibilityState === 'visible' && load();
    const id = setInterval(tick, EVERY_MS);
    // Back in front after a while: catch up at once.
    const seen = () => document.visibilityState === 'visible' && Date.now() - view.get().at > EVERY_MS && load();
    document.addEventListener('visibilitychange', seen);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', seen);
    };
  }, [auto]);
  return [auto, setAuto];
}

/** Whether the sidebar is narrowed to icons on a wide window, as last chosen on this browser. */
function useSideNarrow() {
  const [narrow, setNarrow] = useState(() => {
    try {
      return localStorage.getItem(SIDE) === 'narrow';
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(SIDE, narrow ? 'narrow' : 'wide');
    } catch {
      // Kept for this page only.
    }
  }, [narrow]);
  return [narrow, setNarrow];
}

const icon = (paths, size = 20) =>
  html`<svg viewBox="0 0 24 24" width=${size} height=${size} fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

const SIDE_ICON = icon(html`<rect x="3" y="4" width="18" height="16" rx="3" /><path d="M9 4v16" />`, 18);

/** Each section's icon, beside its name, and alone in the narrow sidebar. */
const ICONS = {
  overview: html`<rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" />`,
  accounts: html`<circle cx="9" cy="8" r="4" /><path d="M2 21a7 7 0 0 1 14 0" /><path d="M16 4.2a4 4 0 0 1 0 7.6M22 21a7 7 0 0 0-4-6.3" />`,
  devices: html`<rect x="6" y="2" width="12" height="20" rx="2.5" /><path d="M11 18h2" />`,
  answers: html`<path d="M21 12a8 8 0 0 1-11.6 7.1L4 21l1.9-5.4A8 8 0 1 1 21 12z" /><path d="m8.5 12 2.5 2.5 4.5-5" />`,
  arrivals: html`<circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" />`,
  model: html`<path d="M3 3v18h18" /><path d="m7 15 4-4 3 3 5-6" />`,
  feed: html`<circle cx="12" cy="12" r="2" /><path d="M16.2 7.8a6 6 0 0 1 0 8.4M7.8 16.2a6 6 0 0 1 0-8.4M19 5a10 10 0 0 1 0 14M5 19A10 10 0 0 1 5 5" />`,
  crashes: html`<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /><path d="M12 9v4M12 17h.01" />`,
  reports: html`<path d="M4 22V4M4 4h13l-2.5 4.5L17 13H4" />`,
  collection: html`<rect x="2" y="7" width="20" height="10" rx="5" /><circle cx="16" cy="12" r="3" />`,
  timelapse: html`<circle cx="12" cy="12" r="9" /><path d="m10 8.5 5.5 3.5-5.5 3.5z" />`,
};
const REFRESH_ICON = icon(html`<path d="M21 12a9 9 0 1 1-2.6-6.4L21 8" /><path d="M21 3v5h-5" />`, 18);
const LOCK_ICON = icon(html`<rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" />`, 18);

/** A clock for "updated 20 s ago". */
function useNow(ms = 5_000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

/** The sidebar's count or dot for a section, when it has something to say. */
function badge(id, s, d) {
  if (id === 'feed' && s.feed) return html`<span class=${`dot ${s.feed.up ? 'good' : 'bad'}`} title=${s.feed.up ? 'Up' : 'Down'}></span>`;
  if (id === 'crashes' && d.crashes.length) return html`<span class=${`count ${d.crashFatal ? 'bad' : ''}`}>${d.crashes.length}</span>`;
  if (id === 'reports' && s.feedback?.last7d) return html`<span class="count">${s.feedback.last7d}</span>`;
  if (id === 'collection') {
    const on = Object.values(s.collect ?? {}).filter(Boolean).length;
    return html`<span class="count quiet">${`${on}/${Object.keys(s.collect ?? {}).length}`}</span>`;
  }
  return null;
}

/** Lines a name in the narrow sidebar up with what it names: it's drawn outside the sidebar, which clips. */
function placeTip(e) {
  const el = e.target.closest?.('[data-tip]');
  if (!el) return;
  const r = el.getBoundingClientRect();
  el.style.setProperty('--tip-y', `${r.top + r.height / 2}px`);
}

const PAGES = {
  overview: Overview,
  accounts: Accounts,
  devices: Devices,
  answers: Answers,
  arrivals: Arrivals,
  model: Model,
  feed: Feed,
  crashes: Crashes,
  reports: Reports,
  collection: Collection,
};

function Dashboard({ v }) {
  const s = v.stats;
  const route = useRoute();
  const [auto, setAuto] = useAuto();
  const [narrow, setNarrow] = useSideNarrow();
  const now = useNow();
  const d = useMemo(() => derive(s), [s]);
  const [, title, what] = SECTIONS.find(([id]) => id === route.id);
  const Page = PAGES[route.id];

  useEffect(() => {
    document.title = `${title} · Dashboard · terminus`;
  }, [title]);
  useEffect(() => {
    const key = (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? '');
      if (typing) {
        if (e.key === 'Escape') document.activeElement.blur();
        return;
      }
      // 1 to 9, then 0 for the tenth.
      const n = e.key === '0' ? 10 : Number(e.key);
      if (n >= 1 && n <= SECTIONS.length) location.hash = `#/${SECTIONS[n - 1][0]}`;
      else if (e.key === 'r') load();
      else if (e.key === '[') setNarrow((n) => !n);
      else if (e.key === '/') {
        const box = document.querySelector('[data-search]');
        if (!box) return;
        box.focus();
      } else return;
      e.preventDefault();
    };
    addEventListener('keydown', key);
    return () => removeEventListener('keydown', key);
  }, []);

  return html`
    <div class=${`dash ${v.loading ? 'loading' : ''} ${narrow ? 'side-rail' : ''}`}>
      <div class="progress" aria-hidden="true"></div>
      <aside class="side" id="side" onPointerOver=${placeTip} onfocusin=${placeTip}>
        <div class="side-top">
          <a class="brand" href="/"><img src="/assets/mark.svg" alt="" /><span class="wordmark">termi<b>nus</b></span></a>
          <button
            type="button"
            class="side-toggle"
            title=${narrow ? null : 'Collapse sidebar ( [ )'}
            data-tip="Expand sidebar ( [ )"
            aria-label=${narrow ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-controls="side"
            aria-expanded=${narrow ? 'false' : 'true'}
            onClick=${() => setNarrow(!narrow)}
          >
            ${SIDE_ICON}
          </button>
        </div>
        <nav aria-label="Sections">
          ${SECTIONS.map(
            ([id, name], i) => html`<a
              href=${`#/${id}`}
              class=${route.id === id ? 'on' : ''}
              aria-current=${route.id === id ? 'page' : null}
              data-tip=${name}
            >
              <span class="ic">${icon(ICONS[id])}${id !== 'collection' && html`<span class="pip" aria-hidden="true">${badge(id, s, d)}</span>`}</span
              ><span class="name">${name}</span>${badge(id, s, d)}<kbd
                >${(i + 1) % 10}</kbd
              >
            </a>`,
          )}
          <a href="/admin/timelapse/" class="out" data-tip="Timelapse ↗"
            ><span class="ic">${icon(ICONS.timelapse)}</span><span class="name">Timelapse</span
            ><span class="arrow" aria-hidden="true">↗</span></a
          >
        </nav>
        <div class="side-foot">
          <label class="auto" data-tip="Refresh every minute">
            <input type="checkbox" checked=${auto} onChange=${(e) => setAuto(e.currentTarget.checked)} />
            <span class="long">Refresh every minute</span><span class="short">Auto</span>
          </label>
          <div class="row">
            <button type="button" class="btn small ghost" onClick=${load} disabled=${v.loading} data-tip="Refresh ( r )">
              ${REFRESH_ICON}<span class="t">${v.loading ? 'Refreshing…' : 'Refresh'}</span>
            </button>
            <button type="button" class="btn small ghost" onClick=${lock} data-tip="Lock">${LOCK_ICON}<span class="t">Lock</span></button>
          </div>
          <p class="hint keys">
            <span><kbd>1</kbd>–<kbd>0</kbd> section</span><span><kbd>r</kbd> refresh</span><span><kbd>/</kbd> search</span><span><kbd>[</kbd> sidebar</span>
          </p>
        </div>
      </aside>
      <main class="dash-main">
        <header class="dash-h">
          <div>
            <h1>${title}</h1>
            <p class="hint">${what}</p>
          </div>
          <p class="hint asof" role="status">
            ${v.note ? html`<span class="bad">${v.note}</span>` : html`<span>${`As of ${when(s.now)} Singapore time`}</span>`}
            <span>${` · updated ${ago(new Date(v.at).toISOString(), now)}`}</span>
          </p>
        </header>
        <div class="page" key=${route.id}>
          <${Page} s=${s} d=${d} query=${route.query} flip=${flip} dismiss=${dismiss} />
        </div>
      </main>
    </div>
  `;
}

function Admin() {
  const v = useStore(view);
  useEffect(() => {
    document.body.classList.toggle('dash-on', Boolean(v.stats));
  }, [Boolean(v.stats)]);
  if (v.locked) return html`<${Unlock} msg=${v.msg} />`;
  // The first load failed: the dashboard's own Refresh isn't drawn yet, and nothing tries again by itself.
  if (!v.stats)
    return html`<${GateCard} sub=${v.note || 'Loading…'}>
      ${v.note && html`<button type="button" class="btn" onClick=${load} disabled=${v.loading}>Try again</button>`}
    <//>`;
  return html`<${Dashboard} v=${v} />`;
}

render(html`<${Admin} />`, document.getElementById('admin'));
load();
