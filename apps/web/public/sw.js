// The web app's service worker.
//
// - The app's own files come from the network, and a copy is kept so the
//   app still opens without a connection. (Serving the copy first would show
//   every update one load late, and could pair a new page with an old script.)
//   On a slow connection the copy is used after a second's wait instead.
//   Vendored files carry their version in their address, so they come from
//   the copy first: they never change there.
// - Chinese (assets/zh.js) is kept once a page asks for it, not before: only
//   Chinese readers load it.
// - /api/me, /api/me/next and /api/me/day go to the network first. The last good
//   reply is kept, and served when the network is down, marked with
//   x-terminus-cached (when it was fetched) so the page can say so.
// - Signing in or out, deleting the account, or a 401 empties the kept
//   replies: they belong to one account and must not outlive it, or reach
//   the next one to sign in on this browser.
// - The map (app/map.js) is kept once it's been opened, not before: its
//   script, MapLibre, the stops and routes, the style, the fonts and icons
//   it used, and the whole campus map file, which is then read from here in
//   the pieces MapLibre asks for. So the campus map works offline after the
//   first look. Live buses and arrivals are never kept.
// - The stops and routes (/api/campus) change only with a deploy: a kept
//   copy answers at once, and one over an hour old is checked in the
//   background. A changed one replaces it, and the pages are told to read
//   it again; a 401 there is passed on, as it would have been in front.

const SHELL = 'shell-v23';
const DATA = 'data-v3';
const MAP = 'map-v1';
const TILES = '/map/campus.pmtiles';
/** A kept map file older than this is checked for a newer one (they change twice a year). */
const TILES_CHECK_MS = 7 * 86_400_000;
const SHELL_FILES = [
  '/app/',
  '/app/app.js',
  '/app/offline.js',
  '/app/map-files.js',
  '/app/timing.js',
  '/app/pull.js',
  // The Buses tab too, so it opens offline and says it needs a connection.
  '/app/buses.js',
  '/app/board.js',
  '/app/sign.js',
  '/app/app.css',
  '/assets/tabbar.css',
  '/assets/ui.js',
  '/vendor/preact-10.29.8/preact.mjs',
  '/vendor/preact-10.29.8/hooks.mjs',
  '/vendor/preact-10.29.8/htm.mjs',
  '/account/dom.js',
  '/account/preview.js',
  '/account/journey.js',
  '/account/sky.js',
  '/account/daylight.js',
  '/account/profile.js',
  '/account/search.js',
  '/account/search-box.js',
  '/account/account.css',
  '/assets/site.css',
  '/assets/errors.js',
  '/assets/theme.js',
  '/assets/i18n.js',
  '/assets/sky-phase.js',
  '/assets/stars.js',
  // The fonts too, so the app looks the same offline.
  '/assets/fonts.css',
  '/assets/fonts/inter-latin.woff2',
  '/assets/fonts/space-grotesk-latin.woff2',
  '/assets/mark.svg',
  '/favicon.svg',
  '/assets/icons/icon-192.png',
];
/** The Chinese words: kept with the app's files, but only for a browser that reads them. */
const ZH = '/assets/zh.js';
const DATA_PATHS = new Set(['/api/me', '/api/me/next', '/api/me/day']);
// Each changes whose account this browser is signed in to.
const SIGN_OUT = [
  ['POST', '/api/auth/logout'],
  ['POST', '/api/auth/code'],
  ['POST', '/auth/verify'],
  ['POST', '/api/auth/anon/web'],
  ['DELETE', '/api/me/sessions'],
  ['DELETE', '/api/me'],
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL);
      await cache.addAll(SHELL_FILES);
      // Chinese for a browser set to it, or one whose last version kept it
      // (Chinese chosen in Settings). Not worth failing the update over.
      if (/^zh/i.test(self.navigator.language ?? '') || (await caches.match(ZH))) await cache.add(ZH).catch(() => {});
      await self.skipWaiting();
    })(),
  );
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
    event.respondWith(networkFirst(req, event));
    return;
  }
  if (SHELL_FILES.includes(url.pathname) || url.pathname === ZH) {
    event.respondWith(url.pathname.startsWith('/vendor/') ? cacheFirst(req, SHELL) : shellFile(req, url.pathname, event));
  } else if (url.pathname === TILES) event.respondWith(tiles(req, event));
  // The dashboard's video encoder (its Timelapse section) is the operator's, not the map's: never kept.
  else if (url.pathname.startsWith('/vendor/mediabunny')) return;
  else if (url.pathname.startsWith('/vendor/') || url.pathname.startsWith('/map/fonts/') || url.pathname.startsWith('/map/sprites/'))
    event.respondWith(cacheFirst(req));
  else if (url.pathname === '/api/campus') event.respondWith(campusKept(req, event));
  else if (url.pathname === '/app/map.js' || url.pathname === '/map/style.json') event.respondWith(networkThenKept(req, event));
});

