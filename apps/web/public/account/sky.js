// The sky over Now, the web app's first tab: by the hour, from dawn to
// night, ending on a horizon of the campus's hills with a bus on the road.
// It says what time of day it is, not what the weather is: no sun or clouds
// over the words, only a low sun behind the hills at dawn, in the golden hour
// and at dusk, and the stars and the moon at night. There is one sky for the
// whole tab, so it stays as the chips switch: whatever the card area shows
// ends on a <Horizon>, and the sky reaches down to it. The hour only picks
// classes (app.css draws the colours). Android draws the same scene from the
// same numbers (NightSky.kt).
import { html, reducedMotion, store, useEffect, useLayoutEffect, useRef, useState, useStore } from '../assets/ui.js';
import { PHASES, parallax } from './daylight.js';

export { phaseAt } from './daylight.js';

/** Where the stars sit: across (0–1), down (0–1 of the room above the words), and how bright. */
const STARS = [
  [0.06, 0.3, 0.7], [0.17, 0.62, 0.5], [0.29, 0.18, 0.8], [0.38, 0.8, 0.4], [0.47, 0.42, 0.6], [0.55, 0.1, 0.5], [0.63, 0.68, 0.45],
  [0.72, 0.28, 0.7], [0.84, 0.88, 0.4], [0.92, 0.5, 0.55], [0.11, 0.95, 0.35], [0.33, 1, 0.4], [0.58, 0.98, 0.3],
];

/**
 * A few stars and a crescent moon. Fixed, so they never twinkle into a
 * distraction. `from`: only the stars across from there (0–1), clear of a
 * title on the left.
 */
export const NightSky = ({ from = 0 }) => html`
  <span class="night-sky" aria-hidden="true">
    ${STARS.map(([x, y, a], i) => x >= from && html`<span class="star" key=${i} style=${{ left: `${x * 100}%`, top: `calc(${(y * 0.82).toFixed(3)} * var(--room, 108px) + 4px)`, opacity: a }}></span>`)}
    <span class="moon"></span>
  </span>
`;

/**
 * What's up in the short room above the words: at night, the stars and the
 * moon; by day, nothing (the sun stays low, behind the hills). `band`: beside
 * a page's title instead (Settings' pages), the moon on the right, with stars
 * only there.
 */
export const Celestial = ({ band = false }) => html`
  <span class="celestial" aria-hidden="true">
    <${NightSky} from=${band ? 0.5 : 0} />
  </span>
`;

/**
 * The hills along the horizon, more or less Kent Ridge: how far down the
 * strip (92 px) each is, `x` px across. Fixed waves in pixels, so a wider
 * page shows more hills rather than stretched ones.
 */
const farY = (x) => 30 + 6 * Math.sin(x / 47 + 0.6) + 4 * Math.sin(x / 19 + 2.1);
const nearY = (x) => 52 + 3 * Math.sin(x / 61 + 1.3) + 1.5 * Math.sin(x / 27);
/** The lowest point of the far hills between `lo` and `hi` px, where the city shows above them. */
const dip = (lo, hi) => {
  let best = lo;
  for (let x = lo; x <= hi; x += 2) if (farY(x) > farY(best)) best = x;
  return best;
};
const ridge = (w, y) => {
  let d = `M0 92L0 ${y(0).toFixed(1)}`;
  for (let x = 4; x < w + 4; x += 4) d += `L${x} ${y(x).toFixed(1)}`;
  return `${d}L${w} 92Z`;
};

/** The flag's five stars, in a ring around its middle (px). */
const STARS5 = [0, 1, 2, 3, 4].map((i) => [0.85 * Math.sin((i * 2 * Math.PI) / 5), -0.85 * Math.cos((i * 2 * Math.PI) / 5)]);

/**
 * The horizons on Now, for the sky to reach down to the one on screen. A
 * hidden tab stays drawn, and a card can hand over to the next, so there can
 * be more than one.
 */
const grounds = { now: store([]) };

/**
 * A single-decker from the side, heading right: 38 by 12, standing on the
 * road 1 below. The air-con on its roof, a row of windows, the driver's,
 * the door ahead of the front wheel, the windscreen raking back to the
 * headlight, a tail light, and the wheels in their arches. `fill` and `band`
 * are the classes of its paint and of the stripe along the bottom; window
 * `dim` (0 to 3) has its light off.
 */
