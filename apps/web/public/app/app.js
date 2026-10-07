// The installed web app (phase 5): the answer card and today, the way the
// phone app shows them, the campus map (app/map.js) and Settings (the
// account page's, account/settings.js). A bar along the bottom switches
// between them, fading through as the phone app does.
//
// What's on screen lives in stores at the top (what the card is for, the
// card, today, …); the functions under them fetch and set them, and the
// components at the bottom draw them.
//
// The service worker (/sw.js) answers /me/next and /me/day from its cache
// when the network is down; those replies carry x-terminus-cached with when
// they were fetched, so the page can say it's showing old times.

import { Icon, Rich, html, render, store, useEffect, useRef, useState, useStore } from '/assets/ui.js';
import { api, clock, hour12, inkOn, send, t } from '/account/dom.js';
import { Card, InSky, Message, Report, isStale, signal } from '/account/preview.js';
import { Celestial, Horizon, useNowSky, useSkyPhase } from '/account/sky.js';
import { Toast, campus, lists, loadCampus, loadProfile, profile, reloadProfile, toast, walkSpeed } from '/account/profile.js';
import { SearchBox } from '/account/search-box.js';
import { offlineNext } from '/app/offline.js';

/** The answer refreshes this often while the app is on screen (the API caches 15 s). */
const REFRESH_MS = 30_000;

const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
// iPadOS says it's a Mac; one with a touch screen is an iPad.
const iPhone = !/Android/.test(navigator.userAgent) && (/iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));

/* ---------- what's on screen ---------- */

/** What the card is for: the plan, a saved place (its key), a stop picked on the map or in the search, or the buses nearby. */
const target = store({ kind: 'plan' });
/** The saved places, for their chips: from the last answer, and from the profile as Settings or the map change it. */
const places = store([]);
profile.subscribe((p) => p && places.set(p.places.map(({ key, label }) => ({ key, label }))));
/**
 * The card: an answer (`a`), "Checking…" or another line (`text`), the
 * offline plan (`offline`), or Nearby's stops (`nearby`).
 */
const card = store({ text: t('Checking…'), loading: true });
/** "Updated 9:41", or "Updating…" while a card already seen is shown again. */
const updated = store('');
/** The banner above the chips when the card isn't live (offline, or no answer), else null. */
const banner = store(null);
/** Today, from /me/day. */
const day = store(null);
/** Taken off today here, by key, with the refresh that started after it: hidden until one comes back. */
const removed = store(new Map());
/**
 * The row left where an entry was taken off Today: the entry (`it`), the one
 * after it (`before`, its key, null at the end) and where it was (`at`, should
 * that one go too), its words, and Undo if there's one. In the list, so nothing moves.
 */
const undo = store(null);
/** The search under the chips is open. */
const searching = store(false);
/** /me, once fetched: who's signed in. */
const me = store(null);
/** Now, Map or Settings; null until the first draw. */
const tab = store(null);
/** app/map.js, once the map has been opened. */
const mapModule = store(null);
/** A stop to open on the map once it's on screen (a stop tapped in Nearby). */
const stopToShow = store(null);
/** Settings: account/settings.js once loaded, or why not. */
const settings = store({ status: 'idle', mod: null });
/** A NUSMods link shared to the app, for Settings to offer to import. */
let shared = null;

/**
 * Somewhere searched for or picked on the map keeps a tab of its own, with
 * an X, as on the phone: up to 5, newest first, kept in this browser only.
 * One that's a favourite is that favourite's tab instead.
 */
const ADDED_MAX = 5;
const added = store(readAdded());
function readAdded() {
  try {
    const list = JSON.parse(localStorage.getItem('added-places') ?? '[]');
    return Array.isArray(list) ? list.filter((x) => typeof x?.to === 'string' && typeof x?.label === 'string').slice(0, ADDED_MAX) : [];
  } catch {
    return [];
  }
}
function keepAdded(list) {
  added.set(list);
  try {
    localStorage.setItem('added-places', JSON.stringify(list));
  } catch {
    // Storage blocked: the tabs last until the page closes.
  }
}
const favouriteNamed = (label) => places.get().find((p) => p.label.toLowerCase() === label.toLowerCase());
function addPlace(to, label) {
  const list = added.get();
  if (list.some((x) => x.to === to) || favouriteNamed(label)) return;
  keepAdded([{ to, label }, ...list].slice(0, ADDED_MAX));
}
/** The X on an added place's tab: gone, and back to Next if it was showing. */
function removeAdded(x) {
  keepAdded(added.get().filter((y) => y.to !== x.to));
  const now = target.get();
  if (now.kind === 'stop' && now.to === x.to) choose({ kind: 'plan' });
}

/* ---------- fetching ---------- */