/** On a slow connection, how long to wait for the network before using the
 *  kept copy. The network's answer still updates the copy when it comes. */
const SLOW_MS = 4_000;
/** The same for the app's own files: a page waits on some 30 of them, and
 *  the copy is at most one edit old (the network's reply replaces it). */
const SHELL_SLOW_MS = 1_000;

/**
 * [network]'s reply, or, when it takes longer than [wait] (or fails), the
 * copy [kept] finds, if there is one. The network carries on in [event]'s
 * lifetime, so a late reply is still kept for next time.
 */
async function soonest(network, kept, event, wait = SLOW_MS) {
  event?.waitUntil(network.catch(() => {}));
  let timer;
  const slow = new Promise((ok) => {
    timer = setTimeout(ok, wait, 'slow');
  });
  const first = await Promise.race([
    network.then(
      (res) => ({ res }),
      (err) => ({ err }),
    ),
    slow,
  ]);
  clearTimeout(timer);
  if (first !== 'slow' && first.res) return first.res;
  const copy = await kept();
  if (copy) return copy;
  // Nothing kept: wait for the network after all (or its error).
  return network;
}

/**
 * Files that never change at their address (versioned, or glyphs and icons).
 * Kept under the address without `retry`: the Map tab asks again with
 * `?retry=N` after a failed download (app/map.js build), the same file. Any
 * other query stays: the glyphs' `?v=` is their version.
 */
async function cacheFirst(req, name = MAP) {
  const cache = await caches.open(name);
  const url = new URL(req.url);
  url.searchParams.delete('retry');
  const kept = await cache.match(url.href);
  if (kept) return kept;
  const res = await fetch(req);
  if (res.ok) {
    await cache.put(url.href, res.clone());
    await dropOtherVersions(cache, url.href);
  }
  return res;
}

/** A vendored library's name and version, from its folder: /vendor/maplibre-gl@6.11.2/… */
const vendored = (url) => /^\/vendor\/([^/@]+)@([^/]+)\//.exec(decodeURIComponent(new URL(url).pathname));

/**
 * A new version of a vendored library (MapLibre, PMTiles) has just been
 * kept: the copies of any other version go. Only the version the app asks
 * for now is ever kept, so the map's cache doesn't grow with each update,
 * and the version is named in one place (app/map-files.js), not here too.
 */
async function dropOtherVersions(cache, url) {
  const mine = vendored(url);
  if (!mine) return;
  for (const req of await cache.keys()) {
    const v = vendored(req.url);
    if (v && v[1] === mine[1] && v[2] !== mine[2]) await cache.delete(req);
  }
}

/** The newest from the network, the kept copy without one. `keep` puts a good reply in the cache. */
async function networkThenKept(req, event, keep = (cache, res) => cache.put(req, res)) {
  const cache = await caches.open(MAP);
  const network = (async () => {
    const res = await fetch(req);
    if (res.ok) await keep(cache, res.clone());
    return res;
  })();
  // Any language's copy: /api/campus varies by it, and one in the other language beats no map.
  return soonest(network, () => cache.match(req, { ignoreVary: true }), event);
}

/** A kept /api/campus younger than this is used without asking: the API's own max-age. */
const CAMPUS_FRESH_MS = 3_600_000;

/**
 * Keeps a /api/campus reply with when it was fetched, which says when it's
 * next checked. Only the API's JSON: a 200 that isn't (a captive portal's
 * sign-in page) would be served for an hour and break the Stops tab and the
 * map. Whether it was kept.
 */