const BUS_BODY = 'M1.5 0H33Q36 0 36.9 2.6L38 8.5V10.5Q38 12 36.5 12H1.5Q0 12 0 10.5V1.5Q0 0 1.5 0Z';
const arch = (x) => `M${x - 3.2} 12A3.2 3.2 0 0 1 ${x + 3.2} 12Z`;
const busParts = (fill, band, dim = -1) => html`
  <rect class=${`${fill} roof`} x="5" y="-1.6" width="14" height="1.9" rx="0.8" />
  <path class=${fill} d=${BUS_BODY} />
  <rect class=${band} y="9.5" width="38" height="2" />
  ${[2.5, 8.5, 14.5, 20.5].map((x, i) => html`<rect class=${i === dim ? 'win dim' : 'win'} x=${x} y="2.5" width="5" height="4" rx="0.8" />`)}
  <rect class="win" x="26.5" y="2.5" width="4.5" height="4" rx="0.8" />
  <rect class="win" x="32" y="2.5" width="2.8" height="8.2" rx="0.6" />
  <path class="win" d="M35.6 2.5Q36.2 2.5 36.4 3.2L37.1 7.2H35.6Z" />
  <rect class="lamp" x="36.6" y="8.3" width="1.4" height="1.3" rx="0.5" />
  <rect class="tail" y="7.4" width="0.9" height="1.8" rx="0.4" />
  ${[7.5, 26].map((x) => html`<path class="arch" d=${arch(x)} /><circle class="tyre" cx=${x} cy="12" r="2.2" /><circle class="hub" cx=${x} cy="12" r="0.8" />`)}
`;

/** How much bigger than its numbers the horizon with the road is drawn: the bus and your stop are the picture. */
const ROAD_SCALE = 1.25;

/**
 * Where the sky ends: the hills, a building or two, rain trees, Singapore's
 * flag by the road, and Marina Bay Sands far off in the city. The near hill
 * is the page's own colour, so the sky meets the ground instead of fading.
 * On the road, either your stop's sign (`stop`) with your bus (`bus`:
 * `color`, `far` from 0 at the stop to 1 a quarter of an hour away, and
 * `live`) coming up to it, or a shuttle going by (`shuttle`). It's a
 * picture with no words: drawn this small, they were too hard to read, so
 * the card says them under it (journey.js RoadLine).
 * A timetable guess is an outline, never a filled bus, so it doesn't pass
 * for live. The sun is only ever low behind the hills: rising at dawn, low in
 * the golden hour, setting at dusk (app.css shows the hour's). `on`: 'now',
 * for Now's sky to reach down to it, or null for one in a sky of its own.
 * `low`: just the hills, the trees and the city, with no road and drawn at
 * its own size (the band at the top of Settings' pages); otherwise it's
 * drawn ROAD_SCALE times bigger. `drive`: the shuttle drives across the
 * road and round again (the website's landing page, sky.css), where it
 * otherwise stands; it stands still for anyone who asks for less motion.
 */