/** GET a JSON route; `cached` is when the service worker's copy was fetched, if that's what came back. */
async function get(path) {
  const res = await send(path, { credentials: 'same-origin', headers: { 'accept-language': window.i18n?.header ?? 'en' } });
  if (res.status === 401) {
    // Sign in on the account page, then come back here. In the installed app
    // on iOS this is its own sign-in: its storage is separate from Safari's.
    location.replace('/account/?next=/app/');
    throw new Error('signed out');
  }
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
  const cached = res.headers.get('x-terminus-cached');
  return { data: await res.json(), cached: cached ? Number(cached) : null };
}

/** The banner for a card fetched at `cachedAt` by the service worker, or none for a live one. */
function stale(cachedAt) {
  if (cachedAt === null) return void banner.set(null);
  const at = clock(new Date(cachedAt).toISOString());
  // Online, the kept copy means the network was too slow (sw.js): try again soon.
  if (navigator.onLine) {
    banner.set(t('Slow connection. Showing the update from {0}.', at));
    clearTimeout(slowRetry);
    slowRetry = setTimeout(refresh, 8_000);
  } else banner.set(t("You're offline. Showing the update from {0}.", at));
}
let slowRetry = null;

/** A query string: the 12-hour style, and the other params given. */
function query(params = {}) {
  const q = new URLSearchParams(hour12() ? { h12: '1' } : {});
  for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined) q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : '';
}

/**
 * Where the phone is, only when location is already allowed: the plan then
 * starts from the nearest stop, as in the phone app. Never asks by itself;
 * the Nearby chip does. Rounded to about 11 m, like the apps.
 */
async function here({ ask = false } = {}) {
  if (!navigator.geolocation) return null;
  if (!ask) {
    const state = await navigator.permissions?.query({ name: 'geolocation' }).then((p) => p.state).catch(() => null);
    if (state !== 'granted') return null;
  }
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (p) => {
        // How far out it may be: its accuracy, plus a walk's worth of its age.
        // The API drops a fix too rough to say where you are.
        const acc = Math.round((p.coords.accuracy || 0) + (Math.max(0, Date.now() - p.timestamp) / 1000) * 1.3);
        resolve({ lat: p.coords.latitude.toFixed(4), lon: p.coords.longitude.toFixed(4), acc: String(acc) });
      },
      () => resolve(null),
      { maximumAge: 60_000, timeout: 8_000 },
    );
  });
}

/** Counts refreshes: one that finishes after a newer one started (a chip tapped meanwhile) is dropped. */
let generation = 0;

async function refresh() {
  const mine = ++generation;
  const to = target.get();
  if (to.kind === 'nearby') return refreshNearby(mine);
  try {
    const at = await here();
    const params = { ...(to.kind === 'place' ? { place: to.key } : to.kind === 'stop' ? { to: to.to } : {}), ...at };
    // Today gets the location too: its next class is planned from here, as the card is.
    const [nextR, dayR] = await Promise.allSettled([get(`/me/next${query(params)}`), get(`/me/day${query(at ?? {})}`)]);
    if (mine !== generation) return;
    if (nextR.status === 'rejected' && nextR.reason?.message === 'signed out') return;
    const next = nextR.status === 'fulfilled' ? nextR.value : null;
    if (next?.data?.walkSpeedMs) walkSpeed.set(next.data.walkSpeedMs);
    const plan = dayR.status === 'fulfilled' ? dayR.value : null;
    if (plan) {
      day.set(plan.data);
      // What was taken off before this refresh started is gone from it now.
      removed.set((m) => new Map([...m].filter(([, at]) => at >= mine)));
    }
    // Offline with an answer gone stale (or none kept): the next thing on the
    // day plan the service worker kept, with its leave-by from then.
    const offline = !next || next.cached !== null;
    const fallback = offline && to.kind === 'plan' && (!next || isStale(next.data)) ? offlineNext(plan?.data, Date.now()) : null;
    if (fallback) {
      card.set({ offline: fallback });
      stale(plan.cached ?? Date.now());
      updated.set('');
      return;
    }
    if (!next) throw nextR.reason;
    card.set({ a: next.data });
    seen.set(seenKey(to), next.data);
    stale(next.cached);
    updated.set(t('Updated {0}', clock(new Date(next.cached ?? Date.now()).toISOString())));
    if (JSON.stringify(next.data.places ?? []) !== JSON.stringify(places.get())) places.set(next.data.places ?? []);
  } catch (err) {
    if (err.message === 'signed out' || mine !== generation) return;
    // Online but no answer (the server busy, an error): not "offline".
    banner.set(navigator.onLine ? t("Couldn't update. Trying again soon.") : t("You're offline and nothing has been saved yet. This will update when you're back online."));
  }
}

/** Each card drawn this visit, by what it was for: shown again at once when its chip is tapped, while it refreshes. */
const seen = new Map();
const seenKey = (to) => JSON.stringify(to);

/**
 * The card the service worker kept for this target, from an earlier visit.
 * Its key is the one sw.js keeps it under (route, place, clock style,
 * language), and it's this account's: sw.js empties the cache on sign-out.
 */
