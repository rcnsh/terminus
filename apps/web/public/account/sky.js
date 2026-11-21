import {
  Icon,
  html,
  reducedMotion,
  store,
  useEffect,
  useLayoutEffect,
  useMedia,
  useRef,
  useShort,
  useState,
  useStore,
} from '../assets/ui.js';
import { t } from './dom.js';
import { PHASES, parallax, phaseAt } from './daylight.js';
import { STARS, starTop } from '../assets/stars.js';

export { phaseAt } from './daylight.js';

export const NightSky = ({ from = 0 }) => html`
  <span class="night-sky" aria-hidden="true">
    ${STARS.map(([x, y, a], i) => x >= from && html`<span class="star" key=${i} style=${{ left: `${x * 100}%`, top: starTop(y), opacity: a }}></span>`)}
    <span class="moon"></span>
  </span>
`;

export const Celestial = ({ band = false }) => html`
  <span class="celestial" aria-hidden="true">
    <${NightSky} from=${band ? 0.5 : 0} />
  </span>
`;

export const Band = ({ children }) =>
  html`<div class="page-band"><div class="sky-head"><${Celestial} band />${children}</div><${Horizon} on=${null} low /></div>`;

const farY = (x) => 30 + 6 * Math.sin(x / 47 + 0.6) + 4 * Math.sin(x / 19 + 2.1);
export const nearY = (x) => 52 + 3 * Math.sin(x / 61 + 1.3) + 1.5 * Math.sin(x / 27);
const dip = (lo, hi) => {
  let best = lo;
  for (let x = lo; x <= hi; x += 2) if (farY(x) > farY(best)) best = x;
  return best;
};
const ridge = (w, y, foot = 92) => {
  let d = `M0 ${foot}L0 ${y(0).toFixed(1)}`;
  for (let x = 4; x < w + 4; x += 4) d += `L${x} ${y(x).toFixed(1)}`;
  return `${d}L${w} ${foot}Z`;
};

const STARS5 = [0, 1, 2, 3, 4].map((i) => [0.85 * Math.sin((i * 2 * Math.PI) / 5), -0.85 * Math.cos((i * 2 * Math.PI) / 5)]);

const grounds = { now: store([]) };

export const BEAM = 'M38 9L60 6L60 13Z';

const BUS_BODY = 'M1.5 0H33Q36 0 36.9 2.6L38 8.5V10.5Q38 12 36.5 12H1.5Q0 12 0 10.5V1.5Q0 0 1.5 0Z';
export const arch = (x) => `M${x - 3.2} 12A3.2 3.2 0 0 1 ${x + 3.2} 12Z`;
export const WHEELS = [7.5, 26];
export const busParts = (fill, band, dim = -1, wheels = true) => html`
  <rect class=${`${fill} roof`} x="5" y="-1.6" width="14" height="1.9" rx="0.8" />
  <path class=${fill} d=${BUS_BODY} />
  <rect class=${band} y="9.5" width="38" height="2" />
  ${[2.5, 8.5, 14.5, 20.5].map((x, i) => html`<rect class=${i === dim ? 'win dim' : 'win'} x=${x} y="2.5" width="5" height="4" rx="0.8" />`)}
  <rect class="win" x="26.5" y="2.5" width="4.5" height="4" rx="0.8" />
  <rect class="win" x="32" y="2.5" width="2.8" height="8.2" rx="0.6" />
  <path class="win" d="M35.6 2.5Q36.2 2.5 36.4 3.2L37.1 7.2H35.6Z" />
  <rect class="lamp" x="36.6" y="8.3" width="1.4" height="1.3" rx="0.5" />
  <rect class="tail" y="7.4" width="0.9" height="1.8" rx="0.4" />
  ${wheels && WHEELS.map((x) => html`<path class="arch" d=${arch(x)} /><circle class="tyre" cx=${x} cy="12" r="2.2" /><circle class="hub" cx=${x} cy="12" r="0.8" />`)}
`;

export const ROAD_SCALE = 1.25;
export const signX = (vw) => Math.min(Math.round(vw * 0.7), Math.round(vw * 0.74) - 7);

const paused = store(false);

const PAUSE = '<rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/>';
const PLAY = '<path d="M7 4.5v15l12-7.5z"/>';

