import {
  Bar,
  Fill,
  Icon,
  MARK,
  Rich,
  Skeleton,
  announce,
  focusSoon,
  html,
  render,
  store,
  useEffect,
  useMedia,
  useRef,
  useShort,
  useState,
  useStore,
} from '/assets/ui.js';
import { ADDED_PLACES_KEY, api, clock, hour12, send, serverNow, signedOut, t } from '/account/dom.js';
import { Card, InSky, Message, Report, Say, isStale, signal } from '/account/preview.js';
import { Band, Celestial, Horizon, useNowSky, useSkyPhase } from '/account/sky.js';
import {
  Toast,
  campus,
  campusRefused,
  lists,
  loadCampus,
  loadProfile,
  profile,
  reloadProfile,
  toast,
  walkSpeed,
} from '/account/profile.js';
import { SearchBox } from '/account/search-box.js';
import { ServicesSkeleton } from '/app/board.js';
import { PinnedSkeleton, SignSkeleton, StopSign, anyGuess, keepPinCount, pinAccount } from '/app/sign.js';
import { offlineNext } from '/app/offline.js';
import { preloadMap } from '/app/map-files.js';
import {
  FIX_FRESH_MS,
  FIX_GRACE_MS,
  PULL_FRESH_MS,
  REFRESH_MS,
  fixQuery,
  fixToSend,
  markWaitMs,
  refreshAgain,
  slowRetryMs,
  staleText,
} from '/app/timing.js';
import { PullToRefresh } from '/app/pull.js';
import { TABS, tabOf } from '/app/tabs.js';

const DAY_MS = 120_000;

const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const iPhone =
  !/Android/.test(navigator.userAgent) &&
  (/iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));

const target = store({ kind: 'plan' });
const places = store([]);
profile.subscribe((p) => p && places.set(p.places.map(({ key, label }) => ({ key, label }))));
const me = store(null);
me.subscribe((m) => pinAccount.set(m?.email ?? null));
profile.subscribe((p) => {
  const account = pinAccount.get();
  if (p && account) keepPinCount(account, (p.pinnedStops ?? []).length);
});
const card = store({ text: t('Checking…'), loading: true });
const updated = store('');
const banner = store(null);
const day = store(null);
const removed = store(new Map());
const undo = store(null);
const searching = store(false);
const tab = store(null);
const nearby = store({ loading: true });
const nearbyUpdated = store('');
const busesModule = store(null);
const mapModule = store(null);
const settings = store({ status: 'idle', mod: null });
let shared = null;

const ADDED_MAX = 5;
const added = store(readAdded());
function readAdded() {
  try {
    const list = JSON.parse(localStorage.getItem(ADDED_PLACES_KEY) ?? '[]');
    return Array.isArray(list) ? list.filter((x) => typeof x?.to === 'string' && typeof x?.label === 'string').slice(0, ADDED_MAX) : [];
  } catch {
    return [];
  }
}
function keepAdded(list) {
  added.set(list);
  try {
    localStorage.setItem(ADDED_PLACES_KEY, JSON.stringify(list));
  } catch {}
}
const favouriteNamed = (label) => places.get().find((p) => p.label.toLowerCase() === label.toLowerCase());
function addPlace(to, label) {
  const list = added.get();
  if (list.some((x) => x.to === to) || favouriteNamed(label)) return;
  keepAdded([{ to, label }, ...list].slice(0, ADDED_MAX));
}
const focusChosen = () => focusSoon(() => document.querySelector('.app-chips button[aria-pressed="true"]'));

function removeAdded(x) {
  keepAdded(added.get().filter((y) => y.to !== x.to));
  const now = target.get();
  if (now.kind === 'stop' && now.to === x.to) choose({ kind: 'plan' });
  focusChosen();
}

async function get(path) {
  const res = await send(path, { credentials: 'same-origin', headers: { 'accept-language': window.i18n?.header ?? 'en' } });
  if (res.status === 401) await signedOut();
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
  const cached = res.headers.get('x-terminus-cached');
  return { data: await res.json(), cached: cached ? Number(cached) : null };
}

const onServerClock = (localMs) => localMs + serverNow() - Date.now();

function stale(cachedAt, failed = false) {
  if (cachedAt === null) {
    slowTries = 0;
    return void banner.set(null);
  }
  const at = clock(new Date(onServerClock(cachedAt)).toISOString());
  if (navigator.onLine) {
    banner.set(staleText(at, { online: true, failed }));
    clearTimeout(slowRetry);
    const wait = slowRetryMs(slowTries++);
    if (wait !== null) slowRetry = setTimeout(() => nowShown() && refresh({ timed: true }), wait);
  } else banner.set(staleText(at, { online: false }));
}
let slowRetry = null;
let slowTries = 0;

const nowShown = () => document.visibilityState === 'visible' && tab.get() === 'now';

let markTimer = null;
let markAt = -Infinity;
function atMarks(a) {
  clearTimeout(markTimer);
  const wait = markWaitMs(a, { now: Date.now(), serverNow: serverNow(), markAt });
  if (wait === null) return;
  markTimer = setTimeout(() => {
    if (!nowShown()) return;
    markAt = Date.now();
    refresh({ timed: true });
  }, wait);
}

function query(params = {}) {
  const q = new URLSearchParams(hour12() ? { h12: '1' } : {});
  for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined) q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : '';
}

let lastFix = null;

async function position({ ask = false } = {}) {
  if (!navigator.geolocation) return null;
  if (!ask) {
    const state = await navigator.permissions
      ?.query({ name: 'geolocation' })
      .then((p) => p.state)
      .catch(() => null);
    if (state !== 'granted') return null;
  }
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (p) => {
        lastFix = { lat: p.coords.latitude, lon: p.coords.longitude, accuracy: p.coords.accuracy, at: p.timestamp };
        resolve(lastFix);
      },
      () => resolve(null),
      { maximumAge: FIX_FRESH_MS, timeout: 8_000 },
    );
  });
}

async function here(opts) {
  const fix = await position(opts);
  return fix && fixQuery(fix, Date.now());
}

async function hereSoon() {
  const fresh = position();
  const grace = new Promise((resolve) => setTimeout(() => resolve(undefined), FIX_GRACE_MS));
  return { sent: fixToSend(await Promise.race([fresh, grace]), lastFix, Date.now()), fresh };
}

