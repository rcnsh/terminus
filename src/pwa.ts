/** Manifest, service worker and icon. Served inline so the Worker is the
 *  whole deployment -- no static asset pipeline to keep in sync. */

export const MANIFEST = JSON.stringify({
  name: 'NUS Bus',
  short_name: 'Bus',
  start_url: '/',
  display: 'standalone',
  background_color: '#0b0d10',
  theme_color: '#0b0d10',
  icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }],
});

export const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
<rect width="64" height="64" rx="14" fill="#0b0d10"/>
<rect x="16" y="12" width="32" height="34" rx="6" fill="#ff7a1a"/>
<rect x="20" y="18" width="24" height="12" rx="3" fill="#0b0d10"/>
<circle cx="24" cy="38" r="3" fill="#0b0d10"/><circle cx="40" cy="38" r="3" fill="#0b0d10"/>
<rect x="19" y="46" width="6" height="6" rx="2" fill="#ff7a1a"/>
<rect x="39" y="46" width="6" height="6" rx="2" fill="#ff7a1a"/>
</svg>`;

/**
 * The push handler fetches /next with NO coordinates.
 *
 * navigator.geolocation does not exist in a service worker context, so the
 * morning push is necessarily origin-based: it answers for the configured
 * trip's `from` stop. That is not a limitation to work around, it is why
 * /next has to work with no coordinates at all -- zero location permissions.
 */
export const SERVICE_WORKER = `
self.addEventListener('install', (e) => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

// No shell caching on purpose: a cached shell buys nothing here and adds a
// stale-version failure mode to a page whose whole job is being current.

self.addEventListener('push', (event) => {
  event.waitUntil((async () => {
    let label = 'NUS Bus';
    let body = 'Tap to check';
    try {
      const res = await fetch('/next?src=push&t=' + Date.now(), { cache: 'no-store' });
      const a = await res.json();
      label = a.label || label;
      body = a.detail || body;
    } catch (err) {
      body = 'Could not reach the bus API';
    }
    await self.registration.showNotification(label, {
      body,
      tag: 'nusbus',
      renotify: true,
      icon: '/icon.svg',
      badge: '/icon.svg',
      data: { url: '/' },
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) { if ('focus' in c) return c.focus(); }
    return self.clients.openWindow('/');
  })());
});
`;
