// The operator dashboard: /api/admin/stats, opened with a passkey (passkey.js),
// whose session is kept in this tab's sessionStorage only. Adding a passkey
// takes the HEALTH_TOKEN. English only: it's for the operator.
//
// A sidebar of sections (views.js), each its own address (#/answers), so a
// section can be linked to and the back button works. The stats refresh
// every minute while the tab is in front, keeping what's drawn until the
// new numbers arrive. Keys: 1–9 and 0 open a section, r refreshes, / searches.
//
// Below them, the Timelapse (#/timelapse, timelapse/timelapse.js, loaded
// when opened). The TIMELAPSE_TOKEN signs in too, for the machine that
// renders the videos (render-timelapse.mjs): it opens that section alone,
// with no stats, since the API answers it nothing else.

import { html, render, store, useEffect, useMemo, useRef, useState, useStore } from '/assets/ui.js';
import { addPasskey, passkeysWork, signIn } from '/admin/passkey.js';
import { ago, when } from '/admin/parts.js';
import { Model } from '/admin/model.js';
import { Accounts, Answers, Arrivals, Collection, Crashes, Devices, Feed, Overview, Reports, SECTIONS, derive } from '/admin/views.js';

const KEY = 'terminus-operator-token';
/** Set beside the token when it's the timelapse token. */
const ONLY = 'terminus-timelapse-only';
const AUTO = 'terminus-admin-auto';
const SIDE = 'terminus-admin-side';
const EVERY_MS = 60_000;

/** The stats once unlocked, or the token form (with why), or a line saying what went wrong.
 *  `only`: signed in with the timelapse token, so the Timelapse is all there is. */
const view = store({ locked: false, msg: '', stats: null, note: '', loading: false, at: 0, only: false });

function token() {
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}

function timelapseOnly() {
  if (memory) return onlyMemory;
  try {
    return sessionStorage.getItem(ONLY) === '1';
  } catch {
    return false;
  }
}

function remember(t, only = false) {
  try {
    if (t) sessionStorage.setItem(KEY, t);
    else sessionStorage.removeItem(KEY);
    if (t && only) sessionStorage.setItem(ONLY, '1');
    else sessionStorage.removeItem(ONLY);
  } catch {
    // Without storage the token lasts until the page reloads.
  }
}

let memory = null;
let onlyMemory = false;
/** Bumped by forget(): a stats reply asked for before then is dropped, not shown with the session gone. */
let session = 0;

/** Drops the token, from the tab and from this page. */
function forget() {
  remember(null);
  memory = null;
  onlyMemory = false;
  session++;
  // The Timelapse's day, video and any export in progress go with the session.
  timelapse?.then((m) => m.forget()).catch(() => {});
}

const signedOut = (msg = '') => view.set({ locked: true, msg, stats: null, note: '', loading: false, at: 0, only: false });