async function keepCampus(cache, req, res) {
  if (!/json/i.test(res.headers.get('content-type') ?? '')) return false;
  const body = await res.text();
  try {
    JSON.parse(body);
  } catch {
    return false;
  }
  const headers = new Headers(res.headers);
  headers.set('x-terminus-cached', String(Date.now()));
  await cache.put(req, new Response(body, { status: 200, headers }));
  return true;
}

/**
 * /api/campus: the kept copy in the page's language at once, checked in the
 * background (with its ETag) once it's an hour old. Without one, as the
 * map's other files: the network, the copy in another language offline.
 */
async function campusKept(req, event) {
  const cache = await caches.open(MAP);
  const kept = await cache.match(req);
  if (!kept) return networkThenKept(req, event, (c, res) => keepCampus(c, req, res));
  if (Date.now() - Number(kept.headers.get('x-terminus-cached') ?? 0) >= CAMPUS_FRESH_MS)
    event.waitUntil(recheckCampus(req, cache, kept.clone()));
  return kept;
}

/** One check at a time per language: the pages ask for /api/campus in several places at once. */
const campusChecking = new Map();

/**
 * Asks whether the kept /api/campus is still the newest. Unchanged (304, or
 * the same ETag), it's kept as fresh for another hour; changed, it's
 * replaced and the pages read it again. A 401 is told to the pages, which
 * sign out as they would had it come in front. Offline, nothing changes.
 */
function recheckCampus(req, cache, kept) {
  const lang = req.headers.get('accept-language') ?? '';
  if (campusChecking.has(lang)) return campusChecking.get(lang);
  const check = (async () => {
    const etag = kept.headers.get('etag');
    const headers = new Headers(req.headers);
    if (etag) headers.set('if-none-match', etag);
    const res = await fetch(new Request(req.url, { headers, credentials: 'same-origin', cache: 'no-store' }));
    if (res.status === 304 || (res.ok && etag && res.headers.get('etag') === etag)) {
      res.body?.cancel();
      return keepCampus(cache, req, kept);
    }
    if (res.status === 401) return tellPages({ kind: 'campus', status: 401 });
    // Not the API's answer: the copy stays, still due a check.
    if (!res.ok || !(await keepCampus(cache, req, res))) return undefined;
    return tellPages({ kind: 'campus' });
  })()
    .catch(() => {})
    .finally(() => campusChecking.delete(lang));
  campusChecking.set(lang, check);
  return check;
}

async function tellPages(message) {
  for (const w of await self.clients.matchAll({ type: 'window', includeUncontrolled: true })) w.postMessage(message);
}

/** The kept map file, read once per worker. */
let tilesBlob = null;
let tilesFetching = null;

/**
 * The campus map file, in the byte ranges MapLibre asks for. The first time,
 * from the network as asked, while the whole file (about 3 MB) is kept in
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

async function networkFirst(req, event) {
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
  // `keyed.size` is undefined on Safari before 17 (iOS 16.4 to 16.7, the
  // first with web push), which would keep every card under the bare path.
  const query = String(keyed);
  const key = `${url.origin}${url.pathname}${query ? `?${query}` : ''}`;
  const network = (async () => {
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
  })();
  // A signed-out device has nothing kept, so it always waits for the network.
  return soonest(network, () => (generation === dataGeneration ? cache.match(key) : null), event);
}

async function shellFile(req, path, event) {
  const cache = await caches.open(SHELL);
  const network = fetch(req).then(async (res) => {
    // A server error (a deploy window, an outage) is as good as no network:
    // the kept copy beats an error page, as it does for the account's replies.
    if (res.status >= 500) {
      const kept = await cache.match(path);
      if (kept) return kept;
    }
    // Kept after the page has it, not before.
    if (res.ok) event.waitUntil(keepShell(cache, path, res.clone()));
    return res;
  });
  return soonest(network, () => cache.match(path), event, SHELL_SLOW_MS).catch(() => Response.error());
}

/** Keeps [res] as [path]'s copy, unless it's the copy already kept (same ETag): most loads change nothing. */
async function keepShell(cache, path, res) {
  const etag = res.headers.get('etag');
  const kept = etag ? await cache.match(path) : null;
  if (kept && kept.headers.get('etag') === etag) return res.body?.cancel();
  return cache.put(path, res);
}

