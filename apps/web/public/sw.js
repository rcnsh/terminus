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

const SHELL = 'shell-v4';
const DATA = 'data-v2';
const SHELL_FILES = [
  '/app/',
  '/app/app.js',
  '/app/offline.js',
  '/app/app.css',
  '/account/dom.js',
  '/account/preview.js',
  '/account/account.css',
  '/assets/site.css',
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
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL && k !== DATA).map((k) => caches.delete(k))))
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
});

/** Bumped whenever the kept replies are emptied: a reply fetched before that is not kept. */
let dataGeneration = 0;
function forgetData() {
  dataGeneration++;
  return caches.delete(DATA);
}

async function networkFirst(req) {
  const generation = dataGeneration;
  const cache = await caches.open(DATA);
  // One kept reply per route, place, clock style and language: not one per
  // location, which would keep a reply for every few metres walked.
  const url = new URL(req.url);
  const keyed = new URLSearchParams();
  for (const k of ['place', 'h12']) if (url.searchParams.get(k)) keyed.set(k, url.searchParams.get(k));
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
  // No buttons: nothing asks what happened, and plans ("Not going") are made
  // in the app. A tap opens it.
  return self.registration.showNotification(title, {
    body: where ? `${body}\n${where}` : body,
    tag: 'trip',
    renotify: urgent,
    silent: !urgent,
    icon: '/assets/icons/icon-192.png',
    data: { url: '/app/' },
  });
}

self.addEventListener('notificationclick', (event) => {
  // No buttons any more: a tap opens the app.
  event.notification.close();
  event.waitUntil(openApp());
});

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
