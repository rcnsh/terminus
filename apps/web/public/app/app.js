// The installed web app (phase 5): the answer card and today, the way the
// phone app shows them, the campus map (app/map.js) and settings (the
// account page's, account/settings.js). A bar along the bottom switches
// between them, fading through as the phone app does.
//
// The service worker (/sw.js) answers /me/next and /me/day from its cache
// when the network is down; those replies carry x-terminus-cached with when
// they were fetched, so the page can say it's showing old times.

import { $, api, clock, el, t } from '/account/dom.js';
import { show } from '/account/preview.js';
import { offlineNext } from '/app/offline.js';

const HOUR12 = new Intl.DateTimeFormat([], { hour: 'numeric' }).resolvedOptions().hour12 === true;
/** The answer refreshes this often while the app is on screen (the API caches 15 s). */
const REFRESH_MS = 30_000;

const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
// iPadOS says it's a Mac; one with a touch screen is an iPad.
const iPhone = !/Android/.test(navigator.userAgent) && (/iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));

/** What the card shows: the plan, a saved place (its key), a stop picked on the map, or the buses nearby. */
let target = { kind: 'plan' };
let places = [];

/** GET a JSON route; `cached` is when the service worker's copy was fetched, if that's what came back. */
async function get(path) {
  const res = await fetch(path, { credentials: 'same-origin', headers: { 'accept-language': window.i18n?.header ?? 'en' } });
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

function stale(cachedAt) {
  $('#offline').hidden = cachedAt === null;
  if (cachedAt !== null) $('#offline').textContent = t("You're offline. Showing the update from {0}.", clock(new Date(cachedAt).toISOString()));
  document.body.classList.toggle('is-offline', cachedAt !== null);
}

/** A query string: the 12-hour style, and the other params given. */
function query(params = {}) {
  const q = new URLSearchParams(HOUR12 ? { h12: '1' } : {});
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
      (p) => resolve({ lat: p.coords.latitude.toFixed(4), lon: p.coords.longitude.toFixed(4) }),
      () => resolve(null),
      { maximumAge: 60_000, timeout: 8_000 },
    );
  });
}

/** Counts refreshes: one that finishes after a newer one started (a chip tapped meanwhile) is dropped. */
let generation = 0;

async function refresh() {
  const mine = ++generation;
  if (target.kind === 'nearby') return refreshNearby(mine);
  try {
    const at = await here();
    const params = { ...(target.kind === 'place' ? { place: target.key } : target.kind === 'stop' ? { to: target.to } : {}), ...at };
    const [nextR, dayR] = await Promise.allSettled([get(`/me/next${query(params)}`), get(`/me/day${query()}`)]);
    if (mine !== generation) return;
    if (nextR.status === 'rejected' && nextR.reason?.message === 'signed out') return;
    const next = nextR.status === 'fulfilled' ? nextR.value : null;
    const day = dayR.status === 'fulfilled' ? dayR.value : null;
    if (day) renderDay(day.data);
    // Offline with an answer gone stale (or none kept): the next thing on the
    // day plan the service worker kept, with its leave-by from then.
    const offline = !next || next.cached !== null;
    const fallback = offline && target.kind === 'plan' && (!next || isStale(next.data)) ? offlineNext(day?.data, Date.now()) : null;
    if (fallback) {
      showOffline(fallback);
      stale(day.cached ?? Date.now());
      $('#updated').textContent = '';
      return;
    }
    if (!next) throw nextR.reason;
    show(next.data);
    seen.set(seenKey(target), next.data);
    stale(next.cached);
    $('#updated').textContent = t('Updated {0}', clock(new Date(next.cached ?? Date.now()).toISOString()));
    if (JSON.stringify(next.data.places ?? []) !== JSON.stringify(places)) {
      places = next.data.places ?? [];
      renderChips();
    }
  } catch (err) {
    if (err.message === 'signed out' || mine !== generation) return;
    stale(Date.now());
    $('#offline').textContent = t("You're offline and nothing has been saved yet. This will update when you're back online.");
  }
}

