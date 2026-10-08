// The horizon and the night on the website's own pages (sky.css), drawn by
// sky.js as on Now; the hour is already on the page (sky-phase.js). A page
// asks for them in its markup, so it needs no script of its own for them:
//   <section class="sky-panel">          the sky, at this hour
//     <div data-stars></div>             the stars and the moon, at night
//     <div data-horizon></div>           the hills, the road and a shuttle
// data-horizon takes data-low (just the hills), data-stop (your stop's
// sign), data-bus="#34a853 0.4 live" (a bus coming up to it: its colour, how
// far, and live or a timetable guess), data-shuttle="no" (an empty road) and
// data-drive (shuttles drive across, over and over, each a service at random).
// A page's script can draw one itself with drawHorizon().
import { html, render } from './ui.js';
import { DriveToggle, Horizon, NightSky } from '/account/sky.js';
import { LIVERY } from '/account/livery.js';

/**
 * Draws the horizon into `el`. `bus`: { color, far (0 at the stop to 1), live };
 * `drive`: shuttles of every service drive by instead.
 */
export function drawHorizon(el, { low = false, stop = false, bus = null, shuttle = true, drive = false } = {}) {
  const colours = drive ? LIVERY.map(([, color]) => color) : null;
  // Driving shuttles come with a button to pause them.
  render(html`<${Horizon} on=${null} low=${low} stop=${stop} bus=${bus} shuttle=${shuttle} drive=${colours} />${drive && html`<${DriveToggle} />`}`, el);
}

/** A horizon's settings from its markup (see above). */
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
for (const el of document.querySelectorAll('[data-stars]')) render(html`<${NightSky} />`, el);

// Scrolled past the top, a laptop's trackpad (and a phone) pulls the page
// down and shows the colour behind it, which would be the page's own (near
// black, or white): a band above the sky. Behind the top half of a page that
// opens under the sky, that colour is the sky's top instead, so the sky
// carries on; past halfway down it stays the page's, under the footer.
const top = document.body.firstElementChild;
if (top?.classList.contains('sky-panel')) {
  const root = document.documentElement;
  const paint = () => {
    const high = window.scrollY <= (root.scrollHeight - window.innerHeight) / 2;
    root.style.backgroundColor = high ? getComputedStyle(top).getPropertyValue('--s0') : '';
  };
  paint();
  addEventListener('scroll', paint, { passive: true });
  addEventListener('resize', paint);
  // The sky's colour changes with the hour (sky-phase.js) and the theme.
  new MutationObserver(paint).observe(root, { attributes: true, attributeFilter: ['data-sky', 'data-theme'] });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', paint);
}
