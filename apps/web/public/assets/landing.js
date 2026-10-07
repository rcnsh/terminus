// The landing page: the page itself is plain HTML (it should read without
// any script); this adds the live parts. The Worker writes in the version
// next to the download buttons and Account for someone signed in
// (src/landing.ts), so neither changes once the page is up; the version is
// asked for here only when it couldn't. The sky's horizon and night are
// sky-page.js's. The install steps' and the download menu's placement are
// behaviours on the page's own markup, so they stay plain functions.

import { html, render, useEffect, useState } from '/assets/ui.js';
import { t } from '/account/dom.js';

const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

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

// The hero's text is centred beside the phone, so opening "How to install"
// would re-centre it and shove the heading and buttons up, and the taller row
// would drag the phone and everything below it down. While it's open, both
// columns are pinned where they were and the row keeps its height, so the
// steps spill into the empty space under the hero and nothing moves. If they
// would reach the next heading (narrow two-column widths wrap more), the row
// grows instead, pushing only what's below. All of it happens in the click,
// before anything is painted.
const install = document.getElementById('install');
const twoColumns = window.matchMedia('(min-width: 861px)');
const setInstall = (open) => {
  const hero = document.querySelector('.hero');
  const cols = [...hero.children];
  const release = () => {
    hero.style.gridTemplateRows = '';
    for (const c of cols) {
      c.style.alignSelf = '';
      c.style.marginTop = '';
    }
  };
  if (!open || !twoColumns.matches) {
    release();
    install.open = open;
    return;
  }
  const padTop = parseFloat(getComputedStyle(hero).paddingTop);
  const start = hero.getBoundingClientRect().top + padTop;
  const tops = cols.map((c) => c.getBoundingClientRect().top - start);
  const rowH = hero.getBoundingClientRect().height - padTop - parseFloat(getComputedStyle(hero).paddingBottom);
  cols.forEach((c, i) => {
    c.style.alignSelf = 'start';
    c.style.marginTop = `${tops[i]}px`;
  });
  hero.style.gridTemplateRows = `${rowH}px`;
  install.open = true;
  // Reading layout here forces it, still before the next paint.
  const next = hero.nextElementSibling;
  if (next && cols[0].getBoundingClientRect().bottom > next.getBoundingClientRect().top - 16) hero.style.gridTemplateRows = '';
};
install.querySelector('summary').addEventListener('click', (e) => {
  e.preventDefault();
  setInstall(!install.open);
});
// A held layout is meaningless once the layout changes.
twoColumns.addEventListener('change', () => {
  const open = install.open;
  setInstall(false);
  install.open = open;
});

// The header's download menu, placed under its button. It closes on scroll
// rather than drifting away from the button it belongs to.
{
  const button = document.getElementById('dl-button');
  const menu = document.getElementById('dl-menu');
  const close = () => menu.hidePopover();
  if (typeof menu.showPopover !== 'function') {
    // No popover support: the button goes to the download buttons instead.
    button.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
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
      close();
      if (!install.open) setInstall(true);
      install.scrollIntoView({ behavior: still ? 'auto' : 'smooth', block: 'center' });
    });
  }
}
