(() => {
  const KEY = 'terminus.errorReports';
  const MAX = 5;
  const sent = new Set();

  const off = () => {
    try {
      return localStorage.getItem(KEY) === 'off';
    } catch {
      return false;
    }
  };

  const browser = () => {
    const ua = navigator.userAgent;
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
    if (e.error || e.message) report(e.error ?? { name: 'Error', message: e.message, stack: '' }, e.filename);
  });
  addEventListener('unhandledrejection', (e) => report(e.reason));

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
