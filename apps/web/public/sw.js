// The web app's service worker (phase 5).
//
// - The app's own files come from the network, and a copy is kept so the
//   app still opens without a connection. (Serving the copy first would show
//   every update one load late, and could pair a new page with an old script.)
// - /me, /me/next and /me/day go to the network first. The last good reply
//   is kept, and served when the network is down, marked with
//   x-terminus-cached (when it was fetched) so the page can say so.
// - Signing in or out, deleting the account, or a 401 empties the kept
//   replies: they belong to one account and must not outlive it, or reach
//   the next one to sign in on this browser.
// - The map (app/map.js) is kept once it's been opened, not before: its
//   script, MapLibre, the stops and routes, the style, the fonts and icons
//   it used, and the whole campus map file, which is then read from here in
//   the pieces MapLibre asks for. So the campus map works offline after the
//   first look. Live buses and arrivals are never kept.

const SHELL = 'shell-v7';
const DATA = 'data-v3';
const MAP = 'map-v1';
const TILES = '/map/campus.pmtiles';
/** A kept map file older than this is checked for a newer one (they change twice a year). */
const TILES_CHECK_MS = 7 * 86_400_000;
const SHELL_FILES = [
  '/app/',
  '/app/app.js',
  '/app/offline.js',
  '/app/app.css',
  '/assets/tabbar.css',
  '/assets/ui.js',
  '/vendor/preact-10.29.8/preact.mjs',
  '/vendor/preact-10.29.8/hooks.mjs',
  '/vendor/preact-10.29.8/htm.mjs',
  '/account/dom.js',
  '/account/preview.js',
  '/account/profile.js',
  '/account/search.js',
  '/account/search-box.js',
  '/account/account.css',
  '/assets/site.css',
  '/assets/theme.js',
  '/assets/i18n.js',
  '/assets/zh.js',
  '/assets/mark.svg',
  '/favicon.svg',
  '/assets/icons/icon-192.png',
];
const DATA_PATHS = new Set(['/me', '/me/next', '/me/day']);
// Each changes whose account this browser is signed in to.
const SIGN_OUT = [
  ['POST', '/auth/logout'],
  ['POST', '/auth/code'],
  ['POST', '/auth/verify'],
  ['POST', '/auth/anon/web'],
  ['DELETE', '/me/sessions'],
  ['DELETE', '/me'],
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL && k !== DATA && k !== MAP).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (SIGN_OUT.some(([m, p]) => req.method === m && url.pathname === p)) {
    // Now as well as after: a reply already on its way must not be kept.
    forgetData();
    event.respondWith(fetch(req).finally(forgetData));
    return;
  }
  if (req.method !== 'GET') return;
  if (DATA_PATHS.has(url.pathname)) {
    event.respondWith(networkFirst(req));
    return;
  }
  if (SHELL_FILES.includes(url.pathname)) event.respondWith(shellFile(req, url.pathname));
  else if (url.pathname === TILES) event.respondWith(tiles(req, event));
  else if (url.pathname.startsWith('/vendor/') || url.pathname.startsWith('/map/fonts/') || url.pathname.startsWith('/map/sprites/')) event.respondWith(cacheFirst(req));
  else if (url.pathname === '/app/map.js' || url.pathname === '/campus' || url.pathname === '/map/style.json') event.respondWith(networkThenKept(req));
});

/* ---------- the map ---------- */

/** Files that never change at their address (versioned, or glyphs and icons). */
async function cacheFirst(req) {
  const cache = await caches.open(MAP);
  const kept = await cache.match(req);
  if (kept) return kept;
  const res = await fetch(req);
  if (res.ok) await cache.put(req, res.clone());
  return res;
}

/** The newest from the network, the kept copy without one. */
async function networkThenKept(req) {
  const cache = await caches.open(MAP);
  try {
    const res = await fetch(req);
    if (res.ok) await cache.put(req, res.clone());
    return res;
  } catch (err) {
    const kept = await cache.match(req);
    if (kept) return kept;
    throw err;
  }
}

/** The kept map file, read once per worker. */
let tilesBlob = null;
let tilesFetching = null;