async function keptCard(to) {
  if (!('caches' in window) || (to.kind !== 'plan' && to.kind !== 'place')) return null;
  const q = new URLSearchParams();
  if (to.kind === 'place') q.set('place', to.key);
  if (hour12()) q.set('h12', '1');
  q.set('lang', window.i18n?.header ?? 'en');
  try {
    // Only sw.js's data cache holds /me/next, whatever its version.
    const res = await caches.match(`${location.origin}/me/next?${q}`);
    return res ? await res.json() : null;
  } catch {
    return null;
  }
}

/** Before the answer arrives: the card already seen for this target if it still holds, else "Checking…". */
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

/** Shows the card for `to` (a chip tapped, a search result, Go there on the map). */
function choose(to) {
  target.set(to);
  if (to.kind === 'nearby') {
    card.set({ text: t('Checking…'), loading: true });
    updated.set('');
  } else {
    drawSeen();
  }
  refresh();
}

/** A search result: its card, under a chip of its own, as a stop picked on the map. */
function goSomewhere(d) {
  searching.set(false);
  // A stop or a place is called by its name; a building or room by its code, as on its door.
  const label = d.kind === 'stop' || d.kind === 'landmark' ? d.label : d.code;
  const fav = favouriteNamed(label);
  if (fav) return choose({ kind: 'place', key: fav.key });
  addPlace(d.code, label);
  choose({ kind: 'stop', to: d.code, label });
}

/** Go there, from a stop on the map: Now, with the card for that stop. */
function goToStop({ code, name, place }) {
  // A saved place already has its chip: that one, not a second.
  if (!place) addPlace(code, name);
  target.set(place ? { kind: 'place', key: place } : { kind: 'stop', to: code, label: name });
  drawSeen();
  if (location.hash === '#map') history.pushState(null, '', '#now');
  showTab();
}

/** Every bus at the stops around you, from the browser's location. */
async function refreshNearby(mine) {
  const at = await here({ ask: true });
  if (mine !== generation) return;
  if (!at) return card.set({ text: t('Allow location for this site to see the buses near you.') });
  try {
    const { data } = await get(`/me/nearby${query(at)}`);
    if (mine !== generation) return;
    stale(null);
    updated.set(t('Updated {0}', clock(new Date().toISOString())));
    card.set(data.stops?.length ? { nearby: data.stops } : { text: t('No campus bus stops near you.') });
  } catch (err) {
    if (err.message !== 'signed out' && mine === generation) card.set({ text: t('Nearby needs a connection.') });
  }
}

/** An answer from a card's button or Undo: shown, then everything fetched again so Today and its offline copy follow. */
function answered(a) {
  card.set({ a });
  refresh();
}

/**
 * Taking an entry off today (× on the row): a timetabled class, one you
 * added, or the trip home. Gone at once, with Undo for a few seconds.
 */
let undoTimer = null;
function showUndo(value) {
  undo.set(value);
  clearTimeout(undoTimer);
  undoTimer = setTimeout(() => undo.set(null), 6_000);
}

async function removeFromToday(it, at, before) {
  removed.set((m) => new Map(m).set(it.key, generation + 1));
  const name = it.kind === 'home' ? t('The trip home') : it.label.split(' @ ')[0];
  showUndo({
    it,
    at,
    before,
    text: t('{0} removed from today', name),
    undo: async () => {
      undo.set(null);
      removed.set((m) => {
        const next = new Map(m);
        next.delete(it.key);
        return next;
      });
      try {
        card.set({ a: await signal({ kind: 'reset', trip: it.key }) });
      } finally {
        refresh();
      }
    },
  });
  try {
    card.set({ a: await signal({ kind: 'skipped', trip: it.key }) });
  } catch {
    // Said where it was done, just above the entry (back in the list), which the refresh below leaves alone.
    showUndo({ it, at, before: it.key, text: t("Couldn't remove that. Check your connection.") });
    removed.set((m) => {
      const next = new Map(m);
      next.delete(it.key);
      return next;
    });
  }
  refresh();
}

/* ---------- tabs ---------- */

const TABS = ['now', 'map', 'settings'];
/** Each tab's section, set as they're drawn. */
const views = {};
/** Counts switches: a fade that finishes after a newer tap is left to that one. */
let switches = 0;
/** Where Now and Settings were scrolled to, for coming back. */
const scrolled = {};

const tabInAddress = () => (location.hash === '#map' ? 'map' : location.hash.startsWith('#settings') ? 'settings' : 'now');

/**
 * Material's fade through, as on the phone: the old tab fades out quickly,
 * then the new one fades in with a slight zoom from the middle of the
 * screen. Reduced motion keeps only a short fade.
 */