export function Horizon({ stop = false, bus = null, shuttle = true, drive = false, on = 'now', low = false }) {
  const box = useRef(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = box.current;
    const ground = on && grounds[on];
    ground?.set([...ground.get(), el]);
    const seen = new ResizeObserver(() => setW(Math.round(el.clientWidth)));
    seen.observe(el);
    return () => {
      seen.disconnect();
      ground?.set(ground.get().filter((x) => x !== el));
    };
  }, []);
  // The low one: the strip from the city's top to the near hill (y 6 to 58).
  const [top, h] = low ? [6, 52] : [0, 92];
  const k = low ? 1 : ROAD_SCALE;
  // How wide the strip is in its own numbers: the page's width, scaled down.
  const vw = Math.round(w / k);
  const at = (f) => Math.round(vw * f);
  // Your stop's sign left of the flag; the flag right of anything on the
  // road; the city clear of the flag and the edge.
  const sx = stop ? Math.min(at(0.7), at(0.74) - 7) : 0;
  const [b1, b2, flag] = [at(0.18), at(0.62), at(0.76)];
  const mbs = dip(Math.max(at(0.8) - 40, flag + 30), Math.min(at(0.8) + 40, vw - 29));
  const city = farY(mbs) + 3;
  const pole = nearY(flag);
  // The bus pulls up just short of the sign.
  const bx = bus ? Math.round(sx - 44 - Math.min(1, Math.max(0, bus.far)) * (sx - 56)) : 0;
  const passing = at(0.58) - 19;
  return html`
    <div class=${low ? 'horizon low' : 'horizon'} ref=${box} aria-hidden="true">
      ${w > 0 &&
      html`<svg width=${w} height=${Math.round(h * k)} viewBox=${`0 ${top} ${vw} ${h}`}>
        <g class="depth">
        <circle class="sun dawn" cx=${at(0.3)} cy="42" r="16" />
        <circle class="sun golden" cx=${at(0.36)} cy="36" r="16" />
        <circle class="sun dusk" cx=${at(0.5)} cy="40" r="26" />
        ${mbs + 25 <= vw &&
        html`<g class="city">
          ${[-13, -2, 9].map((x) => html`<path d=${`M${mbs + x} ${city}L${mbs + x + 1} ${city - 26}H${mbs + x + 5}L${mbs + x + 6} ${city}Z`} />`)}
          <path d=${`M${mbs - 15} ${city - 28}L${mbs + 25} ${city - 29.2}L${mbs + 23} ${city - 26}H${mbs - 14}Z`} />
        </g>`}
        <path class="far" d=${ridge(vw, farY)} />
        <rect class="far" x=${b1 - 8} y=${farY(b1) - 14} width="16" height="20" />
        <rect class="lit dim" x=${b1 - 3} y=${farY(b1) - 9} width="3" height="3" />
        <rect class="far" x=${b2 - 13} y=${farY(b2) - 22} width="26" height="28" />
        <rect class="lit" x=${b2 - 5} y=${farY(b2) - 16} width="3" height="3" />
        <rect class="lit dim" x=${b2 + 3} y=${farY(b2) - 8} width="3" height="3" />
        </g>
        ${[0.06, 0.45, 0.9].map((f) => {
          // A rain tree: a trunk forking low under a wide, flat crown.
          const c = at(f);
          const g = nearY(c);
          return html`<g class="tree">
            <path d=${`M${c - 1.5} ${g + 2}V${g - 7}L${c - 7} ${g - 13}H${c - 4.5}L${c} ${g - 9}L${c + 4.5} ${g - 13}H${c + 7}L${c + 1.5} ${g - 7}V${g + 2}Z`} />
            <ellipse cx=${c} cy=${g - 18} rx="21" ry="5.5" />
            <ellipse cx=${c - 8} cy=${g - 21.5} rx="11" ry="4.5" />
            <ellipse cx=${c + 8} cy=${g - 22} rx="12" ry="4.5" />
          </g>`;
        })}
        <line class="pole" x1=${flag} y1=${pole + 2} x2=${flag} y2=${pole - 24} />
        <rect class="flag-red" x=${flag + 0.6} y=${pole - 24} width="12" height="4" />
        <rect class="flag-white" x=${flag + 0.6} y=${pole - 20} width="12" height="4" />
        <circle class="flag-white" cx=${flag + 3.2} cy=${pole - 22} r="1.5" />
        <circle class="flag-red" cx=${flag + 3.8} cy=${pole - 22} r="1.3" />
        ${STARS5.map(([x, y]) => html`<circle class="flag-white" cx=${flag + 5.2 + x} cy=${pole - 22 + y} r="0.35" />`)}
        <path class="near" d=${ridge(vw, nearY)} />
        ${!low && html`<line class="road" x1="0" y1="70" x2=${vw} y2="70" />`}
        ${!low &&
        stop &&
        html`<g class="sign">
          <line x1=${sx} y1="70" x2=${sx} y2="44" />
          <rect x=${sx - 6.5} y="33" width="13" height="13" rx="2.5" />
          <rect class="mark" x=${sx - 3.5} y="35.5" width="7" height="7.5" rx="1.5" />
          <rect x=${sx - 2.5} y="36.5" width="5" height="3" rx="0.5" />
        </g>`}
        ${!low &&
        bus &&
        html`<g class=${bus.live ? 'coming' : 'coming guess'} transform=${`translate(${bx} 57)`} style=${{ '--svc': bus.color }}>
            ${busParts('body', 'band')}
          </g>`}
        ${!low &&
        !bus &&
        shuttle &&
        html`<g transform=${`translate(${drive ? 0 : passing} 57)`}>
          <g class=${drive ? 'driving' : null} style=${drive ? { '--rest': `${passing}px`, '--to': `${vw + 20}px`, animationDuration: `${Math.round(vw / 45)}s` } : undefined}>
            <path class="beam" d="M38 9L60 6L60 13Z" />
            ${busParts('bus', 'stripe', 3)}
          </g>
        </g>`}
      </svg>`}
    </div>
  `;
}

