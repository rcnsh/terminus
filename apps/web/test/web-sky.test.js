import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const css = fs.readFileSync(new URL('../public/app/app.css', import.meta.url), 'utf8');

function vars(sel) {
  const at = css.indexOf(`\n${sel} {`);
  assert.ok(at >= 0, `no rule for ${sel}`);
  const body = css.slice(at + sel.length + 3, css.indexOf('}', at));
  return Object.fromEntries([...body.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}

function rgba(v) {
  assert.ok(v, 'a colour the sky needs is missing');
  if (v.startsWith('#')) return [1, 3, 5].map((i) => parseInt(v.slice(i, i + 2), 16)).concat(1);
  const m = v.match(/rgb\((\d+) (\d+) (\d+)(?: \/ ([\d.]+))?\)/);
  assert.ok(m, `can't read colour ${v}`);
  return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])];
}

const over = (fg, bg) => bg.map((c, i) => (i < 3 ? c + (fg[i] - c) * fg[3] : 1));
const lum = ([r, g, b]) => {
  const f = (c) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const ratio = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

function skyAt(s, t) {
  const stops = [s.s0, s.s1, s.s2, s.s3].map(rgba);
  const P = [0, 0.5, 0.86, 1];
  const i = t <= 0.5 ? 0 : t <= 0.86 ? 1 : 2;
  const k = (t - P[i]) / (P[i + 1] - P[i]);
  return stops[i].map((c, j) => c + (stops[i + 1][j] - c) * k);
}

const PHASES = ['dawn', 'day', 'golden', 'dusk', 'night'];
const LIGHT_SKY = new Set(['dawn', 'day', 'golden']);
const WORDS = [0.12, 0.25, 0.4, 0.55, 0.65, 0.72];

function skies() {
  const night = vars('body.sky');
  const out = [];
  for (const phase of PHASES) {
    const light = phase === 'night' ? night : { ...night, ...vars(`body.sky-${phase}`) };
    const lightInk = LIGHT_SKY.has(phase)
      ? vars('body.sky-dawn, body.sky-day, body.sky-golden')
      : vars('body.sky, body.sky-dusk, body.sky-night');
    out.push({ name: `light ${phase}`, sky: light, ink: lightInk });
    const dark = phase === 'night' ? night : { ...night, ...vars(`:root[data-theme="dark"] body.sky-${phase}`) };
    out.push({ name: `dark ${phase}`, sky: dark, ink: { ...lightInk, ...vars(':root[data-theme="dark"] body.sky') } });
  }
  return out;
}

test('every hour of the sky has its four colours, in both themes', () => {
  for (const { name, sky } of skies()) for (const k of ['s0', 's1', 's2', 's3']) assert.ok(sky[k], `${name} has no --${k}`);
  assert.equal(skies().find((s) => s.name === 'dark day').sky.s0, '#173350');
});

test("the sky's words read over the sky, the glass and the chip, at every hour", () => {
  const bad = [];
  for (const { name, sky, ink } of skies()) {
    const bgs = WORDS.map((t) => skyAt(sky, t));
    const check = (role, need, on) => {
      const fg = rgba(ink[`k-${role}`]);
      for (const bg of bgs) {
        const under = on ? over(rgba(ink[on]), bg) : bg;
        const r = ratio(fg, under);
        if (r < need) bad.push(`${name}: --k-${role} over ${on ?? 'the sky'} is ${r.toFixed(2)}:1, needs ${need}`);
      }
    };
    for (const role of ['ink', 'muted', 'faint', 'bad', 'accent-small']) check(role, 4.5);
    check('accent', 3);
    for (const role of ['ink', 'muted', 'faint', 'accent-small']) check(role, 4.5, 'k-surface');
    for (const role of ['ink', 'muted', 'good', 'warn', 'bad', 'accent-small']) check(role, 4.5, 'k-chip');
  }
  assert.deepEqual(bad, []);
});

const siteCss = fs.readFileSync(new URL('../public/assets/sky.css', import.meta.url), 'utf8');

function varRules(src) {
  const out = new Map();
  for (const [, sel, body] of src.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!/^\s*--/.test(body)) continue;
    out.set(sel.replace(/\s+/g, ' ').trim(), body.replace(/\s+/g, ' ').trim());
  }
  return out;
}

test("the website's sky has app.css's colours, rule for rule", () => {
  const site = (sel) =>
    sel
      .replace(/(:root(?::not\(\[data-theme="light"\]\)|\[data-theme="dark"\])) body\.sky-(\w+)/g, '$1[data-sky="$2"] .sky-panel')
      .replace(/body\.sky-(\w+)/g, '[data-sky="$1"] .sky-panel')
      .replace(/body\.sky\b/g, '.sky-panel');
  const app = varRules(css.slice(css.indexOf('\nbody.sky {'), css.indexOf('\nbody.sky { --end')));
  const web = varRules(siteCss);
  assert.ok(app.size >= 12, 'found the palette in app.css');
  for (const [sel, body] of app) {
    const vars = body.replace(/^position: relative; overflow-x: clip;\s*/, '');
    assert.equal(web.get(site(sel)), vars, sel);
  }
});

test("the website's pages take the hour from the same clock as Now", async () => {
  const { phaseAt } = await import('../public/account/daylight.js');
  const src = fs.readFileSync(new URL('../public/assets/sky-phase.js', import.meta.url), 'utf8');
  for (let min = 0; min < 1440; min += 5) {
    const html = { dataset: {} };
    const at = new Date(2026, 9, 7, Math.floor(min / 60), min % 60);
    const box = {
      document: { documentElement: html },
      setInterval: () => 0,
      Date: class extends Date {
        constructor() {
          super(at);
        }
      },
    };
    vm.runInNewContext(src, box);
    assert.equal(html.dataset.sky, phaseAt(min), `${min} min`);
  }
});