async function stopsFix() {
  const { sent } = await hereSoon();
  return sent && fixQuery(sent, Date.now());
}

let generation = 0;

let lastPlan = null;
let planAt = 0;

let pending = 0;

let fetchedAt = 0;

async function refresh({ timed = false, back = false } = {}) {
  if (timed && pending && !back) return;
  pending++;
  try {
    return await refreshNow(timed);
  } finally {
    pending--;
  }
}

async function refreshNow(timed) {
  const mine = ++generation;
  clearTimeout(markTimer);
  const to = target.get();
  try {
    const { sent, fresh } = await hereSoon();
    if (mine !== generation) return;
    const sentAt = Date.now();
    fresh.then((f) => mine === generation && refreshAgain(sent, f, sentAt) && refresh());
    const at = sent && fixQuery(sent, sentAt);
    const params = { ...(to.kind === 'place' ? { place: to.key } : to.kind === 'stop' ? { to: to.to } : {}), ...at };
    const askDay = !timed || !lastPlan || Date.now() - planAt >= DAY_MS;
    const [nextR, dayR] = await Promise.allSettled([
      get(`/api/me/next${query(params)}`),
      askDay ? get(`/api/me/day${query(at ?? {})}`) : Promise.resolve(lastPlan),
    ]);
    if (mine !== generation) return;
    if (nextR.status === 'rejected' && nextR.reason?.message === 'signed out') return;
    const next = nextR.status === 'fulfilled' ? nextR.value : null;
    if (next?.data?.walkSpeedMs) walkSpeed.set(next.data.walkSpeedMs);
    const plan = dayR.status === 'fulfilled' ? dayR.value : null;
    if (plan && askDay) {
      lastPlan = plan;
      planAt = Date.now();
      day.set(plan.data);
      removed.set((m) => new Map([...m].filter(([, at]) => at >= mine)));
    }
    const offline = !next || next.cached !== null;
    const fallback = offline && to.kind === 'plan' && (!next || isStale(next.data)) ? offlineNext(plan?.data, serverNow()) : null;
    if (fallback) {
      card.set({ offline: fallback });
      stale(plan.cached ?? planAt, !next);
      updated.set('');
      return;
    }
    if (!next) throw nextR.reason;
    card.set({ a: next.data });
    seen.set(seenKey(to), next.data);
    stale(next.cached);
    if (next.cached === null) {
      fetchedAt = Date.now();
      atMarks(next.data);
    }
    updated.set(t('Updated {0}', clock(new Date(next.cached === null ? serverNow() : onServerClock(next.cached)).toISOString())));
    if (JSON.stringify(next.data.places ?? []) !== JSON.stringify(places.get())) places.set(next.data.places ?? []);
  } catch (err) {
    if (err.message === 'signed out' || mine !== generation) return;
    banner.set(
      navigator.onLine
        ? t("Couldn't update. Trying again soon.")
        : t("You're offline and nothing has been saved yet. This will update when you're back online."),
    );
  }
}

const seen = new Map();
const seenKey = (to) => JSON.stringify(to);

async function keptCard(to) {
  if (!('caches' in window) || (to.kind !== 'plan' && to.kind !== 'place')) return null;
  const q = new URLSearchParams();
  if (to.kind === 'place') q.set('place', to.key);
  if (hour12()) q.set('h12', '1');
  q.set('lang', window.i18n?.header ?? 'en');
  try {
    const res = await caches.match(`${location.origin}/api/me/next?${q}`);
    return res ? await res.json() : null;
  } catch {
    return null;
  }
}

async function drawSeen() {
  const to = target.get();
  const known = seen.get(seenKey(to)) ?? (await keptCard(to));
  if (to !== target.get()) return;
  if (known && !isStale(known)) {
    card.set({ a: known });
    updated.set(t('Updating…'));
  } else {
    card.set({ text: t('Checking…'), loading: true });
    updated.set('');
  }
}

function choose(to) {
  target.set(to);
  drawSeen();
  refresh();
}

function goSomewhere(d) {
  searching.set(false);
  focusChosen();
  const label = d.kind === 'stop' || d.kind === 'landmark' ? d.label : d.code;
  const fav = favouriteNamed(label);
  if (fav) return choose({ kind: 'place', key: fav.key });
  addPlace(d.code, label);
  choose({ kind: 'stop', to: d.code, label });
}

function goToStop({ code, name, place }) {
  if (!place) addPlace(code, name);
  target.set(place ? { kind: 'place', key: place } : { kind: 'stop', to: code, label: name });
  drawSeen();
  if (location.hash === '#map') history.pushState(null, '', '#now');
  showTab();
}

const nearbyShown = () => document.visibilityState === 'visible' && tab.get() === 'nearby';

let nearbyAsked = 0;
let nearbyPending = 0;
let nearbyAt = 0;
const NEARBY_KEEP_MS = 120_000;

async function refreshNearby({ timed = false } = {}) {
  if (timed && nearbyPending) return;
  const mine = ++nearbyAsked;
  const none = (text) => {
    if (timed && nearby.get().stops && Date.now() - nearbyAt < NEARBY_KEEP_MS) return;
    nearby.set({ text });
    nearbyUpdated.set('');
    nearbyAt = 0;
  };
  nearbyPending++;
  try {
    const at = await here({ ask: true });
    if (mine !== nearbyAsked) return;
    if (!at) return none(t('Allow location for this site to see the buses near you.'));
    const { data } = await get(`/api/me/nearby${query(at)}`);
    if (mine !== nearbyAsked) return;
    if (!data.stops?.length) return none(t('No campus bus stops near you.'));
    nearbyAt = Date.now();
    nearby.set({ stops: data.stops });
    nearbyUpdated.set(t('Updated {0}', clock(new Date(serverNow()).toISOString())));
  } catch (err) {
    if (err.message !== 'signed out' && mine === nearbyAsked) none(t('Nearby needs a connection.'));
  } finally {
    nearbyPending--;
  }
}

async function pullNow() {
  if (Date.now() - fetchedAt < PULL_FRESH_MS) return 'fresh';
  const asked = Date.now();
  await refresh();
  return fetchedAt >= asked ? 'updated' : 'failed';
}

async function pullNearby() {
  if (Date.now() - nearbyAt < PULL_FRESH_MS) return 'fresh';
  const asked = Date.now();
  await refreshNearby();
  return nearbyAt >= asked ? 'updated' : 'failed';
}