/**
 * The campus map file, in the byte ranges MapLibre asks for. The first time,
 * from the network as asked, while the whole file (about 4 MB) is kept in
 * the background; after that, from the kept copy, checked weekly for a newer
 * one. The Cache API can't keep partial (206) replies, hence the whole file.
 */
async function tiles(req, event) {
  const cache = await caches.open(MAP);
  const kept = await cache.match(TILES);
  if (!kept) {
    event.waitUntil(keepTiles(cache, null));
    return fetch(req);
  }
  const age = Date.now() - Number(kept.headers.get('x-terminus-kept') ?? 0);
  if (age > TILES_CHECK_MS && navigator.onLine) event.waitUntil(keepTiles(cache, kept.headers.get('etag')));
  tilesBlob ??= { etag: kept.headers.get('etag'), blob: await kept.blob() };
  const { blob, etag } = tilesBlob;
  const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.get('range') ?? '');
  const headers = { 'content-type': 'application/vnd.pmtiles', 'accept-ranges': 'bytes', ...(etag ? { etag } : {}) };
  if (!m) return new Response(blob, { headers: { ...headers, 'content-length': String(blob.size) } });
  const start = Number(m[1]);
  const end = m[2] ? Math.min(Number(m[2]), blob.size - 1) : blob.size - 1;
  if (start >= blob.size || end < start) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${blob.size}` } });
  return new Response(blob.slice(start, end + 1), {
    status: 206,
    headers: { ...headers, 'content-range': `bytes ${start}-${end}/${blob.size}`, 'content-length': String(end - start + 1) },
  });
}

/** Fetches and keeps the whole map file; with an ETag, only if it changed. */
function keepTiles(cache, etag) {
  tilesFetching ??= (async () => {
    try {
      const res = await fetch(TILES, { headers: etag ? { 'if-none-match': etag } : {} });
      const kept = await cache.match(TILES);
      if (res.status === 304 && kept) {
        // Unchanged: just note when it was checked.
        const headers = new Headers(kept.headers);
        headers.set('x-terminus-kept', String(Date.now()));
        await cache.put(TILES, new Response(await kept.blob(), { headers }));
      } else if (res.status === 200) {
        const headers = new Headers(res.headers);
        headers.set('x-terminus-kept', String(Date.now()));
        await cache.put(TILES, new Response(await res.blob(), { headers }));
        tilesBlob = null;
      }
    } catch {
      // Offline or failed: try again on a later visit.
    } finally {
      tilesFetching = null;
    }
  })();
  return tilesFetching;
}

/** Bumped whenever the kept replies are emptied: a reply fetched before that is not kept. */
let dataGeneration = 0;
function forgetData() {
  dataGeneration++;
  return caches.delete(DATA);
}

async function networkFirst(req) {
  const generation = dataGeneration;
  const cache = await caches.open(DATA);
  // One kept reply per route, place or stop asked for, clock style and
  // language: not one per location, which would keep a reply for every few
  // metres walked. A stop's card (`to`) never stands in for the plan's.
  const url = new URL(req.url);
  const keyed = new URLSearchParams();
  for (const k of ['place', 'to', 'h12']) if (url.searchParams.get(k)) keyed.set(k, url.searchParams.get(k));
  const lang = (req.headers.get('accept-language') ?? '').split(',')[0].trim().slice(0, 16);
  if (lang) keyed.set('lang', lang);
  const key = `${url.origin}${url.pathname}${keyed.size ? `?${keyed}` : ''}`;
  try {
    const res = await fetch(req);
    // A server error is as good as no network: the kept reply beats an error.
    if (res.status >= 500) {
      const kept = await cache.match(key);
      if (kept) return kept;
    }
    if (res.status === 401) await forgetData();
    else if (res.ok) {
      const body = await res.clone().arrayBuffer();
      const headers = new Headers(res.headers);
      headers.set('x-terminus-cached', String(Date.now()));
      // Checked last, after every wait: a sign-out meanwhile wins.
      if (generation === dataGeneration) await cache.put(key, new Response(body, { status: 200, headers }));
    }
    return res;
  } catch (err) {
    const kept = await cache.match(key);
    if (kept) return kept;
    throw err;
  }
}

async function shellFile(req, path) {
  const cache = await caches.open(SHELL);
  try {
    const res = await fetch(req);
    if (res.ok) await cache.put(path, res.clone());
    return res;
  } catch {
    return (await cache.match(path)) ?? Response.error();
  }
}

// ---------- push (phase 5) ----------
//
// A push only says the card changed (the same nudge the Android app gets).
// The notification is worded here from /me/next, the way the phone app words
// its own: the question at the departure, the ride or the next way there
// while on the move, otherwise when to leave. One notification, replaced as
// the trip goes on; it only buzzes when the push says it's worth it.

const HOUR12 = new Intl.DateTimeFormat([], { hour: 'numeric' }).resolvedOptions().hour12 === true;
const hhmm = (iso) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Singapore' });

self.addEventListener('push', (event) => {
  let nudge = {};
  try {
    nudge = event.data?.json() ?? {};
  } catch {
    nudge = {};
  }
  event.waitUntil(notifyFromCard(Boolean(nudge.urgent)));
});

async function notifyFromCard(urgent, fetched) {
  let a = fetched ?? null;
  if (!a) {
    try {
      const res = await fetch(`/me/next${HOUR12 ? '?h12=1' : ''}`, { credentials: 'same-origin' });
      a = res.ok ? await res.json() : null;
    } catch {
      a = null;
    }
  }
  // A push must always show something (iOS insists), even when the card can't be fetched.
  if (!a?.card) {
    const zh = /^zh/i.test(self.navigator.language ?? '');
    const body = zh ? '你的行程有变化。打开 terminus 查看。' : 'Your trip has changed. Open terminus to see it.';
    return self.registration.showNotification('terminus', { body, tag: 'trip', icon: '/assets/icons/icon-192.png' });
  }
  // The server wrote the card in the account's language; the few words here follow it.
  const zh = /[\u4e00-\u9fff]/.test(`${a.label} ${a.detail ?? ''}`);
  const c = a.card;
  let title;
  let body;
  if (c.phase === 'riding' || c.phase === 'missed') {
    title = c.line ?? a.label;
    body = a.detail ?? '';
  } else {
    title = c.phase !== 'waiting' && a.leave?.at && Date.now() >= Date.parse(a.leave.at) ? (zh ? '现在出发' : 'Leave now') : (c.leaveBy ?? a.label);
    body = c.catch ?? a.dest?.label ?? '';
  }
  const where = [a.dest?.label, a.timing?.classAt ? (zh ? `${hhmm(a.timing.classAt)} 开始` : `starts ${hhmm(a.timing.classAt)}`) : null].filter(Boolean).join(' · ');
  // Nothing asks what happened. The one button, before you've left, is the
  // card's "Not going" (its words the server's); a tap anywhere else
  // opens the app. Browsers without buttons (iOS) just leave it out.
  const skip = c.phase !== 'riding' && c.phase !== 'missed' ? c.actions?.find((x) => x.id === 'skipped') : null;
  return self.registration.showNotification(title, {
    body: where ? `${body}\n${where}` : body,
    tag: 'trip',
    renotify: urgent,
    silent: !urgent,
    icon: '/assets/icons/icon-192.png',
    actions: skip ? [{ action: 'skipped', title: skip.label }] : [],
    data: { url: '/app/', trip: skip?.trip ?? null },
  });
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const trip = event.notification.data?.trip;
  // "Not going": the class off today, as the app's button does, without opening it.
  if (event.action === 'skipped' && trip) event.waitUntil(skipTrip(trip));
  else event.waitUntil(openApp());
});

/** Takes a class off today from the notification, then tells an open app to show the new plan. */
async function skipTrip(trip) {
  try {
    const res = await fetch(`/me/signal${HOUR12 ? '?h12=1' : ''}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'skipped', trip }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch {
    // Not done (offline, signed out): the app, where it can be tried again.
    return openApp();
  }
  for (const w of await self.clients.matchAll({ type: 'window', includeUncontrolled: true })) w.postMessage({ kind: 'refresh' });
}

/** The app, focused if it's open, opened if not. */
async function openApp() {
  const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const app = open.find((w) => new URL(w.url).pathname.startsWith('/app'));
  if (app) {
    app.postMessage({ kind: 'refresh' });
    return app.focus();
  }
  return self.clients.openWindow('/app/');
}
