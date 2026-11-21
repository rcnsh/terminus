import { html, render } from './ui.js';
import { DriveToggle, Horizon } from '/account/sky.js';
import { LIVERY } from '/account/livery.js';

export function drawHorizon(el, { low = false, stop = false, bus = null, shuttle = true, drive = false } = {}) {
  const colours = drive ? LIVERY.map(([, color]) => color) : null;
  render(
    html`<${Horizon} on=${null} low=${low} stop=${stop} bus=${bus} shuttle=${shuttle} drive=${colours} />${drive && html`<${DriveToggle} />`}`,
    el,
  );
}

function fromMarkup(el) {
  const [color, far, live] = (el.dataset.bus ?? '').split(' ');
  return {
    low: 'low' in el.dataset,
    stop: 'stop' in el.dataset,
    bus: color ? { color, far: Number(far ?? 0.5), live: live === 'live' } : null,
    shuttle: el.dataset.shuttle !== 'no',
    drive: 'drive' in el.dataset,
  };
}

for (const el of document.querySelectorAll('[data-horizon]')) drawHorizon(el, fromMarkup(el));

const top = document.body.firstElementChild;
if (top?.classList.contains('sky-panel')) {
  const root = document.documentElement;
  const paint = () => {
    const high = window.scrollY <= (root.scrollHeight - window.innerHeight) / 2;
    root.style.backgroundColor = high ? getComputedStyle(top).getPropertyValue('--s0') : '';
  };
  paint();
  let idle;
  addEventListener(
    'scroll',
    () => {
      clearTimeout(idle);
      const edge = window.scrollY <= 0 || window.scrollY >= root.scrollHeight - window.innerHeight - 1;
      if (edge) paint();
      else idle = setTimeout(paint, 150);
    },
    { passive: true },
  );
  addEventListener('resize', paint);
  new MutationObserver(paint).observe(root, { attributes: true, attributeFilter: ['data-sky', 'data-theme'] });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', paint);
}
