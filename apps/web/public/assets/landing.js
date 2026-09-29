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
      const details = document.getElementById('install');
      details.open = true;
      details.scrollIntoView({ behavior: still ? 'auto' : 'smooth', block: 'center' });
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

  const set = (pct) => {
    const x = Math.max(4, Math.min(96, pct));
    split.style.setProperty('--x', `${x}%`);
    knob.setAttribute('aria-valuenow', String(Math.round(x)));
    knob.setAttribute('aria-valuetext', `${Math.round(100 - x)}% dark`);
  };
  // Where the seam rests: the middle, or where the interesting part is.
  const rest = Number(split.dataset.x) || 50;
  set(rest);

  // The seam is slanted: put it under the pointer at the pointer's height.
  const tilt = () => parseFloat(getComputedStyle(split).getPropertyValue('--tilt')) || 0;
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
    const step = { ArrowLeft: -5, ArrowRight: 5, Home: -100, End: 100 }[e.key];
    if (step === undefined) return;
    e.preventDefault();
    split.classList.remove('sweep');
    set(now + step);
  });

  // Without @property support the sweep is a jump, which is fine.
  if (!still && 'IntersectionObserver' in window) {
    set(100);
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
