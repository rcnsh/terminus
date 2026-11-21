import { html, render, store, useEffect, useMemo, useRef, useState, useStore } from '/assets/ui.js';
import { addPasskey, passkeysWork, signIn } from '/admin/passkey.js';
import { ago, motion, when } from '/admin/parts.js';
import { Model } from '/admin/model.js';
import { Accounts, Answers, Arrivals, Collection, Crashes, Devices, Feed, Overview, Reports, SECTIONS, derive } from '/admin/views.js';
import { local, perTab } from '/assets/storage.js';

const KEY = 'terminus-operator-token';
const ONLY = 'terminus-timelapse-only';
const AUTO = 'terminus-admin-auto';
const SIDE = 'terminus-admin-side';
const EVERY_MS = 60_000;

const view = store({ locked: false, msg: '', stats: null, note: '', loading: false, at: 0, only: false });

function token() {
  return perTab.get(KEY);
}

function timelapseOnly() {
  if (memory) return onlyMemory;
  return perTab.get(ONLY) === '1';
}

function remember(t, only = false) {
  if (t) perTab.set(KEY, t);
  else perTab.remove(KEY);
  if (t && only) perTab.set(ONLY, '1');
  else perTab.remove(ONLY);
}

let memory = null;
let onlyMemory = false;
let session = 0;

function forget() {
  remember(null);
  memory = null;
  onlyMemory = false;
  session++;
  timelapse?.then((m) => m.forget()).catch(() => {});
}

const signedOut = (msg = '') => view.set({ locked: true, msg, stats: null, note: '', loading: false, at: 0, only: false });

async function load() {
  const t = memory ?? token();
  if (!t) return signedOut();
  if (timelapseOnly()) {
    if (!view.get().only) view.set({ locked: false, msg: '', stats: null, note: '', loading: false, at: 0, only: true });
    return undefined;
  }
  if (view.get().loading) return undefined;
  view.set((v) => ({ ...v, loading: true }));
  const asked = session;
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
    view.set((v) => ({ ...v, loading: false, note: `Couldn't show the stats: ${err.message}` }));
  }
}

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

const deleted = new Set();

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

async function remove(id) {
  const asked = session;
  const t = memory ?? token();
  const res = await fetch('/api/admin/reports/delete', {
    method: 'POST',
    headers: { 'x-health-token': t, 'content-type': 'application/json' },
    body: JSON.stringify({ id }),
  }).catch(() => null);
  if (!res) throw new Error("Couldn't reach terminus.");
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

async function checkTimelapseToken(t) {
  const res = await fetch('/api/timelapse/days', { headers: { 'x-health-token': t }, cache: 'no-store' }).catch(() => null);
  if (!res) throw new Error("Couldn't reach terminus.");
  if (res.status === 404) throw new Error('The timelapse token was not accepted.');
  if (!res.ok) throw new Error(`The server answered ${res.status}.`);
  return t;
}

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
        timelapse = null;
        setErr(e.message);
      },
    );
  }, []);
  if (err) return html`<p class="bad">${`Couldn't load the timelapse: ${err}`}</p>`;
  return Page ? html`<${Page} />` : html`<p class="hint">Loading…</p>`;
}

const KEY_ICON = html`<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="7.5" cy="15.5" r="5.5" /><path d="m21 2-9.6 9.6M15.5 7.5l3 3L22 7l-3-3" /></svg>`;

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

const TIMELAPSE = ['timelapse', 'Timelapse', 'Replay a recorded day of shuttles on the map, and export it as a video.'];

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

function useAuto() {
  const [auto, setAuto] = useState(() => local.get(AUTO) !== 'off');
  useEffect(() => {
    local.set(AUTO, auto ? 'on' : 'off');
    if (!auto) return undefined;
    const tick = () => document.visibilityState === 'visible' && load();
    const id = setInterval(tick, EVERY_MS);
    const seen = () => document.visibilityState === 'visible' && Date.now() - view.get().at > EVERY_MS && load();
    document.addEventListener('visibilitychange', seen);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', seen);
    };
  }, [auto]);
  return [auto, setAuto];
}

function useSideNarrow() {
  const [narrow, setNarrow] = useState(() => local.get(SIDE) === 'narrow');
  useEffect(() => {
    local.set(SIDE, narrow ? 'narrow' : 'wide');
  }, [narrow]);
  return [narrow, setNarrow];
}

const icon = (paths, size = 20) =>
  html`<svg viewBox="0 0 24 24" width=${size} height=${size} fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

const SIDE_ICON = icon(html`<rect x="3" y="4" width="18" height="16" rx="3" /><path d="M9 4v16" />`, 18);

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

function useNow(ms = 5_000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

function badge(id, s, d) {
  if (!s) return null;
  if (id === 'feed' && s.feed) return html`<span class=${`dot ${s.feed.up ? 'good' : 'bad'}`} title=${s.feed.up ? 'Up' : 'Down'}></span>`;
  if (id === 'crashes' && d.crashReports) return html`<span class=${`count ${d.crashFatal ? 'bad' : ''}`}>${d.crashReports}</span>`;
  if (id === 'reports' && s.feedback?.last7d) return html`<span class="count">${s.feedback.last7d}</span>`;
  if (id === 'collection') {
    const on = Object.values(s.collect ?? {}).filter(Boolean).length;
    if (on === Object.keys(s.collect ?? {}).length) return null;
    return html`<span class="count quiet">${on ? `${on} on` : 'all off'}</span>`;
  }
  return null;
}

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
  const only = v.only || timelapseOnly();
  const route = only ? { id: 'timelapse', query: {} } : asked;
  const [auto, setAuto] = useAuto();
  const [narrow, setNarrow] = useSideNarrow();
  const now = useNow();
  const d = useMemo(() => s && derive(s), [s]);
  const [, title, what] = [...SECTIONS, TIMELAPSE].find(([id]) => id === route.id);
  const Page = PAGES[route.id];
  const tl = route.id === 'timelapse';
  const [opening, setOpening] = useState(true);
  const opened = useRef(route.id);
  useEffect(() => {
    const id = setTimeout(() => setOpening(false), 900);
    return () => clearTimeout(id);
  }, []);
  if (route.id !== opened.current) opened.current = null;
  const intro = opening && opened.current !== null;
  motion.intro = intro;

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
    <div class=${`dash ${v.loading && !tl ? 'loading' : ''} ${narrow ? 'side-rail' : ''} ${intro ? 'intro' : ''}`}>
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
            <span>Refresh every minute</span>
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
  const tlAlone = !v.locked && route.id === 'timelapse' && Boolean(memory ?? token());
  const on = !v.locked && Boolean(v.stats || v.only || tlAlone);
  useEffect(() => {
    document.body.classList.toggle('dash-on', on);
  }, [on]);
  if (v.locked) return html`<${Unlock} msg=${v.msg} />`;
  if (!v.stats && !v.only && !tlAlone)
    return html`<${GateCard} sub=${v.note || 'Loading…'}>
      ${v.note && html`<button type="button" class="btn" onClick=${load} disabled=${v.loading}>Try again</button>`}
    <//>`;
  return html`<${Dashboard} v=${v} asked=${route} />`;
}

render(html`<${Admin} />`, document.getElementById('admin'));
load();
