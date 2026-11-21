import { readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import { UI, WORDS } from './render-timelapse-ui.mjs';

const { values: o } = parseArgs({
  options: {
    date: { type: 'string' },
    preset: { type: 'string', default: 'story' },
    theme: { type: 'string', default: 'dark' },
    clean: { type: 'boolean', default: false },
    seconds: { type: 'string', default: '60' },
    from: { type: 'string', default: '' },
    to: { type: 'string', default: '' },
    out: { type: 'string', default: '.' },
    base: { type: 'string', default: 'https://terminus.run' },
    'wait-min': { type: 'string', default: '30' },
    help: { type: 'boolean', default: false },
  },
});

const USAGE = `usage: TIMELAPSE_TOKEN=... node render-timelapse.mjs --date 2026-10-08 \\
         [--preset story|wide] [--theme dark|light] [--clean] [--seconds 60] \\
         [--from 07:00] [--to 00:00] [--out ./videos] [--base https://terminus.run] [--wait-min 30]

Renders a recorded day as a video through the dashboard's Timelapse (/admin/#/timelapse)
in headless Chromium, exactly as a browser would, and saves the file.

  --clean     leaves out the clock, the counts and the wordmark (the map's credit stays),
              for footage that gets its own words in another video
  --wait-min  how long to wait for the day to be written, when the render starts just as
              the recording closes (00:30 Singapore time)

The token is TIMELAPSE_TOKEN, or the file named by TIMELAPSE_TOKEN_FILE. It is never printed,
and is sent only over https (plain http only to localhost, for the dev stub), to --base itself.
Run it from a checkout: pnpm install, then pnpm exec playwright install --with-deps chromium.
Slow: on one small CPU with software WebGL a frame takes about 6 s, so a 60 s video is about
3 hours. Exits 0 with the file's path, else 1.`;
if (o.help) {
  console.log(USAGE);
  process.exit(0);
}

const log = (...a) => console.log(new Date().toISOString(), ...a);
const fail = (msg) => {
  log(`failed: ${msg}`);
  process.exit(1);
};

if (!/^\d{4}-\d{2}-\d{2}$/.test(o.date ?? '')) fail('--date YYYY-MM-DD is required');
let base;
try {
  base = new URL(o.base);
} catch {
  fail(`--base ${o.base} is not a URL`);
}
const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];
if (base.protocol !== 'https:' && !(base.protocol === 'http:' && LOOPBACK.includes(base.hostname))) {
  fail('--base must be https:// (or http://localhost, for the dev stub), so the token is never sent in the clear');
}
const BASE = base.origin;
const seconds = Number(o.seconds);
if (!Number.isFinite(seconds) || seconds < 2 || seconds > 600) fail('--seconds must be 2 to 600');
if (!(o.preset in WORDS.shape)) fail(`--preset must be ${Object.keys(WORDS.shape).join(' or ')}`);
if (!(o.theme in WORDS.map)) fail(`--theme must be ${Object.keys(WORDS.map).join(' or ')}`);
for (const [flag, v] of [
  ['--from', o.from],
  ['--to', o.to],
])
  if (v && !/^\d{2}:\d{2}$/.test(v)) fail(`${flag} must be HH:MM`);
const RENDER_LIMIT_MS = Math.max(12 * 3_600_000, seconds * 30 * 12_000);
const token = (
  process.env.TIMELAPSE_TOKEN || (process.env.TIMELAPSE_TOKEN_FILE ? readFileSync(process.env.TIMELAPSE_TOKEN_FILE, 'utf8') : '')
).trim();
if (!token) fail('no token: set TIMELAPSE_TOKEN or TIMELAPSE_TOKEN_FILE');

const waitMin = Number(o['wait-min']);
if (!Number.isFinite(waitMin) || waitMin < 0) fail('--wait-min must be a number of minutes, 0 or more');
const until = Date.now() + waitMin * 60_000;
for (;;) {
  const res = await fetch(`${BASE}/api/timelapse/days`, {
    headers: { 'x-health-token': token },
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  }).catch((err) => ({ ok: false, status: err.message }));
  if (res.ok) {
    const { days } = await res.json();
    const day = days.find((d) => d.date === o.date);
    if (day?.closed) break;
    if (day && Date.now() > until) {
      log(`${o.date} is still open; rendering what there is`);
      break;
    }
    if (!day && Date.now() > until) fail(`${o.date} was not recorded (days: ${days.map((d) => d.date).join(', ') || 'none'})`);
    log(`${o.date} ${day ? 'not closed yet' : 'not listed yet'}; waiting`);
  } else if ([401, 403, 404].includes(res.status)) {
    fail(`/api/timelapse/days answered ${res.status}: is the token right?`);
  } else if (Date.now() > until) {
    fail(`/api/timelapse/days answered ${res.status}`);
  } else {
    log(`/api/timelapse/days answered ${res.status}; waiting`);
  }
  await new Promise((r) => setTimeout(r, 60_000));
}

