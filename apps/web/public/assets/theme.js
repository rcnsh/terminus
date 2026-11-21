(() => {
  const KEY = 'terminus-theme';
  const system = window.matchMedia('(prefers-color-scheme: dark)');

  function pref() {
    try {
      const v = localStorage.getItem(KEY);
      return v === 'light' || v === 'dark' ? v : 'auto';
    } catch {
      return 'auto';
    }
  }

  function follow(p) {
    for (const node of document.querySelectorAll('meta[media*="prefers-color-scheme"], source[media*="prefers-color-scheme"]')) {
      node.dataset.media ??= node.media;
      node.media = p === 'auto' ? node.dataset.media : node.dataset.media.includes('dark') === (p === 'dark') ? 'all' : 'not all';
    }
  }

  function apply(p) {
    if (p === 'auto') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = p;
    follow(p);
  }

  apply(pref());
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => follow(pref()));

  window.theme = {
    pref,
    dark: () => (pref() === 'auto' ? system.matches : pref() === 'dark'),
    set(p) {
      try {
        if (p === 'auto') localStorage.removeItem(KEY);
        else localStorage.setItem(KEY, p);
      } catch {}
      apply(p);
      document.dispatchEvent(new CustomEvent('themechange'));
    },
  };
})();