function pullTab() {
  if (tab.get() === 'now') return pullNow();
  if (tab.get() === 'nearby') return pullNearby();
  return busesModule.get()?.pullRefresh?.() ?? Promise.resolve('failed');
}
const pullable = () => tab.get() === 'now' || tab.get() === 'nearby' || (tab.get() === 'buses' && Boolean(busesModule.get()?.pullRefresh));

function answered(a) {
  card.set({ a });
  refresh();
}

const UNDO_MS = 20_000;
let undoTimer = null;
function showUndo(value) {
  undo.set(value);
  holdUndo(false);
  announce(value.text, { again: true });
}
function holdUndo(held) {
  clearTimeout(undoTimer);
  if (!held && undo.get()) undoTimer = setTimeout(() => undo.set(null), UNDO_MS);
}
const focusUndo = (key) =>
  focusSoon(
    () =>
      document.querySelector(`.today-item.removed[data-key="${CSS.escape(key)}"] .undo-today`) ??
      document.querySelector(`.today-item.removed[data-key="${CSS.escape(key)}"]`),
  );

async function removeFromToday(it, at, before) {
  removed.set((m) => new Map(m).set(it.key, generation + 1));
  focusUndo(it.key);
  const name = it.kind === 'home' ? t('The trip home') : it.label.split(' @ ')[0];
  const putBack = async () => {
    undo.set(null);
    removed.set((m) => {
      const next = new Map(m);
      next.delete(it.key);
      return next;
    });
    focusSoon(() => document.querySelector(`.remove-today[data-key="${CSS.escape(it.key)}"]`) ?? document.getElementById('today-title'));
    try {
      card.set({ a: await signal({ kind: 'reset', trip: it.key }) });
    } catch {
      removed.set((m) => new Map(m).set(it.key, generation + 1));
      showUndo({ it, at, before, text: t("Couldn't put that back. Check your connection."), undo: putBack });
      focusUndo(it.key);
    } finally {
      refresh();
    }
  };
  showUndo({ it, at, before, text: t('{0} removed from today', name), undo: putBack });
  try {
    card.set({ a: await signal({ kind: 'skipped', trip: it.key }) });
  } catch {
    const lost = document.activeElement?.closest?.('.today-item.removed');
    showUndo({ it, at, before: it.key, text: t("Couldn't remove that. Check your connection.") });
    if (lost) focusUndo(it.key);
    removed.set((m) => {
      const next = new Map(m);
      next.delete(it.key);
      return next;
    });
  }
  refresh();
}

const views = {};
let switches = 0;
const scrolled = {};

function markTab(next) {
  document.title = t('{0} · terminus', TABBAR.find((x) => x.id === next).label());
  document.body.classList.toggle('on-map', next === 'map');
  document.body.classList.toggle('on-settings', next === 'settings');
  document.body.classList.toggle('on-buses', next === 'buses');
  document.body.classList.toggle('on-nearby', next === 'nearby');
}

let meAsked = null;
const askMe = () =>
  (meAsked ??= get('/api/me').then(
    (r) => r.data,
    (err) => {
      meAsked = null;
      throw err;
    },
  ));

const tabInAddress = () => tabOf(location.hash);

function fadeIn(node) {
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  node.style.transformOrigin = `50% ${window.innerHeight / 2 - node.getBoundingClientRect().top}px`;
  const frames = reduce
    ? [{ opacity: 0 }, { opacity: 1 }]
    : [
        { opacity: 0, transform: 'scale(0.92)' },
        { opacity: 1, transform: 'none' },
      ];
  node.animate(frames, { duration: reduce ? 150 : 210, easing: 'cubic-bezier(0, 0, 0.2, 1)' });
}
const fadeOut = (node) =>
  node.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 90, easing: 'cubic-bezier(0.4, 0, 1, 1)', fill: 'forwards' });

async function showTab() {
  const next = tabInAddress();
  const from = tab.get();
  if (next === from) return;
  const mine = ++switches;
  if (next === 'map') preloadMap();
  const animate = from !== null && document.visibilityState === 'visible';
  if (from !== null) scrolled[from] = window.scrollY;
  if (animate) {
    const out = fadeOut(views[from]);
    await out.finished.catch(() => {});
    if (mine !== switches) return out.cancel();
    for (const n of TABS) views[n].hidden = n !== next;
    out.cancel();
  }
  for (const n of TABS) views[n].hidden = n !== next;
  tab.set(next);
  markTab(next);
  window.scrollTo(0, scrolled[next] ?? 0);
  if (animate) fadeIn(views[next]);
  if (next === 'map') {
    loadTab(mapModule, '/app/map.js');
  } else if (next === 'buses') {
    loadTab(busesModule, '/app/buses.js');
  } else if (next === 'settings') {
    openSettings();
  } else if (next === 'nearby') {
    refreshNearby();
  } else if (from !== null) {
    refresh();
  }
}

const importFails = new Map();
const importing = new Set();

async function loadTab(mod, path) {
  if ((mod.get() && !mod.get().failed) || importing.has(path)) return;
  const fails = importFails.get(path) ?? 0;
  importing.add(path);
  mod.set(null);
  try {
    mod.set(await import(fails ? `${path}?retry=${fails}` : path));
  } catch {
    importFails.set(path, fails + 1);
    mod.set({ failed: true });
  } finally {
    importing.delete(path);
  }
}

async function openSettings() {
  const s = settings.get();
  if (s.status === 'ready') {
    reloadProfile().catch(() => {});
    lists.set((n) => n + 1);
    if (shared) s.mod.offerImport(shared);
    shared = null;
    return;
  }
  if (s.status === 'loading') return;
  settings.set({ status: 'loading', mod: null });
  try {
    if (!me.get()) me.set(await askMe());
    const [mod] = await Promise.all([import('/account/settings.js'), import('/account/settings-pages.js'), loadProfile(), loadCampus()]);
    settings.set({ status: 'ready', mod });
    if (shared) mod.offerImport(shared);
    shared = null;
  } catch (err) {
    settings.set({ status: err.message === 'signed out' ? 'idle' : 'failed', mod: null });
  }
}

function sharedLink() {
  const q = new URLSearchParams(location.search);
  const text = [q.get('url'), q.get('text'), q.get('title')].filter(Boolean).join(' ');
  return text.match(/https:\/\/nusmods\.com\/timetable\/\S+/)?.[0] ?? null;
}

