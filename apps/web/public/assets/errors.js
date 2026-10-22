// Error reports from the web app and the account page (POST /api/errors,
// apps/api/src/ops/apperrors.ts): what broke, never who for. No cookie goes
// with it, nor anything kept in this browser; the server scrubs the message
// and stack and fills in the website's version. A classic script, loaded
// before the modules, so an error while they load is caught too.
//
// Account › Your data, "Send crash reports", turns it off in this browser
// (localStorage `terminus.errorReports` = "off").

(() => {
  const KEY = 'terminus.errorReports';
  /** Reports one page sends at most: a loop that throws mustn't flood the server. */
  const MAX = 5;
  const sent = new Set();

  const off = () => {
    try {
      return localStorage.getItem(KEY) === 'off';
    } catch {
      return false;
    }
  };

  /** The browser and its major version, e.g. "Chrome 140": nothing finer. */
  const browser = () => {
    const ua = navigator.userAgent;
    // The most particular first: Edge's names Chrome too, and Chrome's and Firefox's on iOS name Safari.
    for (const [name, re] of [
      ['Edge', /Edg(?:A|iOS)?\/(\d+)/],
      ['Firefox', /(?:Firefox|FxiOS)\/(\d+)/],
      ['Chrome', /(?:Chrome|CriOS)\/(\d+)/],
      ['Safari', /Version\/(\d+).*Safari/],
    ]) {
      const m = re.exec(ua);
      if (m) return `${name} ${m[1]}`;
    }
    return '';
  };

  /** Only errors in terminus's own scripts: an extension's or another site's aren't ours to fix. */
  const ours = (stack, file) => {
    const where = `${file ?? ''}\n${stack ?? ''}`;
    return where.includes(location.origin) && !/(chrome|moz|safari)-extension:/.test(where);
  };

  function report(err, file) {
    if (off() || sent.size >= MAX) return;
    const type = (err && (err.name || err.constructor?.name)) || 'Error';
    const message = String(err?.message ?? err ?? '');
    const stack = typeof err?.stack === 'string' ? err.stack : '';
    if (!ours(stack, file)) return;
    const once = `${type}|${message}`;
    if (sent.has(once)) return;
    sent.add(once);
    fetch('/api/errors', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'omit',
      keepalive: true,
      body: JSON.stringify({
        platform: 'web',
        version: 'web',
        os: browser(),
        type,
        message: message.slice(0, 2000),
        stack: stack.slice(0, 20_000),
        fatal: false,
      }),
    }).catch(() => {});
  }

  addEventListener('error', (e) => {
    // A script or image that failed to load is an event with no error: not a bug here.
    if (e.error || e.message) report(e.error ?? { name: 'Error', message: e.message, stack: '' }, e.filename);
  });
  addEventListener('unhandledrejection', (e) => report(e.reason));

  /** For the settings: whether reports are sent, and to turn them on or off. */
  globalThis.terminusErrorReports = {
    get on() {
      return !off();
    },
    set(on) {
      try {
        if (on) localStorage.removeItem(KEY);
        else localStorage.setItem(KEY, 'off');
      } catch {}
    },
  };
})();