// A push only says the card changed (the same nudge the Android app gets).
// The notification is worded here from /api/me/next, the way the phone app words
// its own: the question at the departure, the ride or the next way there
// while on the move, otherwise when to leave. One notification, replaced as
// the trip goes on; it only buzzes when the push says it's worth it.

const HOUR12 = new Intl.DateTimeFormat([], { hour: 'numeric' }).resolvedOptions().hour12 === true;
/** How long a push waits for the card. The browser allows a push only so
 *  long to show something, and iOS may end the subscription of one that
 *  shows nothing: past this, the plain "Your trip has changed" instead. */
const PUSH_CARD_MS = 8_000;

self.addEventListener('push', (event) => {
  let nudge = {};
  try {
    nudge = event.data?.json() ?? {};
  } catch {
    nudge = {};
  }
  event.waitUntil(nudge.kind === 'term' ? notifyTerm(nudge) : notifyFromCard(Boolean(nudge.urgent)));
});

/** The new semester's reminder: the server's words, in this browser's language. Opens Settings › Timetable. */
function notifyTerm(n) {
  const zh = /^zh/i.test(self.navigator.language ?? '');
  return self.registration.showNotification((zh ? n.zhTitle : n.title) ?? 'terminus', {
    body: (zh ? n.zhBody : n.body) ?? '',
    tag: 'term',
    icon: '/assets/icons/icon-192.png',
    data: { url: '/app/#settings/timetable' },
  });
}

async function notifyFromCard(urgent) {
  let a = null;
  try {
    const res = await fetch(`/api/me/next${HOUR12 ? '?h12=1' : ''}`, {
      credentials: 'same-origin',
      signal: AbortSignal.timeout?.(PUSH_CARD_MS),
    });
    a = res.ok ? await res.json() : null;
  } catch {
    a = null;
  }
  // A push must always show something (iOS insists), even when the card can't be fetched.
  if (!a?.card) {
    // The site's language choice (assets/i18n.js keeps it as a cookie too); a
    // worker can't read localStorage, and cookieStore isn't in every browser.
    let chosen = null;
    try {
      chosen = (await self.cookieStore?.get('terminus-lang'))?.value ?? null;
    } catch {
      chosen = null;
    }
    const zh = chosen === 'zh' || (chosen !== 'en' && /^zh/i.test(self.navigator.language ?? ''));
    const body = zh ? '你的行程有变化。打开 terminus 查看。' : 'Your trip has changed. Open terminus to see it.';
    return self.registration.showNotification('terminus', { body, tag: 'trip', icon: '/assets/icons/icon-192.png' });
  }
  // Every word is the card's, written by the server in the account's language.
  const c = a.card;
  let title;
  let body;
  // The bus gone with nothing known (`gone`): its line, never "Leave now" to
  // someone who may be on it.
  if (c.phase === 'riding' || c.phase === 'missed' || c.gone) {
    title = c.line ?? a.label;
    body = a.detail ?? '';
  } else {
    // Its leave-by gone: the phase's "Time to get going" rather than an old "Leave by".
    const gone = c.phase !== 'waiting' && a.leave?.at && Date.now() >= Date.parse(a.leave.at);
    title = (gone ? c.phaseText : null) ?? c.leaveBy ?? c.glance ?? a.label;
    body = c.catch ?? a.dest?.label ?? '';
  }
  // "To CS2030 @ COM1 · starts 10:00", or the heading ("Heading home").
  const where = c.journey?.title ?? c.heading ?? a.dest?.label ?? '';
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
  else event.waitUntil(openApp(event.notification.data?.url));
});

/** Takes a class off today from the notification, then tells an open app to show the new plan. */
async function skipTrip(trip) {
  try {
    const res = await fetch(`/api/me/signal${HOUR12 ? '?h12=1' : ''}`, {
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
async function openApp(url = '/app/') {
  const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const app = open.find((w) => new URL(w.url).pathname.startsWith('/app'));
  if (app) {
    // Somewhere in particular (the reminder's Settings › Timetable): go there.
    if (url !== '/app/' && 'navigate' in app) return app.navigate(url).then((w) => w?.focus());
    app.postMessage({ kind: 'refresh' });
    return app.focus();
  }
  return self.clients.openWindow(url);
}
