const SHELL = 'shell-v25';
const DATA = 'data-v3';
const MAP = 'map-v1';
const TILES = '/map/campus.pmtiles';
const TILES_CHECK_MS = 7 * 86_400_000;
const SHELL_FILES = [
  '/app/',
  '/app/app.js',
  '/app/offline.js',
  '/app/map-files.js',
  '/app/timing.js',
  '/app/pull.js',
  '/app/tabs.js',
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
  '/assets/fonts.css',
  '/assets/fonts/inter-latin.woff2',
  '/assets/fonts/space-grotesk-latin.woff2',
  '/assets/mark.svg',
  '/favicon.svg',
  '/assets/icons/icon-192.png',
];
const ZH = '/assets/zh.js';
const DATA_PATHS = new Set(['/api/me', '/api/me/next', '/api/me/day']);
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
  else if (url.pathname.startsWith('/vendor/mediabunny')) return;
  else if (url.pathname.startsWith('/vendor/') || url.pathname.startsWith('/map/fonts/') || url.pathname.startsWith('/map/sprites/'))
    event.respondWith(cacheFirst(req));
  else if (url.pathname === '/api/campus') event.respondWith(campusKept(req, event));
  else if (url.pathname === '/app/map.js' || url.pathname === '/map/style.json') event.respondWith(networkThenKept(req, event));
});

const SLOW_MS = 4_000;
const SHELL_SLOW_MS = 1_000;

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
  return network;
}

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

const vendored = (url) => /^\/vendor\/([^/@]+)@([^/]+)\//.exec(decodeURIComponent(new URL(url).pathname));

async function dropOtherVersions(cache, url) {
  const mine = vendored(url);
  if (!mine) return;
  for (const req of await cache.keys()) {
    const v = vendored(req.url);
    if (v && v[1] === mine[1] && v[2] !== mine[2]) await cache.delete(req);
  }
}

async function networkThenKept(req, event, keep = (cache, res) => cache.put(req, res)) {
  const cache = await caches.open(MAP);
  const network = (async () => {
    const res = await fetch(req);
    if (res.ok) await keep(cache, res.clone());
    return res;
  })();
  return soonest(network, () => cache.match(req, { ignoreVary: true }), event);
}

const CAMPUS_FRESH_MS = 3_600_000;

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

async function campusKept(req, event) {
  const cache = await caches.open(MAP);
  const kept = await cache.match(req);
  if (!kept) return networkThenKept(req, event, (c, res) => keepCampus(c, req, res));
  if (Date.now() - Number(kept.headers.get('x-terminus-cached') ?? 0) >= CAMPUS_FRESH_MS)
    event.waitUntil(recheckCampus(req, cache, kept.clone()));
  return kept;
}

const campusChecking = new Map();

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

let tilesBlob = null;
let tilesFetching = null;

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

function keepTiles(cache, etag) {
  tilesFetching ??= (async () => {
    try {
      const res = await fetch(TILES, { headers: etag ? { 'if-none-match': etag } : {} });
      const kept = await cache.match(TILES);
      if (res.status === 304 && kept) {
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
    } finally {
      tilesFetching = null;
    }
  })();
  return tilesFetching;
}

let dataGeneration = 0;
function forgetData() {
  dataGeneration++;
  return caches.delete(DATA);
}

async function networkFirst(req, event) {
  const generation = dataGeneration;
  const cache = await caches.open(DATA);
  const url = new URL(req.url);
  const keyed = new URLSearchParams();
  for (const k of ['place', 'to', 'h12']) if (url.searchParams.get(k)) keyed.set(k, url.searchParams.get(k));
  const lang = (req.headers.get('accept-language') ?? '').split(',')[0].trim().slice(0, 16);
  if (lang) keyed.set('lang', lang);
  const query = String(keyed);
  const key = `${url.origin}${url.pathname}${query ? `?${query}` : ''}`;
  const network = (async () => {
    const res = await fetch(req);
    if (res.status >= 500) {
      const kept = await cache.match(key);
      if (kept) return kept;
    }
    if (res.status === 401) await forgetData();
    else if (res.ok) {
      const body = await res.clone().arrayBuffer();
      const headers = new Headers(res.headers);
      headers.set('x-terminus-cached', String(Date.now()));
      if (generation === dataGeneration) await cache.put(key, new Response(body, { status: 200, headers }));
    }
    return res;
  })();
  return soonest(network, () => (generation === dataGeneration ? cache.match(key) : null), event);
}

async function shellFile(req, path, event) {
  const cache = await caches.open(SHELL);
  const network = fetch(req).then(async (res) => {
    if (res.status >= 500) {
      const kept = await cache.match(path);
      if (kept) return kept;
    }
    if (res.ok) event.waitUntil(keepShell(cache, path, res.clone()));
    return res;
  });
  return soonest(network, () => cache.match(path), event, SHELL_SLOW_MS).catch(() => Response.error());
}

async function keepShell(cache, path, res) {
  const etag = res.headers.get('etag');
  const kept = etag ? await cache.match(path) : null;
  if (kept && kept.headers.get('etag') === etag) return res.body?.cancel();
  return cache.put(path, res);
}

const HOUR12 = new Intl.DateTimeFormat([], { hour: 'numeric' }).resolvedOptions().hour12 === true;
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
  if (!a?.card) {
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
  const c = a.card;
  let title;
  let body;
  if (c.phase === 'riding' || c.phase === 'missed' || c.gone) {
    title = c.line ?? a.label;
    body = a.detail ?? '';
  } else {
    const gone = c.phase !== 'waiting' && a.leave?.at && Date.now() >= Date.parse(a.leave.at);
    title = (gone ? c.phaseText : null) ?? c.leaveBy ?? c.glance ?? a.label;
    body = c.catch ?? a.dest?.label ?? '';
  }
  const where = c.journey?.title ?? c.heading ?? a.dest?.label ?? '';
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
  if (event.action === 'skipped' && trip) event.waitUntil(skipTrip(trip));
  else event.waitUntil(openApp(event.notification.data?.url));
});

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
    return openApp();
  }
  for (const w of await self.clients.matchAll({ type: 'window', includeUncontrolled: true })) w.postMessage({ kind: 'refresh' });
}

async function openApp(url = '/app/') {
  const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const app = open.find((w) => new URL(w.url).pathname.startsWith('/app'));
  if (app) {
    if (url !== '/app/' && 'navigate' in app) return app.navigate(url).then((w) => w?.focus());
    app.postMessage({ kind: 'refresh' });
    return app.focus();
  }
  return self.clients.openWindow(url);
}