const pushable = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const OFF = t("A reminder before it's time to leave, then updates on your bus as your trip goes on.");
const ON = t('On for this device. Notifications follow your trip, as on your other devices.');
const push = store({ on: false, text: OFF, button: true });

function b64urlBytes(s) {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

async function subscribe() {
  const reg = await navigator.serviceWorker.ready;
  const { key } = await api('/api/me/push/key');
  let sub = await reg.pushManager.getSubscription();
  const was = sub?.options?.applicationServerKey;
  if (
    sub &&
    was &&
    btoa(String.fromCharCode(...new Uint8Array(was)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '') !== key
  ) {
    await sub.unsubscribe();
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64urlBytes(key) });
  await api('/api/me/push', { method: 'POST', body: { subscription: sub.toJSON() } });
  refresh();
}

async function unsubscribe() {
  const reg = await navigator.serviceWorker.ready;
  await (await reg.pushManager.getSubscription())?.unsubscribe();
  await api('/api/me/push', { method: 'DELETE' }).catch(() => {});
}

async function setupPush() {
  if (!pushable || (iPhone && !standalone)) return;
  const perm = Notification.permission;
  if (perm === 'denied')
    return push.set({
      on: false,
      text: t('Notifications are blocked for this site. Allow them in your browser settings to turn this on.'),
      button: false,
    });
  let on = false;
  if (perm === 'granted') {
    try {
      const reg = await navigator.serviceWorker.ready;
      if (await reg.pushManager.getSubscription()) {
        await subscribe();
        on = true;
      }
    } catch {
      on = false;
    }
  }
  push.set({ on, text: on ? ON : OFF, button: true });
}

async function togglePush() {
  try {
    if (push.get().on) {
      await unsubscribe();
      push.set({ on: false, text: OFF, button: true });
    } else if ((await Notification.requestPermission()) === 'granted') {
      await subscribe();
      push.set({ on: true, text: ON, button: true });
    } else {
      push.set({
        on: false,
        text: t('Notifications are blocked. To turn them on, allow notifications for this site in your browser settings.'),
        button: true,
      });
    }
  } catch (err) {
    push.set({
      on: false,
      text: err.status
        ? t("Couldn't turn on notifications. {0}", err.message)
        : t("Couldn't turn on notifications. Try again in a minute."),
      button: true,
    });
  }
}

const SEARCH = '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.4-4.4"/>';
const CLOSE = '<path d="M6 6l12 12M18 6 6 18"/>';

function Notify() {
  const s = useStore(push);
  const [busy, setBusy] = useState(false);
  return html`
    <div class="trips">
      <section class="trips-group">
        <h3 class="eyebrow">${t('Before class')}</h3>
        <div class="card settings-list">
          <div class="field">
            <label for="notify-on">${t('Notify me when to leave')}<span class="field-sub">${s.text}</span></label>
            ${
              s.button &&
              html`<div class="field-control">
              <input
                id="notify-on"
                class="switch"
                type="checkbox"
                role="switch"
                checked=${s.on}
                disabled=${busy}
                onChange=${async () => {
                  setBusy(true);
                  await togglePush();
                  setBusy(false);
                }}
              />
            </div>`
            }
          </div>
        </div>
      </section>
    </div>
  `;
}

function InstallHint() {
  const shown = useRef(null);
  const hidden = useStore(installDismissed);
  if (shown.current === null) {
    let dismissed = false;
    try {
      dismissed = localStorage.getItem('install-dismissed') === '1';
    } catch {}
    const safari = /Safari/.test(navigator.userAgent) && !/CriOS|FxiOS|EdgiOS/.test(navigator.userAgent);
    shown.current = iPhone && safari && !standalone && !dismissed;
  }
  if (!shown.current || hidden) return null;
  const share = '<path d="M12 3v12"/><path d="m7 8 5-5 5 5"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/>';
  return html`
    <section class="card install">
      <h2>${t('Add terminus to your Home Screen')}</h2>
      <ol class="install-steps">
        <li>
          <${Fill}
            text=${t('Tap {0} at the bottom of Safari.', MARK)}
            parts=${[
              html`<span class="ios-share" role="img" aria-label=${t('the Share button')}><${Icon} paths=${share} size="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" /></span>`,
            ]}
          />
        </li>
        <li><${Rich} text=${t('Choose <strong>Add to Home Screen</strong>.')} /></li>
        <li>${t('Open terminus from your Home Screen and sign in there once.')}</li>
      </ol>
      <p class="hint">${t('From the Home Screen it opens like an app, keeps working offline, and can tell you when to leave.')}</p>
      <button
        type="button"
        class="btn small ghost"
        onClick=${() => {
          installDismissed.set(true);
          try {
            localStorage.setItem('install-dismissed', '1');
          } catch {}
        }}
      >${t('Not now')}</button>
    </section>
  `;
}
const installDismissed = store(false);

function Chips() {
  const short = useShort();
  const to = useStore(target);
  const list = useStore(places);
  const extra = useStore(added);
  const open = useStore(searching);
  const same = (a, b) => a.kind === b.kind && (a.kind !== 'place' || a.key === b.key) && (a.kind !== 'stop' || a.to === b.to);
  const chip = (label, value) => html`
    <button type="button" aria-pressed=${String(same(value, to))} onClick=${() => choose(value)}>${label}</button>
  `;
  return html`
    <div class="app-chips" role="group" aria-label=${t('Where to')}>
      ${short && html`<a class="brand" href="/app/"><img src="/assets/mark.svg" alt="" /><span class="wordmark">termi<b>nus</b></span></a>`}
      ${chip(t('Next'), { kind: 'plan' })}
      ${list.map((p) => chip(p.label, { kind: 'place', key: p.key }))}
      ${extra.map(
        (x) => html`<span class="chip-added" key=${x.to}>
          ${chip(x.label, { kind: 'stop', to: x.to, label: x.label })}
          <button type="button" class="chip-x" aria-label=${t('Remove {0}', x.label)} onClick=${() => removeAdded(x)}>
            <${Icon} paths=${CLOSE} />
          </button>
        </span>`,
      )}
      ${to.kind === 'stop' && !extra.some((x) => x.to === to.to) && chip(to.label, to)}
      <button type="button" class="chip-search" aria-expanded=${String(open)} onClick=${() => searching.set(!open)}>
        <${Icon} paths=${SEARCH} />${t('Elsewhere')}
      </button>
    </div>
  `;
}

function Where() {
  const open = useStore(searching);
  const c = useStore(campus);
  const box = useRef(null);
  useEffect(() => {
    if (!open) return;
    box.current?.focus();
    loadCampus().catch(() => {});
  }, [open]);
  if (!open) return null;
  const destinations = c?.destinations ?? [];
  return html`
    <div class="where-box">
      <${SearchBox}
        type="search"
        placeholder=${t('Stop, building or room')}
        aria-label=${t('Go somewhere else')}
        enterkeyhint="go"
        ctl=${box}
        source=${() => destinations}
        stopName=${(code) => destinations.find((d) => d.kind === 'stop' && d.code === code)?.label ?? code}
        onPick=${goSomewhere}
        onKeyDown=${(e) => {
          if (e.key !== 'Escape') return;
          searching.set(false);
          document.querySelector('.chip-search')?.focus();
        }}
      />
    </div>
  `;
}

const itemTitle = (it) =>
  it.title ?? (it.kind === 'home' ? (it.fromName ? t('Home, from {0}', it.fromName) : t('Home after your last class')) : it.label);

function OfflineCard({ item, step }) {
  if (step === 'home') {
    return html`
      <div class="widget offline-plan">
        <div class="where">${clock(item.startsAt)}</div>
        <h2 class="big">${itemTitle(item)}</h2>
        <${Say} text=${`${clock(item.startsAt)} ${itemTitle(item)}`} />
      </div>
    `;
  }
  const l = item.leave;
  const how = l ? (l.svc ? t('{0} from {1}', l.svc, l.stop ?? item.fromName) : t('walk')) : null;
  const line = step === 'leaveBy' && item.line ? item.line : null;
  const where = `${itemTitle(item)} · ${t('starts {0}', clock(item.startsAt))}`;
  const big = line ?? (step === 'leaveBy' ? t('Leave by {0}', t('~{0}', clock(l.at))) : t('Leave now'));
  return html`
    <div class="widget offline-plan">
      <div class="where">${where}</div>
      <h2 class="big">${big}</h2>
      ${!line && how && html`<div class="detail">${how.charAt(0).toUpperCase() + how.slice(1)}</div>`}
      <${Say} text=${`${where}. ${big}`} />
    </div>
  `;
}

const STOP_SIGN = '<rect x="6" y="2.5" width="12" height="9.5" rx="2.5"/><path d="M12 12v9.5M9 21.5h6M9.5 7.25h5"/>';

function NearbyFoot({ stops }) {
  return anyGuess(stops) && html`<div class="nb-foot"><p>${t('~ is a guess from the timetable, not a live time.')}</p></div>`;
}

function NearbySigns({ stops }) {
  const p = useStore(profile);
  useEffect(() => {
    if (!profile.get()) loadProfile().catch(() => {});
  }, []);
  const names = stops.map((s) => s.stop.name).join(', ');
  return html`
    <div class="nearby">
      <${Say} text=${t('Buses near you: {0}', names)} />
      ${stops.map(
        (s) => html`<${StopSign}
          key=${s.stop.code}
          s=${s}
          pinned=${p ? (p.pinnedStops ?? []) : null}
          onStop=${(code) => (location.hash = `#buses/stop/${encodeURIComponent(code)}`)}
          onLine=${(svc, code) => (location.hash = `#buses/line/${encodeURIComponent(svc)}/${encodeURIComponent(code)}`)}
        />`,
      )}
      <${NearbyFoot} stops=${stops} />
    </div>
  `;
}

function NearbyArea() {
  const n = useStore(nearby);
  const when = useStore(nearbyUpdated);
  let body;
  if (n.stops) body = html`<${NearbySigns} stops=${n.stops} />`;
  else if (n.loading) body = html`<${Skeleton} said=${t('Checking…')} inner="nearby"><${SignSkeleton} /><${SignSkeleton} /><//>`;
  else body = html`<p class="hint nb-none" role="status">${n.text}</p>`;
  return html`
    <${Band}><h2 class="tab-title">${t('Nearby')}</h2><//>
    <div class="nb-tab">${body}${when && html`<p class="hint nb-updated">${when}</p>`}</div>
  `;
}

const SkPoint = ({ dot, line = null, what, below = null }) => html`
  <li class=${['pt', dot, line].filter(Boolean).join(' ')}>
    <span class="time"><${Bar} w="3.2rem" /></span>
    <span class="rail"></span>
    <span class="what"><strong><${Bar} w=${what} /></strong>${below && html`<small><${Bar} w=${below} /></small>`}</span>
  </li>
`;

function CardSkeleton() {
  return html`
    <${Skeleton} said=${t('Checking…')} quiet cls="widget">
      <div class="journey steps sk-card">
        <div class="sky-head">
          <${Celestial} />
          <div class="where"><${Bar} w="62%" /></div>
          <h2 class="lead"><${Bar} w="78%" h="0.8em" /></h2>
          <div class="steps-under"><span class="under"><${Bar} w="10rem" /></span><span class="sk round sk-tag"></span></div>
        </div>
        <${Horizon} />
        <div class="road-line"><span class="bus-badge sk">R2</span><${Bar} w="52%" /></div>
        <ol class="line">
          <${SkPoint} dot="start" line="walk" what="5rem" below="6rem" />
          <${SkPoint} dot="stop" line="ride" what="7rem" below="5.5rem" />
          <${SkPoint} dot="end" what="5.5rem" />
        </ol>
        <p class="backup-line"><${Bar} w="64%" /></p>
      </div>
    <//>
  `;
}

function CardArea() {
  const c = useStore(card);
  const bar = useStore(undo);
  const a =
    c.a?.card && bar?.undo
      ? { ...c.a, card: { ...c.a.card, actions: c.a.card.actions.filter((x) => !(x.id === 'reset' && x.trip === bar.it.key)) } }
      : c.a;
  useNowSky(useSkyPhase());
  const body = a
    ? html`<${Card} a=${a} sky onAnswer=${answered} onChoice=${refresh} onPlace=${(key) => choose({ kind: 'place', key })} />`
    : c.offline
      ? html`<${InSky} sky><${OfflineCard} ...${c.offline} /><//>`
      : c.loading
        ? html`<${CardSkeleton} />`
        : html`<${InSky} sky><${Message} text=${c.text} /><//>`;
  return html`
    <section class=${c.loading ? 'card app-card loading' : 'card app-card'}>
      ${body}
      <${CardFoot} />
    </section>
  `;
}

function CardFoot() {
  const c = useStore(card);
  const to = useStore(target);
  const when = useStore(updated);
  const who = useStore(me);
  return html`
    <div class="card-foot">
      <div class="updated hint">${when}</div>
      <${Report} key=${JSON.stringify(to)} answer=${c.a ?? null} anonymous=${who?.anonymous === true} email=${who?.email ?? null} />
    </div>
  `;
}

const LAST_MARK = 23 * 60 + 55;
function soonOnCampus() {
  const sgt = new Date(serverNow() + 8 * 3600_000);
  const min = Math.ceil((sgt.getUTCHours() * 60 + sgt.getUTCMinutes() + 30) / 5) * 5;
  return min <= LAST_MARK ? min : null;
}
const hhmmOf = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
function campusDay(days) {
  const d = new Date(serverNow() + 8 * 3600_000 + days * 86_400_000);
  return { date: d.toISOString().slice(0, 10), weekday: d.getUTCDay() };
}
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => t(d));
const WEEKDAYS_LONG = () => [t('Sunday'), t('Monday'), t('Tuesday'), t('Wednesday'), t('Thursday'), t('Friday'), t('Saturday')];
const ALERT = '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.5v.01"/>';