const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: true, viewport: { width: 1280, height: 1000 } });
  const page = await context.newPage();
  page.on('pageerror', (e) => log('page error:', e.message));
  await page.goto(`${BASE}/admin/#/timelapse`);
  if (new URL(page.url()).origin !== BASE) throw new Error(`${BASE}/admin/ went to ${new URL(page.url()).origin}`);
  await page.fill(UI.token, token);
  await page.getByRole('button', { name: WORDS.open }).click();
  const ready = async () => {
    const result = await page.waitForFunction(
      ([button, note]) => {
        const said = document.querySelector(note)?.textContent;
        if (said) return said;
        const b = document.querySelector(button);
        return Boolean(b) && !b.disabled;
      },
      [UI.exportButton, UI.note],
      { timeout: 300_000 },
    );
    const said = await result.jsonValue();
    if (typeof said === 'string') throw new Error(said);
  };
  const settle = async () => {
    await page.waitForTimeout(500);
    await ready();
  };
  const choose = async (group, word) => {
    const button = page.locator(group).getByRole('button', { name: word, exact: true });
    if ((await button.getAttribute('aria-pressed')) === 'true') return;
    await button.click();
    await settle();
  };
  await page.waitForSelector(UI.day, { timeout: 120_000 });
  await page.selectOption(UI.day, o.date);
  await settle();
  await choose(UI.shape, WORDS.shape[o.preset]);
  await choose(UI.map, WORDS.map[o.theme]);
  if (o.clean) await choose(UI.overlay, WORDS.overlay.off);
  if (
    await page
      .locator(UI.length)
      .getByRole('button', { name: WORDS.length(seconds), exact: true })
      .count()
  ) {
    await choose(UI.length, WORDS.length(seconds));
  } else {
    await page.fill(UI.otherLength, String(seconds));
    await page.locator(UI.otherLength).dispatchEvent('change');
    await settle();
  }
  if (o.to) await moveHandle(page, UI.to, o.to);
  if (o.from) await moveHandle(page, UI.from, o.from);
  await ready();
  log('rendering:', (await page.innerText(UI.summary)).replace(/\s+/g, ' ').trim());
  await page.getByRole('button', { name: WORDS.export }).click();
  const started = Date.now();
  for (;;) {
    const done = await page
      .getByRole('link', { name: WORDS.download })
      .waitFor({ timeout: 60_000 })
      .then(() => true)
      .catch(() => false);
    if (done) break;
    const failed = await page
      .locator(UI.failed)
      .textContent({ timeout: 1_000 })
      .catch(() => null);
    if (failed) throw new Error(failed);
    log((await page.textContent(UI.progress).catch(() => ''))?.trim() || 'starting');
    if (Date.now() - started > RENDER_LIMIT_MS) throw new Error(`still rendering after ${Math.round(RENDER_LIMIT_MS / 3_600_000)} hours`);
  }
  log((await page.textContent(UI.progress))?.trim());
  mkdirSync(o.out, { recursive: true });
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: WORDS.download }).click()]);
  const file = path.resolve(o.out, download.suggestedFilename());
  await download.saveAs(file);
  log('saved', file);
} catch (err) {
  log(`failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  await browser.close();
}

async function moveHandle(page, sel, hhmm) {
  const minutes = (t) => {
    const [h, m] = t.split(':').map(Number);
    return (h < 6 ? h + 24 : h) * 60 + m;
  };
  const handle = page.locator(sel);
  await handle.focus();
  let still = 0;
  for (let tries = 0; tries < 400; tries++) {
    const at = await handle.getAttribute('aria-valuetext');
    if (!/^\d{2}:\d{2}$/.test(at ?? '')) throw new Error(`${sel} shows no time (${at})`);
    const gap = minutes(hhmm) - minutes(at);
    if (gap === 0) return;
    const key = `${Math.abs(gap) >= 10 ? 'Shift+' : ''}${gap > 0 ? 'ArrowRight' : 'ArrowLeft'}`;
    await handle.press(key);
    const moved = await page
      .waitForFunction(([s, was]) => document.querySelector(s)?.getAttribute('aria-valuetext') !== was, [sel, at], { timeout: 15_000 })
      .then(
        () => true,
        () => false,
      );
    still = moved ? 0 : still + 1;
    if (still === 2) {
      log(`${sel} stops at ${at}, short of ${hhmm}`);
      return;
    }
  }
  throw new Error(`couldn't move ${sel} to ${hhmm}`);
}
