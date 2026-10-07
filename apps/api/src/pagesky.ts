/**
 * The band of sky at the top of the Worker's own small pages (me.ts page():
 * approving a sign-in, a used link, and so on): the hour's sky, with the
 * campus's hills along its foot, as Settings' pages have it in the apps.
 * The page is plain HTML with no script, so the hour is the server's, in
 * Singapore. The colours and hours are the web app's (app.css, daylight.js);
 * pagesky.test.js keeps them the same.
 */

export type Phase = 'night' | 'dawn' | 'day' | 'golden' | 'dusk';

/** The sky at `min` minutes past midnight, Singapore time: daylight.js phaseAt. */
export function phaseAt(min: number): Phase {
  if (min < 390 || min >= 1180) return 'night';
  if (min < 510) return 'dawn';
  if (min < 990) return 'day';
  if (min < 1125) return 'golden';
  return 'dusk';
}

/** Minutes past midnight in Singapore (UTC+8, no daylight saving) at `ms`. */
export const sgtMinute = (ms: number) => Math.floor((ms / 60_000 + 8 * 60) % 1440);

/** One hour's colours: the sky top to bottom, the far hills, the trees, the city. */
export interface PageSky {
  sky: [string, string, string, string];
  far: string;
  tree: string;
  city: string;
}

/** app.css body.sky-<phase>, on a light page and on a dark one. */
export const PAGE_SKIES: Record<'light' | 'dark', Record<Phase, PageSky>> = {
  light: {
    dawn: { sky: ['#8fc1e8', '#b7d6ee', '#f1d6c2', '#f7c9a4'], far: '#b3b0c3', tree: '#6a7568', city: '#cfc8d8' },
    day: { sky: ['#5ea8e5', '#8ec4ec', '#c7e2f4', '#e3f0f8'], far: '#9fbcae', tree: '#4f6f58', city: '#b7cbd9' },
    golden: { sky: ['#78aadb', '#a7c3dc', '#f0cf9c', '#f4b46c'], far: '#c4a983', tree: '#5e5a42', city: '#dcc6a2' },
    dusk: { sky: ['#2c3566', '#4a4275', '#6c4260', '#e08a62'], far: '#4b3f62', tree: '#2c2440', city: '#7d6a90' },
    night: { sky: ['#121a33', '#181a30', '#24243a', '#2e2a44'], far: '#3a3550', tree: '#5b5568', city: '#45405f' },
  },
  dark: {
    dawn: { sky: ['#1d3550', '#2a465f', '#5c4d58', '#8a6656'], far: '#2a3446', tree: '#151c24', city: '#3d4658' },
    day: { sky: ['#173350', '#1f4262', '#2d5674', '#3f6b86'], far: '#20384a', tree: '#132330', city: '#35506a' },
    golden: { sky: ['#1f3550', '#334356', '#5e4a37', '#9a6a3c'], far: '#3a3326', tree: '#1a1712', city: '#4d4536' },
    dusk: { sky: ['#1a1c3a', '#322b54', '#6c4260', '#b8644f'], far: '#2b2340', tree: '#17121f', city: '#4f4266' },
    night: { sky: ['#121a33', '#181a30', '#24243a', '#2e2a44'], far: '#191826', tree: '#121110', city: '#45405f' },
  },
};

/** Light words on the sky: always at dusk and at night, and on a dark page. */
const LIGHT_INK: ReadonlySet<Phase> = new Set(['dusk', 'night']);

// The hills, as sky.js draws them: fixed waves, so a wider card shows more hills.
const farY = (x: number) => 30 + 6 * Math.sin(x / 47 + 0.6) + 4 * Math.sin(x / 19 + 2.1);
const nearY = (x: number) => 52 + 3 * Math.sin(x / 61 + 1.3) + 1.5 * Math.sin(x / 27);
const r1 = (n: number) => Math.round(n * 10) / 10;
const ridge = (w: number, y: (x: number) => number) => {
  let d = `M0 92L0 ${r1(y(0))}`;
  for (let x = 4; x < w + 4; x += 4) d += `L${x} ${r1(y(x))}`;
  return `${d}L${w} 92Z`;
};
/** The lowest point of the far hills between `lo` and `hi`, where the city shows over them. */
const dip = (lo: number, hi: number) => {
  let best = lo;
  for (let x = lo; x <= hi; x += 2) if (farY(x) > farY(best)) best = x;
  return best;
};

/** The band's width in its own units; a narrower card shows its middle. A
 * wider one (the API docs' bar) goes on along unbroken hills, BAND_W at a
 * time, so it shows more of them, not bigger ones: the first stretch as a
 * card has it, then trees on every one, the tall building on every other
 * with the flag, and the city on every third, so it doesn't read as a
 * pattern. */
const BAND_W = 400;

/**
 * The low horizon (sky.js Horizon `low`): the city's top to the near hill,
 * with two buildings, rain trees and the flag, and the near hill in the
 * card's colour. Lit windows after dark. Colours come from the band's CSS.
 */