export function DriveToggle() {
  const now = useStore(paused);
  if (useMedia('(prefers-reduced-motion: reduce)')) return null;
  return html`<button type="button" class="drive-toggle" aria-pressed=${String(now)} aria-label=${t('Pause the moving buses')} onClick=${() => paused.set(!now)}>
    <${Icon} paths=${now ? PLAY : PAUSE} />
  </button>`;
}

const MAX_DRIVING = 2;
let driving = 0;
let lastColour = null;

function Lane({ colours, vw, y, back = false, go, first = false }) {
  const [trip, setTrip] = useState(null);
  const started = useRef(false);
  const out = useRef(false);
  const release = () => {
    if (!out.current) return;
    out.current = false;
    driving--;
  };
  useEffect(() => (trip ? release : undefined), [Boolean(trip)]);
  useEffect(() => release, []);
  useEffect(() => {
    if (trip || !go) return;
    let t;
    const pullOut = () => {
      if (driving >= MAX_DRIVING) return void (t = setTimeout(pullOut, 1000 + Math.random() * 2000));
      const pick = colours.filter((c) => c !== lastColour);
      lastColour = pick[Math.floor(Math.random() * pick.length)];
      driving++;
      out.current = true;
      setTrip({ colour: lastColour, speed: 38 + Math.random() * 14 });
    };
    const wait = first && !started.current ? 0 : (back && !started.current ? 4000 : 1500) + Math.random() * 8000;
    started.current = true;
    t = setTimeout(pullOut, wait);
    return () => clearTimeout(t);
  }, [Boolean(trip), go]);
  if (!trip) return null;
  return html`<g transform=${`translate(0 ${y})`}>
    <g
      class=${back ? 'driving back' : 'driving'}
      style=${{ '--svc': trip.colour, '--to': `${vw + 20}px`, animationDuration: `${Math.round((vw + 80) / trip.speed)}s` }}
      onAnimationEnd=${() => setTrip(null)}
    >
      <g transform=${back ? 'matrix(-1 0 0 1 38 0)' : null}>
        <path class="beam" d=${BEAM} />
        ${busParts('body', 'band', 3)}
      </g>
    </g>
  </g>`;
}

