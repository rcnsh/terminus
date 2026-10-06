// The sky over Now, the web app's first tab: by the hour, from dawn to
// night, ending on a horizon of the campus's hills. There is one sky for the
// whole tab, so it stays as the chips switch: whatever the card area shows
// ends on a <Horizon>, and the sky reaches down to it. The hour only picks
// classes (app.css draws the colours, the sun or the stars). Android draws
// the same scene from the same numbers (NightSky.kt).
import { html, store, useLayoutEffect, useRef, useState, useStore } from '../assets/ui.js';
import { PHASES } from './daylight.js';

export { phaseAt } from './daylight.js';

/** Where the stars sit: across (0–1), down (0–1 of the room above the words), and how bright. */
const STARS = [
  [0.06, 0.3, 0.7], [0.17, 0.62, 0.5], [0.29, 0.18, 0.8], [0.38, 0.8, 0.4], [0.47, 0.42, 0.6], [0.55, 0.1, 0.5], [0.63, 0.68, 0.45],
  [0.72, 0.28, 0.7], [0.84, 0.88, 0.4], [0.92, 0.5, 0.55], [0.11, 0.95, 0.35], [0.33, 1, 0.4], [0.58, 0.98, 0.3],
];

/** A few stars and a crescent moon. Fixed, so they never twinkle into a distraction. */
export const NightSky = () => html`
  <span class="night-sky" aria-hidden="true">
    ${STARS.map(([x, y, a], i) => html`<span class="star" key=${i} style=${{ left: `${x * 100}%`, top: `calc(${(y * 0.82).toFixed(3)} * var(--room, 108px) + 4px)`, opacity: a }}></span>`)}
    <span class="moon"></span>
  </span>
`;

/** A heaped cloud, Singapore's afternoon kind, at `x`, `y`, scaled by `s`. */
const cloud = (x, y, s) => html`
  <g transform=${`translate(${x} ${y}) scale(${s})`}><ellipse cy="8" rx="26" ry="7" /><circle cx="-10" cy="3" r="8" /><circle cx="4" cy="-1" r="11" /><circle cx="16" cy="4" r="7" /></g>
`;

/**
 * What's up in the room above the words: the sun, a few clouds, or the
 * stars and the moon. All of it is drawn; the hour's class shows its own.
 */