function fadeIn(node) {
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  node.style.transformOrigin = `50% ${window.innerHeight / 2 - node.getBoundingClientRect().top}px`;
  const frames = reduce ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 0, transform: 'scale(0.92)' }, { opacity: 1, transform: 'none' }];
  node.animate(frames, { duration: reduce ? 150 : 210, easing: 'cubic-bezier(0, 0, 0.2, 1)' });
}
const fadeOut = (node) => node.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 90, easing: 'cubic-bezier(0.4, 0, 1, 1)', fill: 'forwards' });

/**
 * Now, Map or Settings, from the address (#map, #settings, #settings/trips),
 * so Back and a reload keep the tab. The sections are shown and hidden here,
 * not by Preact, so the fade can swap them between its two halves.
 */
async function showTab() {
  const next = tabInAddress();
  const from = tab.get();
  if (next === from) return;
  const mine = ++switches;
  const animate = from !== null && document.visibilityState === 'visible';
  if (from !== null) scrolled[from] = window.scrollY;
  if (animate) {
    const out = fadeOut(views[from]);
    await out.finished.catch(() => {});
    // Tapped again meanwhile: that switch draws its own tab.
    if (mine !== switches) return out.cancel();
    for (const n of TABS) views[n].hidden = n !== next;
    out.cancel();
  }
  for (const n of TABS) views[n].hidden = n !== next;
  tab.set(next);
  document.body.classList.toggle('on-map', next === 'map');
  document.body.classList.toggle('on-settings', next === 'settings');
  window.scrollTo(0, scrolled[next] ?? 0);
  if (animate) fadeIn(views[next]);
  if (next === 'map') {
    // The map's code on its first opening, after the fade: the tab shows at once.
    if (!mapModule.get()) mapModule.set(await import('/app/map.js'));
  } else if (next === 'settings') {
    openSettings();
  } else if (from !== null) {
    // start() refreshes once it has drawn the first tab.
    refresh();
  }
}

/** Settings the first time (the account page's, without its preview), and fresh from the account after. */
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
    if (!me.get()) me.set((await get('/me')).data);
    const [mod] = await Promise.all([import('/account/settings.js'), loadProfile(), loadCampus()]);
    settings.set({ status: 'ready', mod });
    if (shared) mod.offerImport(shared);
    shared = null;
  } catch (err) {
    settings.set({ status: err.message === 'signed out' ? 'idle' : 'failed', mod: null });
  }
}

/** A NUSMods link shared to the installed app (the manifest's share_target), if this is one. */
function sharedLink() {
  const q = new URLSearchParams(location.search);
  const text = [q.get('url'), q.get('text'), q.get('title')].filter(Boolean).join(' ');
  return text.match(/https:\/\/nusmods\.com\/timetable\/\S+/)?.[0] ?? null;
}

/* ---------- push ---------- */

const pushable = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const OFF = t("A reminder before it's time to leave, then updates on your bus as your trip goes on.");
const ON = t('On for this device. Notifications follow your trip, as on your other devices.');
/** "Notify me when to leave": whether it's on, what it says, and whether it has a button. */
const push = store({ on: false, text: OFF, button: true });

function b64urlBytes(s) {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

/** Subscribes this browser (asking first if needed) and tells the server where to push. */
async function subscribe() {
  const reg = await navigator.serviceWorker.ready;
  const { key } = await api('/me/push/key');
  let sub = await reg.pushManager.getSubscription();
  // A subscription made with another server key can't be pushed to: make a new one.
  const was = sub?.options?.applicationServerKey;
  if (sub && was && btoa(String.fromCharCode(...new Uint8Array(was))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') !== key) {
    await sub.unsubscribe();
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64urlBytes(key) });
  await api('/me/push', { method: 'POST', body: { subscription: sub.toJSON() } });
  // Ask for the card again now there's somewhere to push: a trip object that
  // woke before this found no one to tell, and waits for a request to watch again.
  refresh();
}

async function unsubscribe() {
  const reg = await navigator.serviceWorker.ready;
  await (await reg.pushManager.getSubscription())?.unsubscribe();
  await api('/me/push', { method: 'DELETE' }).catch(() => {});
}

/**
 * On iPhone push only works from the Home Screen, so in Safari the install
 * card says so instead. Once allowed, every open re-sends the subscription:
 * it belongs to this sign-in, and a browser can replace it at any time.
 */
async function setupPush() {
  if (!pushable || (iPhone && !standalone)) return;
  const perm = Notification.permission;
  if (perm === 'denied') return push.set({ on: false, text: t('Notifications are blocked for this site. Allow them in your browser settings to turn this on.'), button: false });
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
      push.set({ on: false, text: t('Notifications are blocked. To turn them on, allow notifications for this site in your browser settings.'), button: true });
    }
  } catch (err) {
    push.set({ on: false, text: t("Couldn't turn on notifications. {0}", err.message), button: true });
  }
}

/* ---------- drawing ---------- */

const SEARCH = '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.4-4.4"/>';
const CLOSE = '<path d="M6 6l12 12M18 6 6 18"/>';