/** Past the card's staleAt: its bus has gone, the plan has moved on, or it's old. */
const isStale = (a) => Boolean(a.card?.staleAt) && Date.now() >= Date.parse(a.card.staleAt);

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
  if (HOUR12) q.set('h12', '1');
  q.set('lang', window.i18n?.header ?? 'en');
  try {
    // DATA in sw.js.
    const res = await (await caches.open('data-v2')).match(`${location.origin}/me/next?${q}`);
    return res ? await res.json() : null;
  } catch {
    return null;
  }
}

/** Before the answer arrives: the card already seen for this target if it still holds, else "Checking…". */
async function drawSeen() {
  const to = target;
  const known = seen.get(seenKey(to)) ?? (await keptCard(to));
  if (to !== target) return;
  if (known && !isStale(known)) {
    show(known);
    $('#updated').textContent = t('Updating…');
  } else {
    $('#preview').replaceChildren(el('div', { class: 'detail', textContent: t('Checking…') }));
    $('#updated').textContent = '';
  }
}

/**
 * The offline card: the day plan's next item, worded as the Today list words
 * it. Always an estimate (it was planned a while ago), so always "~"; the
 * class's start time is there so a "Leave now" after it has started reads
 * as late, and a trip home says from when.
 */
function showOffline({ item, step }) {
  const box = $('#preview');
  box.className = 'widget offline-plan';
  if (step === 'home') {
    box.replaceChildren(
      el('div', { class: 'where', textContent: clock(item.startsAt) }),
      el('div', { class: 'big', textContent: t('Home, from {0}', item.fromName ?? t('your last class')) }),
    );
    return;
  }
  const l = item.leave;
  const how = l ? (l.svc ? t('{0} from {1}', l.svc, l.stop ?? item.fromName) : t('walk')) : null;
  const big = step === 'leaveBy' ? t('Leave by {0}', t('~{0}', clock(l.at))) : t('Leave now');
  box.replaceChildren(
    el('div', { class: 'where', textContent: `${t('Next class · {0}', item.label)} · ${t('starts {0}', clock(item.startsAt))}` }),
    el('div', { class: 'big', textContent: big }),
    // Capitalised: on a line of its own, not after "Leave by …" as in Today.
    how ? el('div', { class: 'detail', textContent: how.charAt(0).toUpperCase() + how.slice(1) }) : '',
  );
}

/** Next, each saved place, and Nearby: the phone app's chips. */
function renderChips() {
  const chip = (label, to) =>
    el('button', {
      type: 'button',
      textContent: label,
      'aria-pressed': String(JSON.stringify(to) === JSON.stringify(target)),
      onclick: () => {
        target = to;
        renderChips();
        if (to.kind === 'nearby') {
          $('#preview').replaceChildren(el('div', { class: 'detail', textContent: t('Checking…') }));
          $('#updated').textContent = '';
        } else {
          drawSeen();
        }
        refresh();
      },
    });
  $('#chips').replaceChildren(
    chip(t('Next'), { kind: 'plan' }),
    ...places.map((p) => chip(p.label, { kind: 'place', key: p.key })),
    chip(t('Nearby'), { kind: 'nearby' }),
    // A stop picked on the map (Go there), until another chip is tapped.
    target.kind === 'stop' ? chip(target.label, target) : '',
  );
}

/* ---------- tabs ---------- */

const TABS = ['now', 'map', 'settings'];
const view = (name) => $(`#tab-${name}`);
let mapModule = null;
/** Now, Map or Settings; null until the first draw. */
let tab = null;
/** Counts switches: a fade that finishes after a newer tap is left to that one. */
let switches = 0;
/** Where Now and Settings were scrolled to, for coming back. */
const scrolled = {};

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

