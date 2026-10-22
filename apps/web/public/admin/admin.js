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

/** Drops the token, from the tab and from this page. */
function forget() {
  remember(null);
  memory = null;
}

const signedOut = (msg = '') => view.set({ locked: true, msg, stats: null, note: '', loading: false, at: 0 });

async function load() {
  const t = memory ?? token();
  if (!t) return signedOut();
  if (view.get().loading) return undefined;
  view.set((v) => ({ ...v, loading: true }));
  // Given up on after a while: a hung call would leave old stats up with no word of it.
  const res = await fetch('/api/admin/stats', {
    headers: { 'x-health-token': t },
    cache: 'no-store',
    signal: AbortSignal.timeout?.(20_000),
  }).catch(() => null);
  if (!res) return view.set((v) => ({ ...v, loading: false, note: "Couldn't reach terminus." }));
  if (res.status === 404) {
    forget();
    return signedOut('Signed out. Sign in again.');
  }
  if (!res.ok) return view.set((v) => ({ ...v, loading: false, note: `The stats answered ${res.status}.` }));
  try {
    view.set({ locked: false, msg: '', stats: await res.json(), note: '', loading: false, at: Date.now() });
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

function Unlock({ msg }) {
  const box = useRef(null);
  const [busy, setBusy] = useState(false);
  if (!passkeysWork())
    return html`<p class="card hint">This browser can’t use passkeys. Open the dashboard in a current Chrome, Safari or Firefox.</p>`;
  return html`
    <div class="card unlock">
      <button type="button" class="btn accent" disabled=${busy} onClick=${() => unlockWith(signIn, setBusy)}>Sign in with a passkey</button>
      <p class="hint" role="status">${msg}</p>
      <form
        class="add"
        onSubmit=${(e) => {
          e.preventDefault();
          const token = box.current.value.trim();
          box.current.value = '';
          unlockWith(() => addPasskey(token, navigator.userAgentData?.platform || navigator.platform || ''), setBusy);
        }}
      >
        <label for="token">Add a passkey on this device</label>
        <p class="hint">Needs the <code>HEALTH_TOKEN</code> secret, once. It isn’t kept.</p>
        <div class="row">
          <input id="token" ref=${box} type="password" autocomplete="off" placeholder="Operator token" required />
          <button type="submit" class="btn" disabled=${busy}>Add passkey</button>
        </div>
      </form>
    </div>
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
    <div class=${`dash ${v.loading ? 'loading' : ''}`}>
      <div class="progress" aria-hidden="true"></div>
      <aside class="side">
        <a class="brand" href="/"><img src="/assets/mark.svg" alt="" /><span class="wordmark">termi<b>nus</b></span></a>
        <nav aria-label="Sections">
          ${SECTIONS.map(
            (
              [id, name],
              i,
            ) => html`<a href=${`#/${id}`} class=${route.id === id ? 'on' : ''} aria-current=${route.id === id ? 'page' : null}>
              <span>${name}</span>${badge(id, s, d)}<kbd>${(i + 1) % 10}</kbd>
            </a>`,
          )}
          <a href="/admin/timelapse/" class="out"><span>Timelapse</span><span aria-hidden="true">↗</span></a>
        </nav>
        <div class="side-foot">
          <label class="auto">
            <input type="checkbox" checked=${auto} onChange=${(e) => setAuto(e.currentTarget.checked)} />
            <span class="long">Refresh every minute</span><span class="short">Auto</span>
          </label>
          <div class="row">
            <button type="button" class="btn small ghost" onClick=${load} disabled=${v.loading}>${v.loading ? 'Refreshing…' : 'Refresh'}</button>
            <button type="button" class="btn small ghost" onClick=${lock}>Lock</button>
          </div>
          <p class="hint keys">
            <span><kbd>1</kbd>–<kbd>0</kbd> section</span><span><kbd>r</kbd> refresh</span><span><kbd>/</kbd> search</span>
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
          <${Page} s=${s} d=${d} query=${route.query} flip=${flip} />
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
  if (v.locked) return html`<div class="gate"><h1>Dashboard</h1><${Unlock} msg=${v.msg} /></div>`;
  if (!v.stats) return html`<div class="gate"><h1>Dashboard</h1><p class="hint">${v.note || 'Loading…'}</p></div>`;
  return html`<${Dashboard} v=${v} />`;
}

render(html`<${Admin} />`, document.getElementById('admin'));
load();