/** "Notify me when to leave", in Settings under Notifications, where this browser can do it. */
function Notify() {
  const s = useStore(push);
  const [busy, setBusy] = useState(false);
  // A group of one row, as the rest of Settings' pages (settings-pages.js Group): blocked, the row says so without a switch.
  return html`
    <div class="trips">
      <section class="trips-group">
        <h3 class="eyebrow">${t('Before class')}</h3>
        <div class="card settings-list">
          <div class="field">
            <label for="notify-on">${t('Notify me when to leave')}<span class="field-sub">${s.text}</span></label>
            ${s.button &&
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
            </div>`}
          </div>
        </div>
      </section>
    </div>
  `;
}

/** iPhone Safari only, until installed or dismissed: iOS never offers it itself. */
function InstallHint() {
  const shown = useRef(null);
  const hidden = useStore(installDismissed);
  if (shown.current === null) {
    let dismissed = false;
    try {
      dismissed = localStorage.getItem('install-dismissed') === '1';
    } catch {
      // Storage blocked: show it, and just don't remember the dismissal.
    }
    // Only Safari can add to the Home Screen on iOS; other iOS browsers can't be helped here.
    const safari = /Safari/.test(navigator.userAgent) && !/CriOS|FxiOS|EdgiOS/.test(navigator.userAgent);
    shown.current = iPhone && safari && !standalone && !dismissed;
  }
  if (!shown.current || hidden) return null;
  const share = '<path d="M12 3v12"/><path d="m7 8 5-5 5 5"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/>';
  return html`
    <section class="card install">
      <h2>${t('Add terminus to your Home Screen')}</h2>
      <ol class="install-steps">
        <li>${t('Tap')} <span class="ios-share" aria-label=${t('the Share button')}><${Icon} paths=${share} size="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" /></span> ${t('at the bottom of Safari.')}</li>
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
          } catch {
            // Not remembered; it shows again next time.
          }
        }}
      >${t('Not now')}</button>
    </section>
  `;
}
const installDismissed = store(false);

/** Next, Nearby, each favourite, then places added from the search: the phone app's chips, then the search button. */
function Chips() {
  const to = useStore(target);
  const list = useStore(places);
  const extra = useStore(added);
  const open = useStore(searching);
  const same = (a, b) => a.kind === b.kind && (a.kind !== 'place' || a.key === b.key) && (a.kind !== 'stop' || a.to === b.to);
  const chip = (label, value) => html`
    <button type="button" aria-pressed=${String(same(value, to))} onClick=${() => choose(value)}>${label}</button>
  `;
  return html`
    <nav class="app-chips" aria-label=${t('Where to')}>
      ${chip(t('Next'), { kind: 'plan' })}
      ${chip(t('Nearby'), { kind: 'nearby' })}
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
      <button type="button" class="chip-search" aria-label=${t('Go somewhere else')} aria-expanded=${String(open)} onClick=${() => searching.set(!open)}>
        <${Icon} paths=${SEARCH} />
      </button>
    </nav>
  `;
}

/** Go somewhere else: the search under the chips, opened focused by the search button. */
function Where() {
  const open = useStore(searching);
  const c = useStore(campus);
  const box = useRef(null);
  useEffect(() => {
    if (!open) return;
    box.current?.focus();
    // Every stop, building, room and place, the first time it opens.
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

/**
 * The offline card: the day plan's next item, worded as the Today list words
 * it. Always an estimate (it was planned a while ago), so always "~"; the
 * class's start time is there so a "Leave now" after it has started reads
 * as late, and a trip home says from when.
 */
function OfflineCard({ item, step }) {
  if (step === 'home') {
    return html`
      <div class="widget offline-plan" aria-live="polite">
        <div class="where">${clock(item.startsAt)}</div>
        <div class="big">${t('Home, from {0}', item.fromName ?? t('your last class'))}</div>
      </div>
    `;
  }
  const l = item.leave;
  const how = l ? (l.svc ? t('{0} from {1}', l.svc, l.stop ?? item.fromName) : t('walk')) : null;
  return html`
    <div class="widget offline-plan" aria-live="polite">
      <div class="where">${`${t('Next class · {0}', item.label)} · ${t('starts {0}', clock(item.startsAt))}`}</div>
      <div class="big">${step === 'leaveBy' ? t('Leave by {0}', t('~{0}', clock(l.at))) : t('Leave now')}</div>
      ${how && html`<div class="detail">${how.charAt(0).toUpperCase() + how.slice(1)}</div>`}
    </div>
  `;
}

const mins = (s) => Math.round(s / 60);

/** A bus from the side, for a stop's name plate. */
const BUS = '<rect x="4.5" y="3" width="15" height="15" rx="3"/><path d="M4.5 11h15M8 21v-3M16 21v-3"/><circle cx="8.5" cy="14.5" r="1" fill="currentColor"/><circle cx="15.5" cy="14.5" r="1" fill="currentColor"/>';
/** How far up the road a bus is drawn: this many seconds away is the far end. */
const ROAD_S = 15 * 60;

/**
 * A bus on a Nearby road, nearer the stop the sooner it's due. The next one
 * is solid; the ones after it, faded. Drawn after them, it sits on top.
 */
const RoadBus = ({ bus, next }) => html`<span
  class=${`road-bus${bus.quality === 'live' ? ' live' : ''}${next ? '' : ' later'}`}
  style=${{ '--far': Math.min(1, Math.max(0, bus.etaS / ROAD_S)) }}