/** Now, Map or Settings, from the address (#map, #settings, #settings/trips), so Back and a reload keep the tab. */
async function showTab() {
  const next = location.hash === '#map' ? 'map' : location.hash.startsWith('#settings') ? 'settings' : 'now';
  if (next === tab) return;
  const from = tab;
  tab = next;
  const mine = ++switches;
  for (const a of document.querySelectorAll('.tabbar a[data-tab]')) {
    if (a.dataset.tab === tab) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  const animate = from !== null && document.visibilityState === 'visible';
  if (from !== null) scrolled[from] = window.scrollY;
  if (animate) {
    const out = fadeOut(view(from));
    await out.finished.catch(() => {});
    // Tapped again meanwhile: that switch draws its own tab.
    if (mine !== switches) return out.cancel();
    for (const n of TABS) view(n).hidden = n !== tab;
    out.cancel();
  }
  for (const n of TABS) view(n).hidden = n !== tab;
  document.body.classList.toggle('on-map', tab === 'map');
  document.body.classList.toggle('on-settings', tab === 'settings');
  if (from === 'map') mapModule?.hideMap();
  window.scrollTo(0, scrolled[tab] ?? 0);
  if (animate) fadeIn(view(tab));
  if (tab === 'map') {
    // The map's code on its first opening, after the fade: the tab shows at once.
    mapModule ??= await import('/app/map.js');
    if (tab === 'map') mapModule.showMap();
  } else if (tab === 'settings') {
    openSettings();
  } else if (from !== null) {
    // start() refreshes once it has drawn the first tab.
    refresh();
  }
}

/** /me, as start() got it: who's signed in, for Settings. */
let me = null;
/** account/settings.js once Settings is drawn, and the drawing while it's under way. */
let settings = null;
let settingsLoading = null;
/** A NUSMods link shared to the app, for Settings to offer to import. */
let shared = null;

/** Settings the first time (the account page's, without its preview), and fresh from the account after. */
function openSettings() {
  if (settings) {
    settings.reload().catch(() => {});
    if (shared) settings.offerImport(shared);
    shared = null;
    return;
  }
  settingsLoading ??= (async () => {
    const box = $('#tab-settings');
    box.replaceChildren(el('p', { class: 'hint', textContent: t('Loading…') }));
    try {
      me ??= (await get('/me')).data;
      const mod = await import('/account/settings.js');
      // "Notify me when to leave" goes in Settings, under Notifications, where this browser can do it.
      const notify = pushable && !(iPhone && !standalone) ? $('#notify') : null;
      await mod.mountSettings(box, { me, inApp: true, notify });
      settings = mod;
      if (shared) mod.offerImport(shared);
      shared = null;
      await mod.renderLists();
    } catch (err) {
      if (err.message !== 'signed out') box.replaceChildren(el('p', { class: 'hint', textContent: t('Settings need a connection.') }));
    } finally {
      settingsLoading = null;
    }
  })();
}

/** A NUSMods link shared to the installed app (the manifest's share_target), if this is one. */
function sharedLink() {
  const q = new URLSearchParams(location.search);
  const text = [q.get('url'), q.get('text'), q.get('title')].filter(Boolean).join(' ');
  return text.match(/https:\/\/nusmods\.com\/timetable\/\S+/)?.[0] ?? null;
}

/** Go there, from a stop on the map: Now, with the card for that stop. */
function goToStop({ code, name, place }) {
  // A saved place already has its chip: that one, not a second.
  target = place ? { kind: 'place', key: place } : { kind: 'stop', to: code, label: name };
  renderChips();
  drawSeen();
  if (location.hash === '#map') history.pushState(null, '', '#now');
  showTab();
}

/** Every bus at the stops around you, from the browser's location. */
async function refreshNearby(mine) {
  const box = $('#preview');
  box.className = 'widget';
  const at = await here({ ask: true });
  if (mine !== generation) return;
  if (!at) {
    box.replaceChildren(el('div', { class: 'detail', textContent: t('Allow location for this site to see the buses near you.') }));
    return;
  }
  try {
    const { data } = await get(`/me/nearby${query(at)}`);
    if (mine !== generation) return;
    stale(null);
    $('#updated').textContent = t('Updated {0}', clock(new Date().toISOString()));
    if (!data.stops?.length) {
      box.replaceChildren(el('div', { class: 'detail', textContent: t('No campus bus stops near you.') }));
      return;
    }
    box.replaceChildren(
      ...data.stops.map((s) =>
        el(
          'section',
          { class: 'nearby-stop' },
          el('header', {}, el('div', { textContent: s.stop.name }), el('span', { textContent: t('{0} min walk', Math.max(1, Math.round(s.walkS / 60))) })),
          ...(s.board.length
            ? s.board.map((b) =>
                el('div', { class: 'nearby-row' }, el('span', { textContent: b.svc }), el('span', { textContent: b.etaS < 60 ? t('Arriving') : b.quality === 'scheduled' ? t('~{0}', t('{0} min', Math.round(b.etaS / 60))) : t('{0} min', Math.round(b.etaS / 60)) })),
              )
            : [el('div', { class: 'detail', textContent: s.available ? t('No buses due') : t('No times right now') })]),
        ),
      ),
    );
  } catch (err) {
    if (err.message !== 'signed out' && mine === generation) box.replaceChildren(el('div', { class: 'detail', textContent: t('Nearby needs a connection.') }));
  }
}

/**
 * Taking an entry off today (× on the row): a timetabled class, one you
 * added, or the trip home. Gone at once, with Undo for a few seconds.
 */
let undoTimer = null;
async function removeFromToday(it, li) {
  li.remove();
  const name = it.kind === 'home' ? t('The trip home') : it.label.split(' @ ')[0];
  const bar = $('#today-undo');
  const hide = () => {
    bar.hidden = true;
    clearTimeout(undoTimer);
  };
  bar.replaceChildren(
    el('span', { textContent: t('{0} removed from today', name) }),
    el('button', {
      type: 'button',
      class: 'linkish',
      textContent: t('Undo'),
      onclick: async () => {
        hide();
        try {
          show(await api(`/me/signal${HOUR12 ? '?h12=1' : ''}`, { method: 'POST', body: { kind: 'reset', trip: it.key } }));
        } finally {
          refresh();
        }
      },
    }),
  );
  bar.hidden = false;
  clearTimeout(undoTimer);
  undoTimer = setTimeout(hide, 6_000);
  try {
    show(await api(`/me/signal${HOUR12 ? '?h12=1' : ''}`, { method: 'POST', body: { kind: 'skipped', trip: it.key } }));
  } catch {
    hide();
    $('#offline').textContent = t("Couldn't remove that. Check your connection.");
  }
  refresh();
}

/** Today, from /me/day: each class with when to leave and how, and the trips home. */
function renderDay(day) {
  const items = day.items ?? [];
  $('#today').hidden = items.length === 0 && $('#today-undo').hidden;
  $('#today-list').replaceChildren(
    ...items.map((it) => {
      const title = it.kind === 'home' ? t('Home, from {0}', it.fromName ?? t('your last class')) : it.label;
      let sub = null;
      if (it.status === 'skipped') sub = t('Not going today');
      else if (it.onBus) sub = [t('On the {0}', it.onBus.svc), it.onBus.off ? t('off at {0}', it.onBus.off) : null, it.onBus.arrive ? t('arrive {0}', clock(it.onBus.arrive)) : null].filter(Boolean).join(' · ');
      else if (it.status !== 'done' && it.leave?.at) {
        const how = it.leave.svc ? t('{0} from {1}', it.leave.svc, it.leave.stop ?? it.fromName) : t('walk');
        sub = [t('Leave by {0}', it.leave.estimated ? t('~{0}', clock(it.leave.at)) : clock(it.leave.at)), how, it.timing?.status === 'late' ? it.timing.text : null].filter(Boolean).join(' · ');
      }
      const li = el(
        'li',
        { class: `today-item ${it.status}` },
        el('span', { class: 'at', textContent: clock(it.startsAt) }),
        el('span', { class: 'what' }, el('span', { class: 'title', textContent: title }), sub ? el('span', { class: 'sub', textContent: sub }) : ''),
      );
      if (it.removable) {
        li.append(el('button', { type: 'button', class: 'remove-today', textContent: '×', 'aria-label': t('Remove {0} from today', title), onclick: () => removeFromToday(it, li) }));
      }
      return li;
    }),
  );
}

function installHint() {
  let dismissed = false;
  try {
    dismissed = localStorage.getItem('install-dismissed') === '1';
  } catch {
    // Storage blocked: show it, and just don't remember the dismissal.
  }
  // Only Safari can add to the Home Screen on iOS; other iOS browsers can't be helped here.
  const safari = /Safari/.test(navigator.userAgent) && !/CriOS|FxiOS|EdgiOS/.test(navigator.userAgent);
  $('#install').hidden = !(iPhone && safari && !standalone && !dismissed);
  $('#install-dismiss').addEventListener('click', () => {
    $('#install').hidden = true;
    try {
      localStorage.setItem('install-dismissed', '1');
    } catch {
      // Not remembered; it shows again next time.
    }
  });
}

/* ---------- push ---------- */

const pushable = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

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
 * "Notify me when to leave". On iPhone push only works from the Home Screen,
 * so in Safari the install card says so instead. Once allowed, every open
 * re-sends the subscription: it belongs to this sign-in, and a browser can
 * replace it at any time.
 */
async function setupPush() {
  const box = $('#notify');
  if (!pushable || (iPhone && !standalone)) return;
  const perm = Notification.permission;
  const render = (on, text) => {
    box.hidden = false;
    $('#notify-text').textContent = text;
    $('#notify-on').textContent = on ? t('Turn off') : t('Turn on');
    $('#notify-on').className = `btn small ${on ? 'ghost' : 'accent'}`;
    $('#notify-on').dataset.on = on ? '1' : '';
  };
  const OFF = t("A reminder before it's time to leave, then updates on your bus as your trip goes on.");
  const ON = t('On for this device. Notifications follow your trip, as on your other devices.');
  if (perm === 'denied') {
    render(false, t('Notifications are blocked for this site. Allow them in your browser settings to turn this on.'));
    $('#notify-on').hidden = true;
    return;
  }
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
  render(on, on ? ON : OFF);
  $('#notify-on').onclick = async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      if (btn.dataset.on) {
        await unsubscribe();
        render(false, OFF);
      } else if ((await Notification.requestPermission()) === 'granted') {
        await subscribe();
        render(true, ON);
      } else {
        render(false, t('Notifications are blocked. To turn them on, allow notifications for this site in your browser settings.'));
      }
    } catch (err) {
      render(false, t("Couldn't turn on notifications. {0}", err.message));
    } finally {
      btn.disabled = false;
    }
  };
}