function GoLater() {
  const to = useStore(target);
  const list = useStore(places);
  const [open, setOpen] = useState(false);
  const [day, setDay] = useState(0);
  const [at, setAt] = useState(0);
  const [msg, setMsg] = useState('');
  const [tries, setTries] = useState(0);
  const [sending, setSending] = useState(false);
  useEffect(() => {
    setOpen(false);
    setMsg('');
  }, [JSON.stringify(to)]);
  if (to.kind !== 'place' && to.kind !== 'stop') return null;
  if (!open) {
    return html`<button
      type="button"
      id="go-later"
      class="btn small ghost go-later"
      onClick=${() => {
        const soon = soonOnCampus();
        setDay(soon === null ? 1 : 0);
        setAt(soon ?? 9 * 60);
        setMsg('');
        setOpen(true);
      }}
    >${t('Go later at…')}</button>`;
  }
  const label = to.kind === 'place' ? (list.find((p) => p.key === to.key)?.label ?? '') : to.label;
  const days = [0, 1, 2].map((i) => ({ i, ...campusDay(i) }));
  const dayLabel = (d) => (d.i === 0 ? t('Today') : d.i === 1 ? t('Tomorrow') : WEEKDAYS[d.weekday]);
  const pick = (min) => {
    setMsg('');
    setAt(Math.min(LAST_MARK, Math.max(0, min)));
  };
  const earlier = () => pick(Math.ceil(at / 5) * 5 - 5);
  const later = () => pick(Math.floor(at / 5) * 5 + 5);
  const typed = (e) => {
    const [h, m] = e.currentTarget.value.split(':').map(Number);
    if (Number.isInteger(h) && Number.isInteger(m)) pick(h * 60 + m);
  };
  const showPicker = (e) => {
    try {
      e.currentTarget.showPicker?.();
    } catch {}
  };
  const submit = async (e) => {
    e.preventDefault();
    const { date } = days[day];
    const where = to.kind === 'place' ? { place: to.key } : { to: to.to, label: to.label };
    setSending(true);
    try {
      const from = await here();
      const a = await api(`/api/me/once${query(from ?? {})}`, { method: 'POST', body: { ...where, atMin: at, date } });
      target.set({ kind: 'plan' });
      card.set({ a });
      refresh();
      focusChosen();
      const time = clock(`${date}T${hhmmOf(at)}:00+08:00`);
      if (day === 1) toast(t('Planned for tomorrow at {0}', time));
      else if (day > 1) toast(t('Planned for {0} at {1}', WEEKDAYS_LONG()[days[day].weekday], time));
    } catch (err) {
      setMsg((err.status && err.message) || t("Couldn't add it. Check your connection."));
      setTries((n) => n + 1);
    } finally {
      setSending(false);
    }
  };
  return html`
    <form class="trips-group go-later-form" onSubmit=${submit}>
      <h3 class="eyebrow">${label ? t('Go later to {0}', label) : t('Go later at…')}</h3>
      <div class="card settings-list">
        <div class="settings-row inline">
          <span class="row-text"><span class="row-title" id="go-later-day">${t('Day')}</span></span>
          <div class="segmented" role="radiogroup" aria-labelledby="go-later-day">
            ${days.map(
              (d) => html`<label key=${d.i}>
                <input
                  type="radio"
                  name="go-later-day"
                  checked=${day === d.i}
                  onChange=${() => {
                    setMsg('');
                    setDay(d.i);
                  }}
                />
                <span>${dayLabel(d)}</span>
              </label>`,
            )}
          </div>
        </div>
        <div class="settings-row inline">
          <span class="row-text"><label class="row-title" for="go-later-at">${t('Be there by')}</label></span>
          <span class="stepper" role="group" aria-label=${t('Be there by')}>
            <button type="button" aria-label=${t('5 min earlier')} disabled=${at <= 0} onClick=${earlier}>−</button>
            <input id="go-later-at" class="stepper-time" type="time" step="300" required value=${hhmmOf(at)} onClick=${showPicker} onInput=${typed} />
            <button type="button" aria-label=${t('5 min later')} disabled=${at >= LAST_MARK} onClick=${later}>+</button>
          </span>
        </div>
      </div>
      ${msg && html`<p class="go-later-error" role="alert" key=${tries}><${Icon} paths=${ALERT} /><span>${msg}</span></p>`}
      <div class="sheet-actions">
        <button
          type="button"
          class="btn small ghost"
          onClick=${() => {
            setOpen(false);
            focusSoon(() => document.getElementById('go-later'));
          }}
        >${t('Cancel')}</button>
        <button type="submit" class="btn small accent" disabled=${sending}>${t('Plan it')}</button>
      </div>
    </form>
  `;
}

