// The installed web app (phase 5): the answer card and today, the way the
// phone app shows them. Settings are the account page, one tap away.
//
// The service worker (/sw.js) answers /me/next and /me/day from its cache
// when the network is down; those replies carry x-terminus-cached with when
// they were fetched, so the page can say it's showing old times.

import { $, api, clock, el } from '/account/dom.js';
import { show } from '/account/preview.js';

const HOUR12 = new Intl.DateTimeFormat([], { hour: 'numeric' }).resolvedOptions().hour12 === true;
/** The answer refreshes this often while the app is on screen (the API caches 15 s). */
const REFRESH_MS = 30_000;

const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
// iPadOS says it's a Mac; one with a touch screen is an iPad.
const iPhone = !/Android/.test(navigator.userAgent) && (/iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));

/** What the card shows: the plan, a saved place (its key), or the buses nearby. */
let target = { kind: 'plan' };
let places = [];

/** GET a JSON route; `cached` is when the service worker's copy was fetched, if that's what came back. */
async function get(path) {
  const res = await fetch(path, { credentials: 'same-origin' });
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
  if (cachedAt !== null) $('#offline').textContent = `Offline: showing what terminus saw at ${clock(new Date(cachedAt).toISOString())}.`;
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

async function refresh() {
  if (target.kind === 'nearby') return refreshNearby();
  try {
    const at = await here();
    const params = { ...(target.kind === 'place' ? { place: target.key } : {}), ...(at ?? {}) };
    const [next, day] = await Promise.all([get(`/me/next${query(params)}`), get(`/me/day${query()}`).catch(() => null)]);
    show(next.data);
    stale(next.cached);
    $('#updated').textContent = `Updated ${clock(new Date(next.cached ?? Date.now()).toISOString())}`;
    if (day) renderDay(day.data);
    if (JSON.stringify(next.data.places ?? []) !== JSON.stringify(places)) {
      places = next.data.places ?? [];
      renderChips();
    }
  } catch (err) {
    if (err.message === 'signed out') return;
    stale(Date.now());
    $('#offline').textContent = 'Offline, and nothing saved yet. It will update when you are back online.';
  }
}

/** Next, each saved place, and Nearby: the phone app's chips. */
function renderChips() {
  const chip = (label, t) =>
    el('button', {
      type: 'button',
      textContent: label,
      'aria-pressed': String(JSON.stringify(t) === JSON.stringify(target)),
      onclick: () => {
        target = t;
        renderChips();
        $('#preview').replaceChildren(el('div', { class: 'detail', textContent: 'Checking…' }));
        $('#updated').textContent = '';
        refresh();
      },
    });
  $('#chips').replaceChildren(
    chip('Next', { kind: 'plan' }),
    ...places.map((p) => chip(p.label, { kind: 'place', key: p.key })),
    chip('Nearby', { kind: 'nearby' }),
  );
}

/** Every bus at the stops around you, from the browser's location. */
async function refreshNearby() {
  const box = $('#preview');
  box.className = 'widget';
  const at = await here({ ask: true });
  if (!at) {
    box.replaceChildren(el('div', { class: 'detail', textContent: 'Allow location for this site to see the buses near you.' }));
    return;
  }
  try {
    const { data } = await get(`/me/nearby${query(at)}`);
    stale(null);
    $('#updated').textContent = `Updated ${clock(new Date().toISOString())}`;
    if (!data.stops?.length) {
      box.replaceChildren(el('div', { class: 'detail', textContent: 'No campus bus stops near you.' }));
      return;
    }
    box.replaceChildren(
      ...data.stops.map((s) =>
        el(
          'section',
          { class: 'nearby-stop' },
          el('header', {}, el('div', { textContent: s.stop.name }), el('span', { textContent: `${Math.max(1, Math.round(s.walkS / 60))} min walk` })),
          ...(s.board.length
            ? s.board.map((b) =>
                el('div', { class: 'nearby-row' }, el('span', { textContent: b.svc }), el('span', { textContent: b.etaS < 60 ? 'Arriving' : `${b.quality === 'scheduled' ? '~' : ''}${Math.round(b.etaS / 60)} min` })),
              )
            : [el('div', { class: 'detail', textContent: s.available ? 'No buses due' : 'No times right now' })]),
        ),
      ),
    );
  } catch (err) {
    if (err.message !== 'signed out') box.replaceChildren(el('div', { class: 'detail', textContent: 'Nearby needs a connection.' }));
  }
}

/**
 * Taking an entry off today (× on the row): a timetabled class, one you
 * added, or the trip home. Gone at once, with Undo for a few seconds.
 */
let undoTimer = null;
async function removeFromToday(it, li) {
  li.remove();
  const name = it.kind === 'home' ? 'The trip home' : it.label.split(' @ ')[0];
  const bar = $('#today-undo');
  const hide = () => {
    bar.hidden = true;
    clearTimeout(undoTimer);
  };
  bar.replaceChildren(
    el('span', { textContent: `${name} taken off today` }),
    el('button', {
      type: 'button',
      class: 'linkish',
      textContent: 'Undo',
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
    $('#offline').textContent = "Couldn't remove that. Check your connection.";
  }
  refresh();
}

/** Today, from /me/day: each class with when to leave and how, and the trips home. */
function renderDay(day) {
  const items = day.items ?? [];
  $('#today').hidden = items.length === 0 && $('#today-undo').hidden;
  $('#today-list').replaceChildren(
    ...items.map((it) => {
      const title = it.kind === 'home' ? `Home, from ${it.fromName ?? 'your last class'}` : it.label;
      let sub = null;
      if (it.status === 'skipped') sub = 'Not going today';
      else if (it.onBus) sub = [`On the ${it.onBus.svc}`, it.onBus.off ? `off at ${it.onBus.off}` : null, it.onBus.arrive ? `arrive ${clock(it.onBus.arrive)}` : null].filter(Boolean).join(' · ');
      else if (it.status !== 'done' && it.leave?.at) {
        const how = it.leave.svc ? `${it.leave.svc} from ${it.leave.stop ?? it.fromName}` : 'walk';
        sub = [`Leave by ${it.leave.estimated ? '~' : ''}${clock(it.leave.at)}`, how, it.timing?.status === 'late' ? it.timing.text : null].filter(Boolean).join(' · ');
      }
      const li = el(
        'li',
        { class: `today-item ${it.status}` },
        el('span', { class: 'at', textContent: clock(it.startsAt) }),
        el('span', { class: 'what' }, el('span', { class: 'title', textContent: title }), sub ? el('span', { class: 'sub', textContent: sub }) : ''),
      );
      if (it.removable) {
        li.append(el('button', { type: 'button', class: 'remove-today', textContent: '×', 'aria-label': `Remove ${title} from today`, onclick: () => removeFromToday(it, li) }));
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
    $('#notify-on').textContent = on ? 'Turn off' : 'Turn on';
    $('#notify-on').className = `btn small ${on ? 'ghost' : 'accent'}`;
    $('#notify-on').dataset.on = on ? '1' : '';
  };
  const OFF = 'A heads-up before you need to set off, and when your bus leaves, a quick "did you catch it?".';
  const ON = 'On for this device. They follow your trip, the same as on your other devices.';
  if (perm === 'denied') {
    render(false, 'Notifications are blocked for this site. Allow them in your browser settings to turn this on.');
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
        render(false, 'Notifications stay off: the browser was told not to allow them.');
      }
    } catch (err) {
      render(false, `Couldn't turn them on. ${err.message}`);
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
    await get('/me');
  } catch (err) {
    if (err.message === 'signed out') return;
  }
  renderChips();
  setupPush();
  await refresh();
  setInterval(() => document.visibilityState === 'visible' && refresh(), REFRESH_MS);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && refresh());
  window.addEventListener('online', refresh);
  document.addEventListener('trip-signal', refresh);
}

start();