async function start() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  // A tap on a notification with the app already open: show the new card.
  navigator.serviceWorker?.addEventListener('message', (e) => e.data?.kind === 'refresh' && refresh());
  installHint();
  // /me first: it renews the session, so the installed app stays signed in.
  // Offline it comes from the cache like everything else, or not at all.
  try {
    me = (await get('/me')).data;
  } catch (err) {
    if (err.message === 'signed out') return;
  }
  // Shared from NUSMods: Settings, with the link ready to import.
  shared = sharedLink();
  if (shared) history.replaceState(null, '', '/app/#settings');
  renderChips();
  setupPush();
  window.addEventListener('hashchange', showTab);
  document.addEventListener('go-to-stop', (e) => goToStop(e.detail));
  // A stop saved as a place on the map: its chip comes with the next card.
  document.addEventListener('places-changed', refresh);
  showTab();
  // The plan from last time while this one loads, if it still holds.
  await drawSeen();
  await refresh();
  const nowShown = () => document.visibilityState === 'visible' && tab === 'now';
  setInterval(() => nowShown() && refresh(), REFRESH_MS);
  document.addEventListener('visibilitychange', () => nowShown() && refresh());
  window.addEventListener('online', refresh);
  document.addEventListener('trip-signal', refresh);
}

start();
