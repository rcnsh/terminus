// Light, dark, or the device's own setting ("auto"), chosen in Settings ›
// Appearance and kept by this browser only.
//
// Loaded in <head>, before the page draws, so it never flashes the other
// theme: it sets <html data-theme>, which site.css reads. Anything else that
// follows the device's dark mode by itself (the installed app's bar colour,
// pictures with a dark version) is pointed at the chosen theme too.
(() => {
  const KEY = 'terminus-theme';
  const system = window.matchMedia('(prefers-color-scheme: dark)');

  /** auto, light or dark: what this browser was set to. */
  function pref() {
    try {
      const v = localStorage.getItem(KEY);
      return v === 'light' || v === 'dark' ? v : 'auto';
    } catch {
      return 'auto';
    }
  }

  /** <meta name="theme-color"> and <source> with a dark-mode media query: on for the chosen theme only. */
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
  // The <source>s are further down the page than this script.
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => follow(pref()));

  window.theme = {
    pref,
    /** Whether the page is dark now, chosen or by the device. */
    dark: () => (pref() === 'auto' ? system.matches : pref() === 'dark'),
    /** Sets this browser's theme and redraws in it; `themechange` tells the map. */
    set(p) {
      try {
        if (p === 'auto') localStorage.removeItem(KEY);
        else localStorage.setItem(KEY, p);
      } catch {
        // Storage blocked: this page only.
      }
      apply(p);
      document.dispatchEvent(new CustomEvent('themechange'));
    },
  };
})();
