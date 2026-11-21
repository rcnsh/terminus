import { html, render, useEffect, useState } from '/assets/ui.js';
import { t } from '/account/dom.js';

const still = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

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

const install = document.getElementById('install');
document.addEventListener('pointerdown', (e) => {
  if (install.open && !install.contains(e.target)) install.open = false;
});
install.addEventListener('focusout', (e) => {
  if (e.relatedTarget && !install.contains(e.relatedTarget)) install.open = false;
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !install.open) return;
  const inside = install.contains(document.activeElement);
  install.open = false;
  if (inside) install.querySelector('summary').focus();
});

{
  const button = document.getElementById('dl-button');
  const menu = document.getElementById('dl-menu');
  const close = () => menu.hidePopover();
  if (typeof menu.showPopover !== 'function') {
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
      close();
      install.open = true;
      install.querySelector('ol').scrollIntoView({ behavior: still() ? 'auto' : 'smooth', block: 'center' });
    });
  }
}
