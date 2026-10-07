/**
 * Renders a recorded day as a video, unattended: opens the timelapse page
 * (/admin/timelapse/) in headless Chromium, picks the day, size, map and
 * times, exports, and saves the file. The page does the work, exactly as
 * in a browser, so the video is the same; headless, it never pauses for a
 * hidden tab.
 *
 * For a machine of its own (a VPS), not the repo's tests: it needs
 * Playwright and its Chromium where it runs (npm i playwright, then
 * npx playwright install --with-deps chromium). Slow: on one small CPU with
 * software WebGL a frame takes about 6 s, so a 60 s video is about 3 hours.
 *
 *   TIMELAPSE_TOKEN=... node render-timelapse.mjs --date 2026-10-08 \
 *     [--preset story|wide] [--theme dark|light] [--seconds 60] \
 *     [--from 07:00] [--to 00:00] [--out ./videos] [--base https://terminus.rcn.sh]
 *
 * The token is TIMELAPSE_TOKEN (it opens /timelapse/* and nothing else), or
 * a file named by TIMELAPSE_TOKEN_FILE. It is never printed. Waits up to
 * --wait-min minutes (default 30) for the day to be written, if the render
 * starts just as the recording closes. Exits 0 with the file's path, else 1.
 */

import { readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';

const { values: o } = parseArgs({
  options: {
    date: { type: 'string' },
    preset: { type: 'string', default: 'story' },
    theme: { type: 'string', default: 'dark' },
    seconds: { type: 'string', default: '60' },
    from: { type: 'string', default: '' },
    to: { type: 'string', default: '' },
    out: { type: 'string', default: '.' },
    base: { type: 'string', default: 'https://terminus.rcn.sh' },
    'wait-min': { type: 'string', default: '30' },
  },
});

const log = (...a) => console.log(new Date().toISOString(), ...a);
const fail = (msg) => {
  log(`failed: ${msg}`);
  process.exit(1);
};

if (!/^\d{4}-\d{2}-\d{2}$/.test(o.date ?? '')) fail('--date YYYY-MM-DD is required');
const token = (process.env.TIMELAPSE_TOKEN || (process.env.TIMELAPSE_TOKEN_FILE ? readFileSync(process.env.TIMELAPSE_TOKEN_FILE, 'utf8') : '')).trim();
if (!token) fail('no token: set TIMELAPSE_TOKEN or TIMELAPSE_TOKEN_FILE');

// The day must be listed before the page can pick it: closed and in R2, or
// still being written (the recording closes at 00:30 Singapore time).
const waitMin = Number(o['wait-min']);
if (!Number.isFinite(waitMin) || waitMin < 0) fail('--wait-min must be a number of minutes, 0 or more');
const until = Date.now() + waitMin * 60_000;
for (;;) {
  // Bounded: a request that hangs would stall the wait for good.
  const res = await fetch(`${o.base}/timelapse/days`, { headers: { 'x-health-token': token }, signal: AbortSignal.timeout(30_000) }).catch((err) => ({ ok: false, status: err.message }));
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
  } else if (Date.now() > until) {
    fail(`/timelapse/days answered ${res.status}`);
  } else {
    log(`/timelapse/days answered ${res.status}; waiting`);
  }
  await new Promise((r) => setTimeout(r, 60_000));
}

// From here a failure throws, so the browser is closed before the exit.
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: true, viewport: { width: 1280, height: 1000 } });
  const page = await context.newPage();
  page.on('pageerror', (e) => log('page error:', e.message));
  await page.goto(`${o.base}/admin/timelapse/`);
  await page.fill('#token', token);
  await page.click('text=Unlock');
  const ready = () => page.waitForFunction(() => !document.querySelector('.controls button.accent')?.disabled, null, { timeout: 300_000 });
  await page.waitForSelector('.controls select', { timeout: 120_000 });
  const pick = async (n, value) => {
    await page.selectOption(`.controls select >> nth=${n}`, value);
    await page.waitForTimeout(500);
    await ready();
  };
  // The page opens the newest day by itself, which may be too short to
  // export (Export stays off); pick the one asked for first.
  await pick(0, o.date);
  await pick(1, o.preset);
  await pick(2, o.theme);
  await page.fill('.controls input[type=number]', o.seconds);
  for (const [n, v] of [[0, o.from], [1, o.to]]) if (v) await page.fill(`.controls input[type=time] >> nth=${n}`, v);
  // The time inputs act on change.
  await page.locator('.controls input[type=time] >> nth=1').dispatchEvent('change');
  await page.locator('.controls input[type=time] >> nth=0').dispatchEvent('change');
  await ready();
  log('rendering:', (await page.textContent('.controls p.hint'))?.trim());
  await page.click('text=Export the video');
  // Progress now and then, until the download link (or the error) appears.
  const started = Date.now();
  for (;;) {
    const done = await page.waitForSelector('text=Download the video', { timeout: 60_000 }).catch(() => null);
    if (done) break;
    const failed = await page.locator('.controls .bad').textContent({ timeout: 1_000 }).catch(() => null);
    if (failed) throw new Error(failed);
    log((await page.textContent('.progress .meta').catch(() => ''))?.trim() || 'starting');
    if (Date.now() - started > 12 * 3_600_000) throw new Error('still rendering after 12 hours');
  }
  log((await page.textContent('.progress .meta'))?.trim());
  mkdirSync(o.out, { recursive: true });
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('text=Download the video')]);
  const file = path.resolve(o.out, download.suggestedFilename());
  await download.saveAs(file);
  log('saved', file);
} catch (err) {
  log(`failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