></span>`;

/** "4 min", "Arriving", "~6 min" for a timetable guess, or "–". */
const etaText = (b) => (b.etaS == null ? '–' : b.etaS < 60 ? t('Arriving') : b.quality === 'scheduled' ? t('~{0}', t('{0} min', mins(b.etaS))) : t('{0} min', mins(b.etaS)));

/**
 * Nearby: the stops around you as their signs, the name plate with the walk
 * there, then a row per service, its buses coming up a short road towards
 * the stop, nearer the sooner they're due, the next one solid and the rest
 * faded. The nearest stop is drawn larger. A timetable guess is an outline,
 * never a filled bus, so it doesn't pass for live. The name opens the stop
 * on the map.
 */
function NearbyCard({ stops }) {
  return html`
    <div class="widget nearby" aria-live="polite">
      ${stops.map(
        (s, i) => html`
          <section class=${i === 0 ? 'stop-sign nearest' : 'stop-sign'} key=${s.stop.code}>
            <header class="plate">
              <${Icon} paths=${BUS} class="plate-bus" />
              <button
                type="button"
                class="plate-name"
                aria-label=${t('{0} on the map', s.stop.name)}
                onClick=${() => {
                  stopToShow.set(s.stop.code);
                  location.hash = '#map';
                }}
              >${s.stop.name}</button>
              <span class="plate-walk">${t('{0} min walk', Math.max(1, mins(s.walkS)))}</span>
            </header>
            ${s.board.length
              ? s.board.map(
                  (b) => html`
                    <div class="nearby-row" key=${b.svc}>
                      <span class="svc-col"><span class="svc-tag" style=${b.color ? `--svc:${b.color};--svc-ink:${inkOn(b.color)}` : ''}>${b.svc}</span></span>
                      <span class="road" style=${{ '--svc': b.color ?? 'var(--muted)' }} aria-hidden="true"
                        >${[...(b.later ?? []), ...(b.etaS != null ? [b] : [])].map((bus, j) => html`<${RoadBus} key=${bus === b ? 'next' : j} bus=${bus} next=${bus === b} />`)}</span
                      >
                      <span class="eta">${etaText(b)}</span>
                    </div>
                  `,
                )
              : html`<div class="detail">${s.available ? t('No buses due') : t('No times right now')}</div>`}
          </section>
        `,
      )}
    </div>
  `;
}

/**
 * The card for what's chosen, under Now's sky (sky.js): whatever it shows,
 * its top is up in the sky and it ends on the horizon, so the sky stays as
 * the chips switch. The sky is the hour's, whatever the card says.
 */
function CardArea() {
  const c = useStore(card);
  const to = useStore(target);
  const when = useStore(updated);
  const who = useStore(me);
  const bar = useStore(undo);
  // Undo once: in the removed entry's row while it's there, not on the card as well.
  const a = c.a?.card && bar?.undo ? { ...c.a, card: { ...c.a.card, actions: c.a.card.actions.filter((x) => !(x.id === 'reset' && x.trip === bar.it.key)) } } : c.a;
  useNowSky(useSkyPhase());
  const body = a
    ? html`<${Card} a=${a} sky onAnswer=${answered} onChoice=${refresh} onPlace=${(key) => choose({ kind: 'place', key })} />`
    : c.offline
      ? html`<${InSky} sky><${OfflineCard} ...${c.offline} /><//>`
      : c.nearby
        ? html`<div class="sky-head nearby-sky"><${Celestial} /></div><${Horizon} /><${NearbyCard} stops=${c.nearby} />`
        : html`<${InSky} sky><${Message} text=${c.text} /><//>`;
  return html`
    <section class=${c.loading ? 'card app-card loading' : 'card app-card'}>
      ${body}
      <div class="card-foot">
        <div class="updated hint">${when}</div>
        ${to.kind !== 'nearby' && html`<${Report} key=${JSON.stringify(to)} answer=${c.a ?? null} anonymous=${who?.anonymous === true} />`}
      </div>
    </section>
  `;
}