function todayRows(plan, gone, bar) {
  const items = (plan?.items ?? []).filter((it) => !gone.has(it.key));
  const rows = items.map((it) => ({ it }));
  if (bar?.it) {
    const next = bar.before === null ? rows.length : rows.findIndex((r) => r.it.key === bar.before);
    rows.splice(next >= 0 ? next : Math.min(bar.at, rows.length), 0, { note: bar });
  }
  return { items, rows };
}

function Today() {
  const plan = useStore(day);
  const gone = useStore(removed);
  const bar = useStore(undo);
  const { items, rows } = todayRows(plan, gone, bar);
  if (!rows.length) return null;
  return html`
    <section class="today" aria-labelledby="today-title">
      <h2 class="label" id="today-title" tabindex="-1">${t('Today')}</h2>
      <ol class="today-list">
        ${rows.map(({ it, note }) => {
          if (note) {
            return html`
              <li
                class="today-item removed"
                key=${`removed:${note.it.key}`}
                data-key=${note.it.key}
                tabindex="-1"
                onMouseEnter=${() => holdUndo(true)}
                onMouseLeave=${() => holdUndo(false)}
                onFocusIn=${() => holdUndo(true)}
                onFocusOut=${() => holdUndo(false)}
              >
                <span class="at">${clock(note.it.startsAt)}</span>
                <span class="what"><span class="title">${note.text}</span></span>
                ${note.undo && html`<button type="button" class="linkish undo-today" onClick=${note.undo}>${t('Undo')}</button>`}
              </li>
            `;
          }
          const title = itemTitle(it);
          let sub = null;
          if (it.line !== undefined) sub = it.line;
          else if (it.status === 'skipped') sub = t('Not going');
          else if (it.onBus)
            sub = [
              t('On the {0}', it.onBus.svc),
              it.onBus.off ? t('off at {0}', it.onBus.off) : null,
              it.onBus.arrive ? t('arrive {0}', clock(it.onBus.arrive)) : null,
            ]
              .filter(Boolean)
              .join(' · ');
          else if (it.status !== 'done' && it.leave?.at) {
            const how = it.leave.svc ? t('{0} from {1}', it.leave.svc, it.leave.stop ?? it.fromName) : t('walk');
            sub = [
              t('Leave by {0}', it.leave.estimated ? t('~{0}', clock(it.leave.at)) : clock(it.leave.at)),
              how,
              it.timing?.status === 'late' ? it.timing.text : null,
            ]
              .filter(Boolean)
              .join(' · ');
          }
          return html`
            <li class=${`today-item ${it.status}`} key=${it.key}>
              <span class="at">${clock(it.startsAt)}</span>
              <span class="what"><span class="title">${title}</span>${sub && html`<span class="sub">${sub}</span>`}</span>
              ${it.removable && html`<button type="button" class="remove-today" data-key=${it.key} aria-label=${t('Remove {0} from today', title)} onClick=${() => removeFromToday(it, items.indexOf(it), items[items.indexOf(it) + 1]?.key ?? null)}>×</button>`}
            </li>
          `;
        })}
      </ol>
    </section>
  `;
}