export function horizonSvg(lights: boolean, W = BAND_W): string {
  const city: string[] = [];
  const far: string[] = [];
  const lit: string[] = [];
  const trees: string[] = [];
  const flags: string[] = [];
  for (let n = 0, o = 0; o < W; n++, o += BAND_W) {
    const at = (f: number) => o + Math.round(BAND_W * f);
    const end = Math.min(o + BAND_W, W);
    const [b1, b2, flag] = [at(0.18), at(0.62), at(0.76)];
    const mbs = dip(Math.max(at(0.8) - 40, flag + 30), Math.min(at(0.8) + 40, end - 29));
    const top = r1(farY(mbs) + 3);
    const pole = r1(nearY(flag));
    const tree = (c: number) => {
      const g = r1(nearY(c));
      return `<path d="M${c - 1.5} ${g + 2}V${g - 7}L${c - 7} ${g - 13}H${c - 4.5}L${c} ${g - 9}L${c + 4.5} ${g - 13}H${c + 7}L${c + 1.5} ${g - 7}V${g + 2}Z"/><ellipse cx="${c}" cy="${r1(g - 18)}" rx="21" ry="5.5"/><ellipse cx="${c - 8}" cy="${r1(g - 21.5)}" rx="11" ry="4.5"/><ellipse cx="${c + 8}" cy="${r1(g - 22)}" rx="12" ry="4.5"/>`;
    };
    const stars = [0, 1, 2, 3, 4]
      .map((i) => `<circle cx="${r1(flag + 5.2 + 0.85 * Math.sin((i * 2 * Math.PI) / 5))}" cy="${r1(pole - 22 - 0.85 * Math.cos((i * 2 * Math.PI) / 5))}" r=".35"/>`)
      .join('');
    if (n % 3 === 0)
      city.push(...[-13, -2, 9].map((x) => `<path d="M${mbs + x} ${top}L${mbs + x + 1} ${r1(top - 26)}H${mbs + x + 5}L${mbs + x + 6} ${top}Z"/>`), `<path d="M${mbs - 15} ${r1(top - 28)}L${mbs + 25} ${r1(top - 29.2)}L${mbs + 23} ${r1(top - 26)}H${mbs - 14}Z"/>`);
    const tall = n % 2 === 0;
    far.push(`<rect x="${b1 - 8}" y="${r1(farY(b1) - 14)}" width="16" height="20"/>`);
    lit.push(`<rect x="${b1 - 3}" y="${r1(farY(b1) - 9)}" width="3" height="3" opacity=".6"/>`);
    // The first tree only on the first stretch: elsewhere it would stand
    // beside the last one of the stretch before.
    trees.push((n === 0 ? [0.06, 0.45, 0.9] : [0.45, 0.9]).map((f) => tree(at(f))).join(''));
    if (!tall) continue;
    far.push(`<rect x="${b2 - 13}" y="${r1(farY(b2) - 22)}" width="26" height="28"/>`);
    lit.push(`<rect x="${b2 - 5}" y="${r1(farY(b2) - 16)}" width="3" height="3"/>`);
    trees.push(`<path d="M${flag - 0.6} ${pole + 2}V${pole - 24}H${flag + 0.6}V${pole + 2}Z"/>`);
    flags.push(`<rect x="${flag + 0.6}" y="${pole - 24}" width="12" height="4" fill="#ef3340"/><rect x="${flag + 0.6}" y="${pole - 20}" width="12" height="4" fill="#f2efeb"/><circle cx="${flag + 3.2}" cy="${pole - 22}" r="1.5" fill="#f2efeb"/><circle cx="${flag + 3.8}" cy="${pole - 22}" r="1.3" fill="#ef3340"/><g fill="#f2efeb">${stars}</g>`);
  }
  return `<svg class="hz" viewBox="0 6 ${W} 52" preserveAspectRatio="xMidYMax slice" aria-hidden="true">
<g class="city">${city.join('')}</g>
<g class="far"><path d="${ridge(W, farY)}"/>${far.join('')}</g>
${lights ? `<g class="lit">${lit.join('')}</g>` : ''}
<g class="tree">${trees.join('')}</g>
${flags.join('')}
<path class="near" d="${ridge(W, nearY)}"/></svg>`;
}

const vars = (s: PageSky, lightInk: boolean) =>
  `--s0:${s.sky[0]};--s1:${s.sky[1]};--s2:${s.sky[2]};--s3:${s.sky[3]};--h-far:${s.far};--h-tree:${s.tree};--h-city:${s.city};--band-ink:${lightInk ? '#f5f3f0' : '#1c1917'}`;

/** Whether the words over the sky at `phase` are light, on a light page. */
export const lightInkAt = (phase: Phase) => LIGHT_INK.has(phase);

/** The sky's colours at `phase` as CSS variables: on a light page, or on a dark one. */
export const skyVars = (phase: Phase, page: 'light' | 'dark' = 'light') => vars(PAGE_SKIES[page][phase], page === 'dark' || LIGHT_INK.has(phase));

/** The band's CSS at `phase`: its colours on a light page and on a dark one, and how it's laid out. */
export function bandCss(phase: Phase): string {
  return `.band{${vars(PAGE_SKIES.light[phase], LIGHT_INK.has(phase))}}
@media (prefers-color-scheme:dark){.band{${vars(PAGE_SKIES.dark[phase], true)}}}
.band{margin:-32px -28px 20px;padding:18px 24px 0;background:linear-gradient(var(--s0),var(--s1) 50%,var(--s2) 86%,var(--s3))}
.band .brand{color:var(--band-ink)}
.band .hz{display:block;width:calc(100% + 48px);height:52px;margin:6px -24px 0}
.hz .far{fill:var(--h-far)}.hz .tree{fill:var(--h-tree)}.hz .city{fill:var(--h-city)}.hz .lit{fill:#fde9c9}.hz .near{fill:var(--surface)}`;
}

/** The band itself: the mark and the name in the sky, over the hills. */
export function bandHtml(phase: Phase): string {
  return `<div class="band"><span class="brand"><img src="/assets/mark.svg" alt=""><span class="wordmark">terminus</span></span>${horizonSvg(phase === 'dusk' || phase === 'night')}</div>`;
}
