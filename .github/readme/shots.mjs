// The README's pictures, light and dark, from the real site run by the dev
// stub: the web app's Now and Buses tabs, and the map with D2 picked. The
// banner is composed from them afterwards: node .github/readme/hero.mjs
//
//   node .github/readme/shots.mjs
//
// Needs Playwright (PLAYWRIGHT=/path/to/node_modules/playwright if it isn't
// resolvable from here), a Chromium (CHROME, or Playwright's own) and cwebp.
// Take it in Singapore's daytime: the stub's class is 50 minutes from the real
// clock, and the app's sky follows the real hour.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const { chromium } = await import(process.env.PLAYWRIGHT ? join(process.env.PLAYWRIGHT, 'index.mjs') : 'playwright');
const origin = 'http://localhost:8787';
const email = 'you@u.nus.edu';

// The stub prints the sign-in code on its stdout.
const stub = spawn(process.execPath, ['scripts/dev-stub.mjs'], { cwd: join(root, 'apps/api'), stdio: ['ignore', 'pipe', 'inherit'] });
let out = '';
stub.stdout.on('data', (d) => { out += d; });
const until = async (test) => { for (let i = 0; i < 100 && !test(); i++) await new Promise((r) => setTimeout(r, 100)); };
await until(() => out.includes('localhost:8787'));

const tmp = mkdtempSync(join(tmpdir(), 'readme-shots-'));
const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
try {
  const signIn = await browser.newContext();
  await signIn.request.post(`${origin}/auth/login`, { data: { email } });
  await until(() => /sign-in code: (\w{6})/.test(out));
  await signIn.request.post(`${origin}/auth/code`, { data: { email, code: out.match(/sign-in code: (\w{6})/)[1] } });
  const storageState = await signIn.storageState();
  await signIn.close();

  const webp = (png, to) => execFileSync('cwebp', ['-quiet', '-q', '85', png, '-o', join(root, to)]);
  const shoot = async (scheme, { name, to, viewport, path, signedIn = true, at, act, clip }) => {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2, colorScheme: scheme, serviceWorkers: 'block', storageState: signedIn ? storageState : undefined });
    const page = await ctx.newPage();
    if (at) await page.clock.install({ time: new Date(at) });
    await page.goto(origin + path);
    await page.waitForTimeout(4000);
    if (act) await act(page);
    const png = join(tmp, `${name}-${scheme}.png`);
    await page.screenshot({ path: png, clip: clip && (await clip(page)) });
    webp(png, `${to}/${name}-${scheme}.webp`);
    await ctx.close();
  };
  const tab = (name, then) => async (page) => {
    await page.locator('.tabbar').getByText(name, { exact: true }).click();
    await page.waitForTimeout(5000);
    if (then) await then(page);
  };
  const phone = { width: 390, height: 844 };

  for (const scheme of ['light', 'dark']) {
    await shoot(scheme, { name: 'now', to: '.github/readme', viewport: phone, path: '/app/' });
    await shoot(scheme, { name: 'buses', to: '.github/readme', viewport: phone, path: '/app/', act: tab('Buses') });
    await shoot(scheme, {
      name: 'map', to: 'apps/web/public/assets/shots', viewport: { width: 1200, height: 700 }, path: '/app/',
      act: tab('Map', async (page) => { await page.locator('.map-tab').getByText('D2', { exact: true }).first().click(); await page.waitForTimeout(7000); }),
    });
  }
} finally {
  await browser.close();
  stub.kill();
  rmSync(tmp, { recursive: true, force: true });
}