function Banner() {
  const text = useStore(banner);
  useEffect(() => {
    document.body.classList.toggle('is-offline', text !== null);
  }, [text]);
  return html`<div class="banner-slot" role="status">${text !== null && html`<p class="offline">${text}</p>`}</div>`;
}

const StopsSkeleton = () => html`
  <${Skeleton} said=${t('Loading…')}>
    <${Band}><h2 class="tab-title">${t('Stops')}</h2><//>
    <div class="bt-find"><div class="bt-search"><span class="sk sk-field"></span></div></div>
    <div class="bt-home">
    <h3 class="bt-section eyebrow">${t('Pinned')}</h3>
    <${PinnedSkeleton} />
    <div class="bt-section"><h3 class="eyebrow">${t('Services')}</h3><span>${t('Tap one to see its whole line.')}</span></div>
    <${ServicesSkeleton} />
    </div>
  <//>
`;

function BusesArea() {
  const mod = useStore(busesModule);
  const now = useStore(tab);
  if (mod?.failed) return html`<p class="hint">${t('Stops need a connection.')}</p>`;
  if (!mod) return html`<${StopsSkeleton} />`;
  return html`<${mod.BusesTab} visible=${now === 'buses'} locate=${stopsFix} />`;
}

function MapArea() {
  const mod = useStore(mapModule);
  const now = useStore(tab);
  if (mod?.failed) return html`<p class="hint">${t('The map needs a connection the first time.')}</p>`;
  if (!mod) return null;
  return html`<${mod.MapTab} visible=${now === 'map'} onGoTo=${goToStop} onSaved=${refresh} />`;
}

const SkeletonRows = ({ n }) => html`
  <div class="set-group">
    ${Array.from({ length: n }, (_, i) => html`<div class="settings-row set-item" key=${i}><span class="set-ico skel"></span><span class="row-text"><span class="row-title skel-line"></span><span class="row-sum skel-line short"></span></span></div>`)}
  </div>
`;

function SettingsSkeleton() {
  const wide = useMedia('(min-width: 800px)');
  useEffect(() => {
    document.body.classList.add('set-sky');
    return () => document.body.classList.remove('set-sky');
  }, []);
  return html`
    <div class="settings skeleton" aria-busy="true">
      <div class="settings-side">
        <${Band}><h1 class="settings-title">${t('Settings')}</h1><//>
        <div class="settings-groups" aria-hidden="true">
          <div class="settings-row set-account"><span class="avatar skel"></span><span class="row-text"><span class="row-title skel-line"></span><span class="row-sum skel-line short"></span></span></div>
          <${SkeletonRows} n=${4} />
          <${SkeletonRows} n=${3} />
          <${SkeletonRows} n=${1} />
        </div>
      </div>
      ${
        wide &&
        html`<div class="settings-pages" aria-hidden="true">
        <div class="settings-page">
          <${Band}><div class="page-head"><h2 class="skel-line title"></h2></div><//>
          <div class="skel-block" style="height: 132px"></div>
          <div class="skel-block" style="height: 180px"></div>
        </div>
      </div>`
      }
      <p class="sr-only" role="status">${t('Loading…')}</p>
    </div>
  `;
}

function SettingsArea() {
  const s = useStore(settings);
  const who = useStore(me);
  const notify = useStore(push);
  if (s.status === 'failed') return html`<p class="hint">${t('Settings need a connection.')}</p>`;
  if (s.status !== 'ready') return html`<${SettingsSkeleton} />`;
  const Settings = s.mod.Settings;
  const canNotify = pushable && !(iPhone && !standalone);
  return html`<${Settings} me=${who} inApp sky Notify=${canNotify ? Notify : null} notifyOn=${notify.on} />`;
}

