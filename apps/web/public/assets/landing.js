// The current version next to the download buttons, from the release manifest.
fetch('/download/latest.json')
  .then((r) => (r.ok ? r.json() : null))
  .then((l) => {
    if (!l?.version) return;
    document.getElementById('version').textContent = ` Version ${l.version}.`;
    document.getElementById('dl-version').textContent = ` Version ${l.version}.`;
  })
  .catch(() => {});

// Signed in already: the header says Account, not Sign in.
fetch('/me', { credentials: 'same-origin' })
  .then((r) => {
    if (r.ok) document.getElementById('account-link').textContent = 'Account';
  })
  .catch(() => {});

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

// Light | dark split images: a handle on each, drag or arrow keys to move the
// seam; on first view it sweeps in from all-light, unless motion is reduced.
const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
for (const split of document.querySelectorAll('[data-split]')) {
  const seam = document.createElement('div');
  seam.className = 'seam';
  const knob = document.createElement('div');
  knob.className = 'knob';
  knob.tabIndex = 0;
  knob.setAttribute('role', 'slider');
  knob.setAttribute('aria-label', 'Compare light and dark');
  knob.setAttribute('aria-valuemin', '0');
  knob.setAttribute('aria-valuemax', '100');
  knob.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 3.5a8.5 8.5 0 0 1 0 17z" fill="currentColor"/></svg>';
  const light = document.createElement('span');
  light.className = 'tag l';
  light.textContent = 'Light';
  const dark = document.createElement('span');
  dark.className = 'tag d';
  dark.textContent = 'Dark';
  split.append(seam, light, dark, knob);

  // The seam leans by --tilt, so it has to pass that far beyond either edge
  // before the image is all light or all dark. The drag stays one to one and
  // horizontal: dragging a little past the phone's edge gets you there.
  const tilt = () => parseFloat(getComputedStyle(split).getPropertyValue('--tilt')) || 0;
  const set = (pct) => {
    const t = tilt();
    const x = Math.max(-t, Math.min(100 + t, pct));
    split.style.setProperty('--x', `${x}%`);
    const full = x >= 100 + t ? 'light' : x <= -t ? 'dark' : '';
    if (full) split.dataset.full = full;
    else delete split.dataset.full;
    const dark = Math.round(((100 + t - x) / (100 + 2 * t)) * 100);
    knob.setAttribute('aria-valuenow', String(100 - dark));
    knob.setAttribute('aria-valuetext', full ? `all ${full}` : `${dark}% dark`);
  };
  // Where the seam rests: the middle, or where the interesting part is.
  const rest = Number(split.dataset.x) || 50;
  set(rest);

  // The seam is slanted: put it under the pointer at the pointer's height.
  const fromPointer = (e) => {
    const r = split.getBoundingClientRect();
    const t = (e.clientY - r.top) / r.height;
    set(((e.clientX - r.left) / r.width) * 100 - tilt() * (1 - 2 * t));
  };
  split.addEventListener('pointerdown', (e) => {
    split.classList.remove('sweep');
    split.classList.add('dragging');
    split.setPointerCapture(e.pointerId);
    fromPointer(e);
  });
  split.addEventListener('pointermove', (e) => split.classList.contains('dragging') && fromPointer(e));
  for (const end of ['pointerup', 'pointercancel']) split.addEventListener(end, () => split.classList.remove('dragging'));
  knob.addEventListener('keydown', (e) => {
    const now = parseFloat(split.style.getPropertyValue('--x')) || rest;
    const step = { ArrowLeft: -5, ArrowRight: 5, Home: -200, End: 200 }[e.key];
    if (step === undefined) return;
    e.preventDefault();
    split.classList.remove('sweep');
    set(now + step);
  });

  // Without @property support the sweep is a jump, which is fine.
  if (!still && 'IntersectionObserver' in window) {
    set(100 + tilt());
    const io = new IntersectionObserver((entries) => {
      if (!entries[0].isIntersecting) return;
      io.disconnect();
      split.classList.add('sweep');
      requestAnimationFrame(() => set(rest));
      split.addEventListener('transitionend', () => split.classList.remove('sweep'), { once: true });
    }, { threshold: 0.45 });
    io.observe(split);
  }
}