export const Celestial = () => html`
  <span class="celestial" aria-hidden="true">
    <span class="sun"></span>
    <svg class="clouds" width="340" height="66" viewBox="0 0 340 66">${cloud(70, 34, 0.9)}${cloud(205, 48, 0.6)}${cloud(150, 14, 0.45)}</svg>
    <${NightSky} />
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
/** About how wide `s` is at `size` px in bold: Chinese characters are about square. */
const textW = (s, size) => [...s].reduce((n, c) => n + (/[⺀-鿿＀-￯]/.test(c) ? size * 1.05 : size * 0.6), 0);

/** The flag's five stars, in a ring around its middle (px). */
const STARS5 = [0, 1, 2, 3, 4].map((i) => [0.85 * Math.sin((i * 2 * Math.PI) / 5), -0.85 * Math.cos((i * 2 * Math.PI) / 5)]);

/** The horizon on screen now, for the sky to reach down to. */
const ground = store(null);

/**
 * Where the sky ends: the hills, a building or two, rain trees, Singapore's
 * flag by the road, and Marina Bay Sands far off in the city. The near hill
 * is the page's own colour, so the sky meets the ground instead of fading.
 * On the road, either your stop's sign (`stop`) with your bus (`bus`:
 * `svc`, `color`, `text`, `far` from 0 at the stop to 1 a quarter of an
 * hour away, and `live`) coming up to it, or a shuttle going by (`shuttle`).
 * A timetable guess is an outline, never a filled bus, so it doesn't pass
 * for live.
 */
export function Horizon({ stop = null, bus = null, shuttle = true }) {
  const box = useRef(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = box.current;
    ground.set(el);
    const seen = new ResizeObserver(() => setW(Math.round(el.clientWidth)));
    seen.observe(el);
    return () => {
      seen.disconnect();
      if (ground.get() === el) ground.set(null);
    };
  }, []);
  const at = (f) => Math.round(w * f);
  // Your stop's sign left of the flag, whatever its name's length; the flag
  // right of anything on the road; the city clear of the flag and the edge.
  const plate = stop ? Math.round(textW(stop, 7.5) + 10) : 0;
  const sx = stop ? Math.min(at(0.7), at(0.74) - plate / 2) : 0;
  const [b1, b2, flag] = [at(0.18), at(0.62), at(0.76)];
  const mbs = dip(Math.max(at(0.8) - 40, flag + 30), Math.min(at(0.8) + 40, w - 29));
  const city = farY(mbs) + 3;
  const pole = nearY(flag);
  // The bus pulls up just short of the sign; its label keeps clear of the sign.
  const bx = bus ? Math.round(sx - 44 - Math.min(1, Math.max(0, bus.far)) * (sx - 56)) : 0;
  const lw = bus ? Math.round(textW(bus.text, 8) + 14) : 0;
  const lx = bus ? Math.max(4, Math.min(bx + 19 - lw / 2, sx - plate / 2 - 4 - lw)) : 0;
  const passing = at(0.58) - 19;
  return html`
    <div class="horizon" ref=${box} aria-hidden="true">
      ${w > 0 &&
      html`<svg width=${w} height="92" viewBox=${`0 0 ${w} 92`}>
        <circle class="setting" cx=${at(0.5)} cy="40" r="26" />
        ${mbs + 25 <= w &&
        html`<g class="city">
          ${[-13, -2, 9].map((x) => html`<path d=${`M${mbs + x} ${city}L${mbs + x + 1} ${city - 26}H${mbs + x + 5}L${mbs + x + 6} ${city}Z`} />`)}
          <path d=${`M${mbs - 15} ${city - 28}L${mbs + 25} ${city - 29.2}L${mbs + 23} ${city - 26}H${mbs - 14}Z`} />
        </g>`}
        <path class="far" d=${ridge(w, farY)} />
        <rect class="far" x=${b1 - 8} y=${farY(b1) - 14} width="16" height="20" />
        <rect class="lit dim" x=${b1 - 3} y=${farY(b1) - 9} width="3" height="3" />
        <rect class="far" x=${b2 - 13} y=${farY(b2) - 22} width="26" height="28" />
        <rect class="lit" x=${b2 - 5} y=${farY(b2) - 16} width="3" height="3" />
        <rect class="lit dim" x=${b2 + 3} y=${farY(b2) - 8} width="3" height="3" />
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
        <path class="near" d=${ridge(w, nearY)} />
        <line class="road" x1="0" y1="70" x2=${w} y2="70" />
        ${stop &&
        html`<g class="sign">
          <line x1=${sx} y1="70" x2=${sx} y2="44" />
          <rect x=${sx - plate / 2} y="35" width=${plate} height="11" rx="2.5" />
          <text x=${sx} y="43.2">${stop}</text>
        </g>`}
        ${bus &&
        html`<g class=${bus.live ? 'coming' : 'coming guess'} transform=${`translate(${bx} 57)`} style=${{ '--svc': bus.color }}>
            <rect class="body" x="0.75" y="0.75" width="36.5" height="10.5" rx="3" />
            <rect class="band" y="9.5" width="38" height="2.5" rx="1" />
            ${[3, 10, 17, 24].map((x) => html`<rect class="win" x=${x} y="2.5" width="5" height="4" rx="1" />`)}
            <rect class="win" x="32" y="2.5" width="4" height="6" rx="1" />
            ${[8, 30].map((x) => html`<circle class="tyre" cx=${x} cy="12" r="2.2" /><circle class="hub" cx=${x} cy="12" r="0.8" />`)}
          </g>
          <g class="label">
            <rect x=${lx} y="42" width=${lw} height="12" rx="6" />
            <text x=${lx + lw / 2} y="50.6">${bus.text}</text>
          </g>`}
        ${!bus &&
        shuttle &&
        html`<g transform=${`translate(${passing} 57)`}>
          <path class="beam" d="M38 6L60 3L60 11Z" />
          <rect class="bus" width="38" height="12" rx="3" />
          <rect class="stripe" y="9.5" width="38" height="2.5" rx="1" />
          ${[3, 10, 17, 24].map((x) => html`<rect class=${x === 24 ? 'win dim' : 'win'} x=${x} y="2.5" width="5" height="4" rx="1" />`)}
          <rect class="win" x="32" y="2.5" width="4" height="6" rx="1" />
          ${[8, 30].map((x) => html`<circle class="tyre" cx=${x} cy="12" r="2.2" /><circle class="hub" cx=${x} cy="12" r="0.8" />`)}
        </g>`}
      </svg>`}
    </div>
  `;
}

/**
 * Now's sky, for as long as Now's card area is there: the page's
 * background from the top down to the horizon on screen, in the hour's
 * `phase` (app.css, body.sky). It stays put while the card changes, until
 * the next horizon says where it ends. The header and the chips take the
 * sky's colours over it, and so does the browser's own bar while Now is the
 * tab on screen.
 */
export function useNowSky(phase) {
  const el = useStore(ground);
  const bar = useRef(null);
  useLayoutEffect(() => {
    const body = document.body;
    const meta = Object.assign(document.createElement('meta'), { name: 'theme-color' });
    bar.current = meta;
    // Map and Settings are drawn over a hidden Now (app.js sets on-map and on-settings).
    const tab = () => {
      if (body.classList.contains('on-map') || body.classList.contains('on-settings')) return meta.remove();
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
  useLayoutEffect(() => {
    if (!el) return;
    const body = document.body;
    const place = () => body.style.setProperty('--sky-end', `${Math.round(el.getBoundingClientRect().bottom + window.scrollY)}px`);
    place();
    const seen = new ResizeObserver(place);
    seen.observe(el);
    seen.observe(body);
    return () => seen.disconnect();
  }, [el]);
}