async function load() {
  const t = memory ?? token();
  if (!t) return signedOut();
  // No stats for the timelapse token: the section checks it, and signs out when it's refused.
  if (timelapseOnly()) {
    if (!view.get().only) view.set({ locked: false, msg: '', stats: null, note: '', loading: false, at: 0, only: true });
    return undefined;
  }
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
    view.set({ locked: false, msg: '', stats: withoutDeleted(stats), note: '', loading: false, at: Date.now(), only: false });
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

/** Reports deleted in this tab: a stats load already under way when one was deleted still has it. */
const deleted = new Set();

/** The stats without the reports deleted here, the week's count with them. */
function withoutDeleted(stats) {
  const fb = stats?.feedback;
  const gone = fb?.latest.filter((f) => deleted.has(f.id)) ?? [];
  if (!gone.length) return stats;
  const week = Date.parse(stats.now) - 7 * 86_400_000;
  return {
    ...stats,
    feedback: {
      ...fb,
      last7d: fb.last7d - gone.filter((f) => Date.parse(f.created) > week).length,
      latest: fb.latest.filter((f) => !deleted.has(f.id)),
    },
  };
}

/** Deletes a user's report for good; the dashboard then leaves it out. */
async function remove(id) {
  const asked = session;
  const t = memory ?? token();
  const res = await fetch('/api/admin/reports/delete', {
    method: 'POST',
    headers: { 'x-health-token': t, 'content-type': 'application/json' },
    body: JSON.stringify({ id }),
  }).catch(() => null);
  if (!res) throw new Error("Couldn't reach terminus.");
  // A reply to a session since replaced says nothing about the new one.
  const stale = asked !== session || (memory ?? token()) !== t;
  if (res.status === 404) {
    if (stale) return undefined;
    forget();
    return signedOut('Signed out. Sign in again.');
  }
  if (!res.ok) throw new Error(`Deleting answered ${res.status}.`);
  deleted.add(id);
  view.set((v) => ({ ...v, stats: withoutDeleted(v.stats) }));
}

function lock() {
  forget();
  signedOut();
}

/** Keeps the session and opens the dashboard (only the Timelapse, for the timelapse token); or says what went wrong. */
async function unlockWith(get, setBusy, only = false) {
  setBusy(true);
  view.set((v) => ({ ...v, msg: '' }));
  try {
    const t = await get();
    forget();
    memory = t;
    onlyMemory = only;
    remember(t, only);
    await load();
  } catch (err) {
    view.set((v) => ({ ...v, msg: err.message }));
  } finally {
    setBusy(false);
  }
}

/** The timelapse token, if the API takes it: else it would open a section that can only sign out again. */
async function checkTimelapseToken(t) {
  const res = await fetch('/api/timelapse/days', { headers: { 'x-health-token': t }, cache: 'no-store' }).catch(() => null);
  if (!res) throw new Error("Couldn't reach terminus.");
  if (res.status === 404) throw new Error('The timelapse token was not accepted.');
  if (!res.ok) throw new Error(`The server answered ${res.status}.`);
  return t;
}

/** The timelapse section's loaded module, once asked for. */
let timelapse = null;

const timelapseSignedOut = () => {
  forget();
  signedOut('Signed out, or the token was not accepted. Sign in again.');
};

function TimelapsePage() {
  const [Page, setPage] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    timelapse ??= import('/admin/timelapse/timelapse.js').then((m) => {
      m.connect({ token: () => memory ?? token(), signedOut: timelapseSignedOut });
      return m;
    });
    timelapse.then(
      (m) => setPage(() => m.Timelapse),
      (e) => {
        // Tried again on the next visit.
        timelapse = null;
        setErr(e.message);
      },
    );
  }, []);
  if (err) return html`<p class="bad">${`Couldn't load the timelapse: ${err}`}</p>`;
  return Page ? html`<${Page} />` : html`<p class="hint">Loading…</p>`;
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
  const tlBox = useRef(null);
  const [busy, setBusy] = useState(false);
  const passkeys = passkeysWork();
  const forTimelapse = !passkeys || parseHash().id === 'timelapse' || /timelapse/i.test(msg);
  // The timelapse token needs no passkey: its form is there in any browser.
  const timelapseForm = html`
    <details class="add" open=${forTimelapse}>
      <summary>Only making videos? Use the timelapse token</summary>
      <form
        onSubmit=${(e) => {
          e.preventDefault();
          const token = tlBox.current.value.trim();
          tlBox.current.value = '';
          unlockWith(
            () =>
              checkTimelapseToken(token).then((t) => {
                // Only once it's taken: a refused token leaves the address as it was.
                if (!location.hash.startsWith('#/timelapse')) location.hash = '#/timelapse';
                return t;
              }),
            setBusy,
            true,
          );
        }}
      >
        <label for="timelapse-token">Timelapse token</label>
        <div class="row">
          <input id="timelapse-token" ref=${tlBox} type="password" autocomplete="off" required />
          <button type="submit" class="btn" disabled=${busy}>Open the timelapse</button>
        </div>
        <p class="hint">The <code>TIMELAPSE_TOKEN</code> secret. It opens the timelapse and nothing else, until you lock this tab.</p>
      </form>
    </details>
  `;
  if (!passkeys)
    return html`<${GateCard} sub="This browser can’t use passkeys. Open the dashboard in a current Chrome, Safari or Firefox.">
      <div class="unlock">
        <p class="gate-msg" role="status">${msg}</p>
        ${timelapseForm}
      </div>
    <//>`;
  return html`
    <${GateCard} sub="For the operator of terminus. Sign in with the passkey on this device.">
      <div class="unlock">
        <button type="button" class="btn accent" disabled=${busy} onClick=${() => unlockWith(signIn, setBusy)}>
          ${busy ? 'Waiting for your passkey…' : 'Sign in with a passkey'}
        </button>
        <p class="gate-msg" role="status">${msg}</p>
        <details class="add" open=${/add one|operator token|that token was not/i.test(msg)}>
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
        ${timelapseForm}
      </div>
    <//>
  `;
}

/** Below the sections, apart from them: it draws no stats, and the timelapse token opens it alone. */
const TIMELAPSE = ['timelapse', 'Timelapse', 'Replay a recorded day of shuttles on the map, and export it as a video.'];