/**
 * Keeps `name` (a CSS variable on the page) at the bottom of `on`'s horizon,
 * down the page, while it's on screen; kept as it was while it's hidden or
 * between one horizon and the next.
 */
function useSkyEnd(on, name) {
  const els = useStore(grounds[on]);
  useLayoutEffect(() => {
    if (!els.length) return;
    const body = document.body;
    const place = () => {
      // The one on screen: hidden ones (another tab, a closed page) have no size.
      const r = els.map((el) => el.getBoundingClientRect()).find((x) => x.height);
      if (r) body.style.setProperty(name, `${Math.round(r.bottom + window.scrollY)}px`);
    };
    place();
    const seen = new ResizeObserver(place);
    for (const el of els) seen.observe(el);
    seen.observe(body);
    return () => seen.disconnect();
  }, [els]);
}

/**
 * Now's sky, for as long as Now's card area is there: the page's
 * background from the top down to the horizon on screen, in the hour's
 * `phase` (app.css, body.sky). It stays put while the card changes, until
 * the next horizon says where it ends. The header and the chips take the
 * sky's colours over it, and so does the browser's own bar while Now is the
 * tab on screen. Settings has the sky only in the band at the top of its
 * pages (body.set-sky, from settings.js).
 */
export function useNowSky(phase) {
  const bar = useRef(null);
  useLayoutEffect(() => {
    const body = document.body;
    const meta = Object.assign(document.createElement('meta'), { name: 'theme-color' });
    bar.current = meta;
    // Map and Settings are drawn over a hidden Now (app.js sets on-map and
    // on-settings); Settings has the sky only in its pages' band.
    const tab = () => {
      const has = (c) => body.classList.contains(c);
      if (has('on-map') || (has('on-settings') && !has('set-sky'))) return meta.remove();
      meta.content = getComputedStyle(body).getPropertyValue('--s0').trim() || '#121a33';
      if (meta.parentNode !== document.head || document.head.firstChild !== meta) document.head.prepend(meta);
    };
    body.classList.add('sky');
    const tabs = new MutationObserver(tab);
    tabs.observe(body, { attributes: true, attributeFilter: ['class'] });
    return () => {
      tabs.disconnect();
      meta.remove();
      body.classList.remove('sky', ...PHASES.map((p) => `sky-${p}`));
      body.style.removeProperty('--sky-end');
    };
  }, []);
  useLayoutEffect(() => {
    for (const p of PHASES) document.body.classList.toggle(`sky-${p}`, p === phase);
  }, [phase]);
  useSkyEnd('now', '--sky-end');
  // Depth as the page scrolls (daylight.js parallax): the moon, the stars and
  // the far hills lag behind, as CSS variables on the page (app.css), so a
  // card that comes in as the chips switch has them at once. Off for anyone
  // who asks for less motion.
  useEffect(() => {
    const body = document.body;
    const VARS = ['--par-sky', '--par-far', '--par-fade'];
    let frame = 0;
    const apply = () => {
      frame = 0;
      if (reducedMotion()) return VARS.forEach((v) => body.style.removeProperty(v));
      const p = parallax(window.scrollY);
      body.style.setProperty('--par-sky', `${p.sky.toFixed(1)}px`);
      body.style.setProperty('--par-far', `${p.far.toFixed(1)}px`);
      body.style.setProperty('--par-fade', p.fade.toFixed(3));
    };
    const soon = () => {
      if (!frame) frame = requestAnimationFrame(apply);
    };
    apply();
    window.addEventListener('scroll', soon, { passive: true });
    // Back from Map or Settings, at whatever the page's scroll is now.
    const tabs = new MutationObserver(soon);
    tabs.observe(body, { attributes: true, attributeFilter: ['class'] });
    return () => {
      window.removeEventListener('scroll', soon);
      tabs.disconnect();
      cancelAnimationFrame(frame);
      VARS.forEach((v) => body.style.removeProperty(v));
    };
  }, []);
}