const TABBAR = [
  { id: 'now', href: '#now', label: () => t('Now'), icon: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>' },
  { id: 'nearby', href: '#nearby', label: () => t('Nearby'), icon: '<path d="M20.5 3.5 3.5 10.6l6.9 3 3 6.9 7.1-17Z"/>' },
  {
    id: 'buses',
    href: '#buses',
    label: () => t('Stops'),
    icon: STOP_SIGN,
  },
  {
    id: 'map',
    href: '#map',
    label: () => t('Map'),
    icon: '<path d="M9 4 3.5 6v14L9 18l6 2 5.5-2V4L15 6 9 4Z"/><path d="M9 4v14M15 6v14"/>',
  },
  {
    id: 'settings',
    href: '#settings',
    label: () => t('Settings'),
    icon: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>',
  },
];

function mapAgain(e) {
  if (tab.get() !== 'map' || location.hash !== '#map') return;
  e.preventDefault();
  mapModule.get()?.home();
}

function TabBar() {
  const now = useStore(tab) ?? tabInAddress();
  return html`
    <nav class="tabbar" aria-label=${t('Tabs')}>
      ${TABBAR.map(
        (x) => html`
          <a
            href=${x.href}
            data-tab=${x.id}
            key=${x.id}
            aria-current=${now === x.id ? 'page' : undefined}
            onPointerDown=${x.id === 'map' ? preloadMap : undefined}
            onPointerEnter=${x.id === 'map' ? preloadMap : undefined}
            onClick=${x.id === 'map' ? mapAgain : undefined}
          >
            <${Icon} paths=${x.icon} />
            <span>${x.label()}</span>
          </a>
        `,
      )}
    </nav>
  `;
}

function useNowSplit() {
  const wide = useMedia('(min-width: 800px)');
  const plan = useStore(day);
  const gone = useStore(removed);
  const bar = useStore(undo);
  const split = wide && todayRows(plan, gone, bar).rows.length > 0;
  useEffect(() => {
    document.body.classList.toggle('now-split', split);
  }, [split]);
  return split;
}

function NowSide() {
  const box = useRef(null);
  useEffect(() => {
    const el = box.current;
    const tab = el?.closest('main');
    const foot = tab?.querySelector('.app-card > .card-foot');
    if (!el || !tab) return;
    const seen = new ResizeObserver(() => {
      tab.style.setProperty('--side-h', `${el.offsetHeight}px`);
      tab.style.setProperty('--foot-h', `${foot?.offsetHeight ?? 0}px`);
    });
    seen.observe(el);
    if (foot) seen.observe(foot);
    return () => {
      seen.disconnect();
      tab.style.removeProperty('--side-h');
      tab.style.removeProperty('--foot-h');
    };
  }, []);
  return html`<div class="now-side" ref=${box}><${Today} /></div>`;
}

function Rail() {
  return useMedia('(min-width: 800px)') ? html`<${TabBar} />` : null;
}

function railRoot() {
  const found = document.getElementById('rail');
  if (found) return found;
  const made = document.createElement('div');
  made.id = 'rail';
  document.body.insertBefore(made, document.body.querySelector(':scope > header') ?? document.body.firstChild);
  return made;
}

function App() {
  const first = useRef(tabInAddress()).current;
  const keep = (name) => (node) => node && (views[name] = node);
  const split = useNowSplit();
  const rail = useMedia('(min-width: 800px)');
  const short = useShort();
  const notices = html`<${InstallHint} /><${Banner} />`;
  return html`
    <main class=${split ? 'wrap app-main split' : 'wrap app-main'} id="tab-now" hidden=${first !== 'now'} ref=${keep('now')}>
      <h1 class="sr-only">${t('Now')}</h1>
      ${!short && notices}
      <${Chips} />
      <${Where} />
      <${CardArea} />
      <${GoLater} />
      ${short && html`<div class="short-notices">${notices}</div>`}
      ${split ? html`<${NowSide} />` : html`<${Today} />`}
    </main>
    <main id="tab-nearby" class="wrap nearby-tab" hidden=${first !== 'nearby'} ref=${keep('nearby')}><h1 class="sr-only">${t('Nearby')}</h1><${NearbyArea} /></main>
    <main id="tab-buses" class="wrap buses-tab" hidden=${first !== 'buses'} ref=${keep('buses')}><h1 class="sr-only">${t('Stops')}</h1><${BusesArea} /></main>
    <main id="tab-map" class="map-tab" hidden=${first !== 'map'} ref=${keep('map')}><h1 class="sr-only">${t('Map')}</h1><${MapArea} /></main>
    <main id="tab-settings" class="wrap settings-tab" hidden=${first !== 'settings'} ref=${keep('settings')}><${SettingsArea} /></main>
    <${PullToRefresh} enabled=${pullable} refresh=${pullTab} />
    ${!rail && html`<${TabBar} />`}
    <${Toast} />
  `;
}

async function start() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  navigator.serviceWorker?.addEventListener('message', (e) => {
    if (e.data?.kind === 'refresh') refresh();
  });
  campusRefused.subscribe((refused) => refused && signedOut().catch(() => {}));
  const opening = tabInAddress();
  markTab(opening);
  render(html`<${App} />`, document.getElementById('root'));
  render(html`<${Rail} />`, railRoot());
  if (opening === 'settings') openSettings();
  await drawSeen();
  const first = refresh();
  try {
    me.set(await askMe());
  } catch (err) {
    if (err.message === 'signed out') return;
  }
  shared = sharedLink();
  if (shared) history.replaceState(null, '', '/app/#settings');
  setupPush();
  window.addEventListener('hashchange', showTab);
  showTab();
  await first;
  setInterval(() => nowShown() && refresh({ timed: true }), REFRESH_MS);
  document.addEventListener('visibilitychange', () => nowShown() && refresh({ timed: true, back: true }));
  setInterval(() => nearbyShown() && refreshNearby({ timed: true }), REFRESH_MS);
  document.addEventListener('visibilitychange', () => nearbyShown() && refreshNearby());
  window.addEventListener('online', () => {
    if (nowShown()) refresh();
    if (nearbyShown()) refreshNearby();
    if (tab.get() === 'map' && mapModule.get()?.failed) loadTab(mapModule, '/app/map.js');
    if (tab.get() === 'buses' && busesModule.get()?.failed) loadTab(busesModule, '/app/buses.js');
  });
}

start();