/** The section and its options from the address: #/reports?open=fb-1. */
function parseHash() {
  const [path, qs] = location.hash.replace(/^#\/?/, '').split('?');
  const id = SECTIONS.some(([s]) => s === path) || path === TIMELAPSE[0] ? path : 'overview';
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
  if (!s) return null;
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
  timelapse: TimelapsePage,
};

function Dashboard({ v, asked }) {
  const s = v.stats;
  // Also before load() has set it, on a reload: no other section flashes up first.
  const only = v.only || timelapseOnly();
  const route = only ? { id: 'timelapse', query: {} } : asked;
  const [auto, setAuto] = useAuto();
  const [narrow, setNarrow] = useSideNarrow();
  const now = useNow();
  const d = useMemo(() => s && derive(s), [s]);
  const [, title, what] = [...SECTIONS, TIMELAPSE].find(([id]) => id === route.id);
  const Page = PAGES[route.id];
  const tl = route.id === 'timelapse';

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
      // 1 to 9, then 0 for the tenth. None of them for the timelapse token, which opens no section.
      const n = e.key === '0' ? 10 : Number(e.key);
      const all = !view.get().only;
      if (all && n >= 1 && n <= SECTIONS.length) location.hash = `#/${SECTIONS[n - 1][0]}`;
      else if (all && e.key === 'r') load();
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
    <div class=${`dash ${v.loading && !tl ? 'loading' : ''} ${narrow ? 'side-rail' : ''}`}>
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
          ${
            !only &&
            SECTIONS.map(
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
            )
          }
          <a
            href="#/timelapse"
            class=${`${only ? '' : 'apart'} ${tl ? 'on' : ''}`}
            aria-current=${tl ? 'page' : null}
            data-tip="Timelapse"
            ><span class="ic">${icon(ICONS.timelapse)}</span><span class="name">Timelapse</span></a
          >
        </nav>
        <div class="side-foot">
          ${
            !only &&
            html`<label class="auto" data-tip="Refresh every minute">
            <input type="checkbox" checked=${auto} onChange=${(e) => setAuto(e.currentTarget.checked)} />
            <span class="long">Refresh every minute</span><span class="short">Auto</span>
          </label>`
          }
          <div class="row">
            ${
              !only &&
              html`<button type="button" class="btn small ghost" onClick=${load} disabled=${v.loading} data-tip="Refresh ( r )">
              ${REFRESH_ICON}<span class="t">${v.loading ? 'Refreshing…' : 'Refresh'}</span>
            </button>`
            }
            <button type="button" class="btn small ghost" onClick=${lock} data-tip="Lock">${LOCK_ICON}<span class="t">Lock</span></button>
          </div>
          <p class="hint keys">
            ${!only && html`<span><kbd>1</kbd>–<kbd>0</kbd> section</span><span><kbd>r</kbd> refresh</span><span><kbd>/</kbd> search</span>`}<span
              ><kbd>[</kbd> sidebar</span
            >
          </p>
        </div>
      </aside>
      <main class="dash-main">
        <header class="dash-h">
          <div>
            <h1>${title}</h1>
            <p class="hint">${what}</p>
          </div>
          ${
            !tl &&
            html`<p class="hint asof" role="status">
            ${v.note ? html`<span class="bad">${v.note}</span>` : html`<span>${`As of ${when(s.now)} Singapore time`}</span>`}
            <span>${` · updated ${ago(new Date(v.at).toISOString(), now)}`}</span>
          </p>`
          }
        </header>
        <div class="page" key=${route.id}>
          <${Page} s=${s} d=${d} query=${route.query} flip=${flip} dismiss=${dismiss} remove=${remove} />
        </div>
      </main>
    </div>
  `;
}

function Admin() {
  const v = useStore(view);
  const route = useRoute();
  // The Timelapse needs no stats: it opens while they load, or when they fail.
  const tlAlone = !v.locked && route.id === 'timelapse' && Boolean(memory ?? token());
  const on = !v.locked && Boolean(v.stats || v.only || tlAlone);
  useEffect(() => {
    document.body.classList.toggle('dash-on', on);
  }, [on]);
  if (v.locked) return html`<${Unlock} msg=${v.msg} />`;
  // The first load failed: the dashboard's own Refresh isn't drawn yet, and nothing tries again by itself.
  if (!v.stats && !v.only && !tlAlone)
    return html`<${GateCard} sub=${v.note || 'Loading…'}>
      ${v.note && html`<button type="button" class="btn" onClick=${load} disabled=${v.loading}>Try again</button>`}
    <//>`;
  return html`<${Dashboard} v=${v} asked=${route} />`;
}

render(html`<${Admin} />`, document.getElementById('admin'));
load();