export function Horizon({ stop = false, bus = null, shuttle = true, drive = null, on = 'now', low: lowAsked = false }) {
  const short = useShort();
  const low = lowAsked || (on === 'now' && short);
  const box = useRef(null);
  const [w, setW] = useState(0);
  const [seen, setSeen] = useState(false);
  const still = useMedia('(prefers-reduced-motion: reduce)');
  const stopped = useStore(paused);
  const moving = drive?.length > 0 && !still;
  useLayoutEffect(() => {
    const el = box.current;
    const ground = on && grounds[on];
    ground?.set([...ground.get(), el]);
    setW(Math.round(el.clientWidth));
    const sized = new ResizeObserver(() => setW(Math.round(el.clientWidth)));
    sized.observe(el);
    const shown = drive?.length > 0 && new IntersectionObserver(([e]) => setSeen(e.isIntersecting));
    if (shown) shown.observe(el);
    return () => {
      sized.disconnect();
      if (shown) shown.disconnect();
      ground?.set(ground.get().filter((x) => x !== el));
    };
  }, []);
  const [top, h] = low ? [6, 52] : [0, 92];
  const k = low ? 1 : ROAD_SCALE;
  const vw = Math.round(w / k);
  const at = (f) => Math.round(vw * f);
  const sx = stop ? signX(vw) : 0;
  const [b1, b2, flag] = [at(0.18), at(0.62), at(0.76)];
  const mbs = dip(Math.max(at(0.8) - 40, flag + 30), Math.min(at(0.8) + 40, vw - 29));
  const city = farY(mbs) + 3;
  const pole = nearY(flag);
  const bx = bus ? Math.round(sx - 44 - Math.min(1, Math.max(0, bus.far)) * (sx - 56)) : 0;
  const passing = at(0.58) - 19;
  return html`
    <div class=${`${low ? 'horizon low' : 'horizon'}${stopped ? ' paused' : ''}`} ref=${box} aria-hidden="true">
      ${
        w > 0 &&
        html`<svg width=${w} height=${Math.round(h * k)} viewBox=${`0 ${top} ${vw} ${h}`}>
        <g class="depth">
        <circle class="sun dawn" cx=${at(0.3)} cy="42" r="16" />
        <circle class="sun golden" cx=${at(0.36)} cy="36" r="16" />
        <circle class="sun dusk" cx=${at(0.5)} cy="40" r="26" />
        ${
          mbs + 25 <= vw &&
          html`<g class="city">
          ${[-13, -2, 9].map((x) => html`<path d=${`M${mbs + x} ${city}L${mbs + x + 1} ${city - 26}H${mbs + x + 5}L${mbs + x + 6} ${city}Z`} />`)}
          <path d=${`M${mbs - 15} ${city - 28}L${mbs + 25} ${city - 29.2}L${mbs + 23} ${city - 26}H${mbs - 14}Z`} />
        </g>`
        }
        <path class="far" d=${ridge(vw, farY, 64)} />
        <rect class="far" x=${b1 - 8} y=${farY(b1) - 14} width="16" height="20" />
        <rect class="lit dim" x=${b1 - 3} y=${farY(b1) - 9} width="3" height="3" />
        <rect class="far" x=${b2 - 13} y=${farY(b2) - 22} width="26" height="28" />
        <rect class="lit" x=${b2 - 5} y=${farY(b2) - 16} width="3" height="3" />
        <rect class="lit dim" x=${b2 + 3} y=${farY(b2) - 8} width="3" height="3" />
        </g>
        ${[0.06, 0.45, 0.9].map((f) => {
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
        ${
          !low &&
          stop &&
          html`<g class="sign">
          <line x1=${sx} y1="70" x2=${sx} y2="44" />
          <rect x=${sx - 6.5} y="33" width="13" height="13" rx="2.5" />
          <rect class="mark" x=${sx - 3.5} y="35.5" width="7" height="7.5" rx="1.5" />
          <rect x=${sx - 2.5} y="36.5" width="5" height="3" rx="0.5" />
        </g>`
        }
        ${
          !low &&
          bus &&
          html`<g class=${bus.live ? 'coming' : 'coming guess'} transform=${`translate(${bx} 57)`} style=${{ '--svc': bus.color }}>
            ${busParts('body', 'band')}
          </g>`
        }
        ${
          !low &&
          !bus &&
          shuttle &&
          (moving
            ? html`<${Lane} colours=${drive} vw=${vw} y=${53} back=${true} go=${seen && !stopped} />
              <${Lane} colours=${drive} vw=${vw} y=${57} go=${seen && !stopped} first=${true} />`
            : drive?.length
              ? html`<g class="parked" transform=${`translate(${passing} 57)`} style=${{ '--svc': drive[0] }}>
                <path class="beam" d=${BEAM} />
                ${busParts('body', 'band', 3)}
              </g>`
              : html`<g class="shuttle" transform=${`translate(${passing} 57)`}>
                <path class="beam" d=${BEAM} />
                ${busParts('bus', 'stripe', 3)}
              </g>`)
        }
      </svg>`
      }
    </div>
  `;
}

function layoutTop(el) {
  let y = 0;
  for (let n = el; n; n = n.offsetParent) y += n.offsetTop;
  return y;
}

function useSkyEnd(on) {
  const els = useStore(grounds[on]);
  useLayoutEffect(() => {
    if (!els.length) return;
    const body = document.body;
    const place = () => {
      const el = els.find((x) => x.offsetHeight);
      if (!el) return;
      body.style.setProperty('--sky-end', `${Math.round(layoutTop(el) + el.offsetHeight)}px`);
      const tab = el.closest('main');
      if (tab) body.style.setProperty('--sky-top', `${Math.round(layoutTop(tab))}px`);
    };
    place();
    const seen = new ResizeObserver(place);
    for (const el of els) seen.observe(el);
    seen.observe(body);
    return () => seen.disconnect();
  }, [els]);
}

export function useSkyPhase() {
  const minute = () => {
    const d = new Date();
    return d.getHours() * 60 + d.getMinutes();
  };
  const [m, setM] = useState(minute);
  useEffect(() => {
    let t;
    const next = () => {
      t = setTimeout(
        () => {
          setM(minute());
          next();
        },
        60_000 - (Date.now() % 60_000),
      );
    };
    next();
    return () => clearTimeout(t);
  }, []);
  return phaseAt(m);
}

export function useNowSky(phase) {
  useLayoutEffect(() => {
    const body = document.body;
    const meta = Object.assign(document.createElement('meta'), { name: 'theme-color' });
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
      body.style.removeProperty('--sky-top');
    };
  }, []);
  useLayoutEffect(() => {
    for (const p of PHASES) document.body.classList.toggle(`sky-${p}`, p === phase);
  }, [phase]);
  useSkyEnd('now');
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
