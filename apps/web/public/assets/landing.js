// The landing page: the page itself is plain HTML (it should read without
// any script); this adds the live parts. The Worker writes in the version
// next to the download buttons and Account for someone signed in
// (src/site/landing.ts), so neither changes once the page is up; the version is
// asked for here only when it couldn't. The sky's horizon and night are
// sky-page.js's. The install steps' and the download menu's placement are
// behaviours on the page's own markup, so they stay plain functions.

import { html, render, useEffect, useState } from '/assets/ui.js';
import { t } from '/account/dom.js';

/** Less motion asked for, read when it's needed: it can change during a visit. */
const still = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** " Version 2.1.0.": the current release, from its manifest. */
function Version() {
  const [v, setV] = useState('');
  useEffect(() => {
    fetch('/download/latest.json')
      .then((r) => (r.ok ? r.json() : null))
      .then((l) => l?.version && setV(` ${t('Version {0}.', l.version)}`))
      .catch(() => {});
  }, []);
  return v;
}
for (const id of ['version', 'dl-version']) {
  const box = document.getElementById(id);
  if (box && !box.firstChild) render(html`<${Version} />`, box);
}

// "How to install" opens as a card over the space under the hero (its CSS is
// index.html's), so opening it moves nothing. Like the download menu, a click
// anywhere else or Esc closes it.
const install = document.getElementById('install');
document.addEventListener('click', (e) => {
  if (install.open && !install.contains(e.target)) install.open = false;
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !install.open) return;
  install.open = false;
  install.querySelector('summary').focus();
});

// The header's download menu, placed under its button. It closes on scroll
// rather than drifting away from the button it belongs to.
{
  const button = document.getElementById('dl-button');
  const menu = document.getElementById('dl-menu');
  const close = () => menu.hidePopover();
  if (typeof menu.showPopover !== 'function') {
    // No popover support: the button goes to the download buttons instead.
    button.addEventListener('click', () => window.scrollTo({ top: 0, behavior: still() ? 'auto' : 'smooth' }));
  } else {
    menu.addEventListener('beforetoggle', (e) => {
      const open = e.newState === 'open';
      button.setAttribute('aria-expanded', String(open));
      if (open) {
        const r = button.getBoundingClientRect();
        menu.style.top = `${r.bottom + 6}px`;
        menu.style.right = `${Math.max(16, document.documentElement.clientWidth - r.right)}px`;
        window.addEventListener('scroll', close, { once: true, passive: true });
        window.addEventListener('resize', close, { once: true });
      } else {
        window.removeEventListener('scroll', close);
        window.removeEventListener('resize', close);
      }
    });
    document.getElementById('dl-install').addEventListener('click', (e) => {
      e.preventDefault();
      // Not the click that closes the card as it bubbles.
      e.stopPropagation();
      close();
      install.open = true;
      install.querySelector('ol').scrollIntoView({ behavior: still() ? 'auto' : 'smooth', block: 'center' });
    });
  }
}