/** The last time "Go later" offers in a day. */
const LAST_MARK = 23 * 60 + 55;
/** Half an hour from now on campus, on a five-minute mark: where "Go later" starts. Null once that's past LAST_MARK. */
function soonOnCampus() {
  const sgt = new Date(Date.now() + 8 * 3600_000);
  const min = Math.ceil((sgt.getUTCHours() * 60 + sgt.getUTCMinutes() + 30) / 5) * 5;
  return min <= LAST_MARK ? min : null;
}
const hhmmOf = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
/** The date on campus `days` from today (YYYY-MM-DD), and its weekday (0 is Sunday). */
function campusDay(days) {
  const d = new Date(Date.now() + 8 * 3600_000 + days * 86_400_000);
  return { date: d.toISOString().slice(0, 10), weekday: d.getUTCDay() };
}
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => t(d));
const WEEKDAYS_LONG = () => [t('Sunday'), t('Monday'), t('Tuesday'), t('Wednesday'), t('Thursday'), t('Friday'), t('Saturday')];
const ALERT = '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.5v.01"/>';

/**
 * Somewhere other than the plan: going there later, today or on one of the
 * next two days, planned like a class (POST /me/once). Settings' own rows:
 * the day as pills, the time as a stepper in five minutes whose middle is
 * the browser's own time picker. A time already past is the server's to
 * refuse, and its message shows above the buttons.
 */
function GoLater() {
  const to = useStore(target);
  const list = useStore(places);
  const [open, setOpen] = useState(false);
  const [day, setDay] = useState(0);
  const [at, setAt] = useState(0);
  const [msg, setMsg] = useState('');
  // Counts refusals, so the same message shakes again on another try.
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
      class="btn small ghost go-later"
      onClick=${() => {
        // Too late for anything today: tomorrow morning instead.
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
  // A time off the five-minute marks (from the picker) steps to the next mark.
  const earlier = () => pick(Math.ceil(at / 5) * 5 - 5);
  const later = () => pick(Math.floor(at / 5) * 5 + 5);
  const typed = (e) => {
    const [h, m] = e.currentTarget.value.split(':').map(Number);
    if (Number.isInteger(h) && Number.isInteger(m)) pick(h * 60 + m);
  };
  const showPicker = (e) => {
    try {
      e.currentTarget.showPicker?.();
    } catch {
      // Not every browser opens it on demand; typing in the field still works.
    }
  };
  const submit = async (e) => {
    e.preventDefault();
    const { date } = days[day];
    const where = to.kind === 'place' ? { place: to.key } : { to: to.to, label: to.label };
    setSending(true);
    try {
      const a = await api(`/me/once${query()}`, { method: 'POST', body: { ...where, atMin: at, date } });
      target.set({ kind: 'plan' });
      card.set({ a });
      refresh();
      // Today's trip is on the card now; a later day's isn't yet, so say where it went.
      const time = clock(`${date}T${hhmmOf(at)}:00+08:00`);
      if (day === 1) toast(t('Planned for tomorrow at {0}', time));
      else if (day > 1) toast(t('Planned for {0} at {1}', WEEKDAYS_LONG()[days[day].weekday], time));
    } catch (err) {
      // The server's own words when it answered; the browser's ("Failed to fetch") aren't for people.
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
        <button type="button" class="btn small ghost" onClick=${() => setOpen(false)}>${t('Cancel')}</button>
        <button type="submit" class="btn small accent" disabled=${sending}>${t('Plan it')}</button>
      </div>
    </form>
  `;
}

/** Today, from /me/day: each class with when to leave and how, and the trips home. */
function Today() {
  const plan = useStore(day);
  const gone = useStore(removed);
  const bar = useStore(undo);
  const items = (plan?.items ?? []).filter((it) => !gone.has(it.key));
  // The entry just taken off keeps its place, as a row saying so with Undo.
  // A failed removal's row sits just above the entry it's about, which is back.
  const rows = items.map((it) => ({ it }));
  // Kept above the entry that followed it, so a refresh meanwhile doesn't move it.
  if (bar?.it) {
    const next = bar.before === null ? rows.length : rows.findIndex((r) => r.it.key === bar.before);
    rows.splice(next >= 0 ? next : Math.min(bar.at, rows.length), 0, { note: bar });
  }
  if (!rows.length) return null;
  return html`
    <section class="today">
      <h2 class="label">${t('Today')}</h2>
      <ol class="today-list">
        ${rows.map(({ it, note }) => {
          if (note) {
            return html`
              <li class="today-item removed" key=${`removed:${note.it.key}`} role="status">
                <span class="at">${clock(note.it.startsAt)}</span>
                <span class="what"><span class="title">${note.text}</span></span>
                ${note.undo && html`<button type="button" class="linkish undo-today" onClick=${note.undo}>${t('Undo')}</button>`}
              </li>
            `;
          }
          const title = it.kind === 'home' ? t('Home, from {0}', it.fromName ?? t('your last class')) : it.label;
          let sub = null;
          if (it.status === 'skipped') sub = t('Not going');
          else if (it.onBus) sub = [t('On the {0}', it.onBus.svc), it.onBus.off ? t('off at {0}', it.onBus.off) : null, it.onBus.arrive ? t('arrive {0}', clock(it.onBus.arrive)) : null].filter(Boolean).join(' · ');
          else if (it.status !== 'done' && it.leave?.at) {
            const how = it.leave.svc ? t('{0} from {1}', it.leave.svc, it.leave.stop ?? it.fromName) : t('walk');
            sub = [t('Leave by {0}', it.leave.estimated ? t('~{0}', clock(it.leave.at)) : clock(it.leave.at)), how, it.timing?.status === 'late' ? it.timing.text : null].filter(Boolean).join(' · ');
          }
          return html`
            <li class=${`today-item ${it.status}`} key=${it.key}>
              <span class="at">${clock(it.startsAt)}</span>
              <span class="what"><span class="title">${title}</span>${sub && html`<span class="sub">${sub}</span>`}</span>
              ${it.removable && html`<button type="button" class="remove-today" aria-label=${t('Remove {0} from today', title)} onClick=${() => removeFromToday(it, items.indexOf(it), items[items.indexOf(it) + 1]?.key ?? null)}>×</button>`}
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
  return html`<section class="offline" hidden=${text === null}>${text}</section>`;
}

function MapArea() {
  const mod = useStore(mapModule);
  const now = useStore(tab);
  const focus = useStore(stopToShow);
  if (!mod) return null;
  return html`<${mod.MapTab} visible=${now === 'map'} focus=${focus} onFocused=${() => stopToShow.set(null)} onGoTo=${goToStop} onSaved=${refresh} />`;
}

function SettingsArea() {
  const s = useStore(settings);
  const who = useStore(me);
  const notify = useStore(push);
  if (s.status === 'failed') return html`<p class="hint">${t('Settings need a connection.')}</p>`;
  if (s.status !== 'ready') return html`<p class="hint">${t('Loading…')}</p>`;
  const Settings = s.mod.Settings;
  // "Notify me when to leave" in Settings, under Notifications, where this browser can do it.
  const canNotify = pushable && !(iPhone && !standalone);
  return html`<${Settings} me=${who} inApp sky Notify=${canNotify ? Notify : null} notifyOn=${notify.on} />`;
}

const TABBAR = [
  { id: 'now', href: '#now', label: () => t('Now'), icon: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>' },
  { id: 'map', href: '#map', label: () => t('Map'), icon: '<path d="M9 4 3.5 6v14L9 18l6 2 5.5-2V4L15 6 9 4Z"/><path d="M9 4v14M15 6v14"/>' },
  {
    id: 'settings',
    href: '#settings',
    label: () => t('Settings'),
    icon: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>',
  },
];

function TabBar() {
  const now = useStore(tab) ?? tabInAddress();
  return html`
    <nav class="tabbar" aria-label="terminus">
      ${TABBAR.map(
        (x) => html`
          <a href=${x.href} data-tab=${x.id} key=${x.id} aria-current=${now === x.id ? 'page' : undefined}>
            <${Icon} paths=${x.icon} />
            <span>${x.label()}</span>
          </a>
        `,
      )}
    </nav>
  `;
}

/** The three tabs, shown and hidden by showTab() after the first draw (see there). */
function App() {
  const first = useRef(tabInAddress()).current;
  const keep = (name) => (node) => node && (views[name] = node);
  return html`
    <main class="wrap app-main" id="tab-now" hidden=${first !== 'now'} ref=${keep('now')}>
      <${InstallHint} />
      <${Banner} />
      <${Chips} />
      <${Where} />
      <${CardArea} />
      <${GoLater} />
      <${Today} />
    </main>
    <section id="tab-map" class="map-tab" hidden=${first !== 'map'} ref=${keep('map')}><${MapArea} /></section>
    <section id="tab-settings" class="wrap settings-tab" hidden=${first !== 'settings'} ref=${keep('settings')}><${SettingsArea} /></section>
    <${TabBar} />
    <${Toast} />
  `;
}

async function start() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  // A tap on a notification with the app already open: show the new card.
  navigator.serviceWorker?.addEventListener('message', (e) => e.data?.kind === 'refresh' && refresh());
  render(html`<${App} />`, document.getElementById('root'));
  // The plan from last time at once, if it still holds (a look in the cache),
  // then the new one asked for alongside /me rather than after it.
  await drawSeen();
  const first = refresh();
  // /me renews the session, so the installed app stays signed in. It keeps
  // the same token, so the card's requests sent with it are still good.
  // Offline it comes from the cache like everything else, or not at all.
  try {
    me.set((await get('/me')).data);
  } catch (err) {
    if (err.message === 'signed out') return;
  }
  // Shared from NUSMods: Settings, with the link ready to import.
  shared = sharedLink();
  if (shared) history.replaceState(null, '', '/app/#settings');
  setupPush();
  window.addEventListener('hashchange', showTab);
  showTab();
  await first;
  const nowShown = () => document.visibilityState === 'visible' && tab.get() === 'now';
  setInterval(() => nowShown() && refresh(), REFRESH_MS);
  document.addEventListener('visibilitychange', () => nowShown() && refresh());
  window.addEventListener('online', refresh);
}

start();
