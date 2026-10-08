/**
 * The web app's service worker (apps/web/public/sw.js), run in a stand-in
 * service-worker scope: its own `self`, Cache Storage held in memory, and a
 * `fetch` each test answers. Which way each address is fetched, the race
 * between the network and the kept copy, the account's kept replies (and
 * their going at sign-out), and what is never kept.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { read } from './_web.mjs';

const ORIGIN = 'https://terminus.example';
const SOURCE = read('sw.js');
/** The worker's waits (SLOW_MS, 4 s) run this many times faster here. */
const SPEED = 100;

const keyOf = (req) => (typeof req === 'string' ? new URL(req, ORIGIN).href : req.url);

/** One cache: replies by address, each match a fresh copy, as the browser's. */
function memoryCache() {
  const kept = new Map();
  return {
    kept,
    async match(req) {
      return kept.get(keyOf(req))?.clone();
    },
    async put(req, res) {
      kept.set(keyOf(req), res.clone());
    },
    async delete(req) {
      return kept.delete(keyOf(req));
    },
    async keys() {
      return [...kept.keys()].map((u) => new Request(u));
    },
    async add(req) {
      const res = await scope.fetch(new Request(new URL(req, ORIGIN)));
      if (!res.ok) throw new TypeError('not ok');
      kept.set(keyOf(req), res);
    },
    async addAll(list) {
      for (const r of list) await this.add(r);
    },
  };
}

let scope;

/** A fresh worker: sw.js run in its own scope, with `fetch` answering. */
function worker({ fetch = () => Promise.reject(new TypeError('offline')), language = 'en-SG' } = {}) {
  const listeners = {};
  const stores = new Map();
  const caches = {
    async open(name) {
      if (!stores.has(name)) stores.set(name, memoryCache());
      return stores.get(name);
    },
    async delete(name) {
      return stores.delete(name);
    },
    async has(name) {
      return stores.has(name);
    },
    async keys() {
      return [...stores.keys()];
    },
    async match(req) {
      for (const c of stores.values()) {
        const hit = await c.match(req);
        if (hit) return hit;
      }
      return undefined;
    },
  };
  const self = {
    location: new URL(`${ORIGIN}/sw.js`),
    navigator: { language, onLine: true },
    addEventListener: (type, f) => {
      listeners[type] = f;
    },
    skipWaiting: async () => {},
    clients: { claim: async () => {}, matchAll: async () => [], openWindow: async () => null },
  };
  const ctx = {
    self,
    caches,
    fetch,
    navigator: self.navigator,
    Request,
    Response,
    Headers,
    URL,
    URLSearchParams,
    AbortSignal,
    setTimeout: (f, ms, ...args) => setTimeout(f, ms / SPEED, ...args),
    clearTimeout,
  };
  vm.createContext(ctx);
  vm.runInContext(SOURCE, ctx);
  scope = ctx;
  /** A request through the worker: what it answered with (null: left to the browser), and what it carried on with. */
  const dispatch = (path, init = {}) => {
    let responded = null;
    const waits = [];
    listeners.fetch({
      request: new Request(new URL(path, ORIGIN), init),
      respondWith: (p) => {
        responded = Promise.resolve(p);
      },
      waitUntil: (p) => waits.push(p),
    });
    return { responded, waits };
  };
  return { ctx, caches, stores, listeners, dispatch, get: (name) => vm.runInContext(name, ctx) };
}

const json = (body, init = {}) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init });
/** [p], or a failure after a while: a worker that waits for ever fails the test rather than hanging it. */
function within(p, ms = 2_000) {
  let timer;
  const late = new Promise((_, fail) => {
    timer = setTimeout(fail, ms, new Error('no answer'));
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}
/** A fetch that answers only when told to: `hold.release(res)`. */
function held() {
  let release;
  const p = new Promise((ok) => {
    release = ok;
  });
  return { promise: p, release: (res) => release(res) };
}

test('each address gets its way of fetching, and the live ones are left alone', () => {
  const w = worker({ fetch: () => Promise.resolve(new Response('')) });
  const calls = [];
  // The strategies are the script's own functions: swapped for ones that only note the call.
  for (const name of ['networkFirst', 'cacheFirst', 'shellFile', 'tiles', 'networkThenKept']) {
    w.ctx[name] = (req, arg) => {
      calls.push([name, typeof arg === 'string' ? arg : null]);
      return new Response('');
    };
  }
  const way = (path, init) => {
    calls.length = 0;
    const { responded } = w.dispatch(path, init);
    return responded ? (calls[0] ?? ['fetch']) : null;
  };
  const SHELL = w.get('SHELL');
  const cases = [
    // The account's replies: the network first, the kept copy without it.
    ['/me', ['networkFirst', null]],
    ['/me/next?lat=1.3&lon=103.7&h12=1', ['networkFirst', null]],
    ['/me/day', ['networkFirst', null]],
    // The app's files: from the network, the copy when it's slow.
    ['/app/', ['shellFile', '/app/']],
    ['/app/app.js', ['shellFile', '/app/app.js']],
    ['/assets/zh.js', ['shellFile', '/assets/zh.js']],
    // Versioned in their address: the copy first, in the app's cache or the map's.
    ['/vendor/preact-10.29.8/preact.mjs', ['cacheFirst', SHELL]],
    ['/vendor/maplibre-gl@6.11.2/maplibre-gl.js', ['cacheFirst', null]],
    ['/map/fonts/Noto%20Sans%20Regular/0-255.pbf', ['cacheFirst', null]],
    ['/map/sprites/v4/light.png', ['cacheFirst', null]],
    ['/map/campus.pmtiles', ['tiles', null]],
    ['/app/map.js', ['networkThenKept', null]],
    ['/campus', ['networkThenKept', null]],
    ['/map/style.json', ['networkThenKept', null]],
    // Never kept: live times, other pages, the timelapse's encoder, other sites.
    ['/arrivals?stop=COM3', null],
    ['/buses?svc=A1', null],
    ['/me/nearby', null],
    ['/line?svc=D1', null],
    ['/account/app.js', null],
    ['/vendor/mediabunny@1.61.3/mediabunny.min.mjs', null],
    ['https://elsewhere.example/app/app.js', null],
  ];
  for (const [path, expected] of cases) assert.deepEqual(way(path), expected, path);
  // Only GETs are kept; a POST to /me/next goes straight through.
  assert.equal(way('/me/next', { method: 'POST', body: '{}' }), null);
  // Signing in or out goes through the worker, which empties the kept replies.
  assert.deepEqual(way('/auth/logout', { method: 'POST' }), ['fetch']);
  assert.equal(way('/auth/logout'), null);
});

test('soonest: the network when it answers in time, else the kept copy, else the network after all', async () => {
  const { ctx } = worker();
  const wait = 20;
  const event = () => ({ waits: [], waitUntil(p) { this.waits.push(p); } });
  const late = (res, ms) => new Promise((ok) => setTimeout(ok, ms, res));
  const copy = async () => new Response('kept');
  const none = async () => undefined;
  const text = async (p) => (await p).text();

  assert.equal(await text(ctx.soonest(Promise.resolve(new Response('net')), copy, event(), wait)), 'net');
  // Slow: the copy, while the network carries on in the event's lifetime.
  const e = event();
  assert.equal(await text(ctx.soonest(late(new Response('net'), 200), copy, e, wait)), 'kept');
  assert.equal(e.waits.length, 1);
  // Slow with nothing kept: the network's answer, however long it takes.
  assert.equal(await text(ctx.soonest(late(new Response('net'), 60), none, event(), wait)), 'net');
  // Failed: the copy at once, not after the wait.
  const started = Date.now();
  assert.equal(await text(ctx.soonest(Promise.reject(new TypeError('offline')), copy, event(), 5_000)), 'kept');
  assert.ok(Date.now() - started < 1_000);
  // Failed with nothing kept: the failure.
  await assert.rejects(ctx.soonest(Promise.reject(new TypeError('offline')), none, event(), wait), { message: 'offline' });
});

test('/me/next: kept with when it was fetched, and served after SLOW_MS when the network hangs', async () => {
  let answer = () => Promise.resolve(json({ label: 'fresh' }));
  const w = worker({ fetch: (req) => answer(req) });
  const zh = { headers: { 'accept-language': 'zh-Hans' } };
  const before = Date.now();
  const first = await w.dispatch('/me/next?lat=1.3&lon=103.7', zh).responded;
  assert.equal((await first.json()).label, 'fresh');
  assert.equal(first.headers.get('x-terminus-cached'), null, 'the live reply is not marked');

  // The network hangs: after SLOW_MS (here sped up), the kept copy, marked.
  const hang = held();
  answer = () => hang.promise;
  const started = Date.now();
  const { responded, waits } = w.dispatch('/me/next?lat=1.31&lon=103.71', zh);
  const res = await within(responded);
  const took = (Date.now() - started) * SPEED;
  assert.ok(took >= w.get('SLOW_MS') * 0.9, `waited ${took} ms (scaled)`);
  assert.equal((await res.json()).label, 'fresh');
  const at = Number(res.headers.get('x-terminus-cached'));
  assert.ok(at >= before && at <= Date.now(), 'marked with when it was fetched');
  // The late reply still replaces the copy, for next time.
  hang.release(json({ label: 'late' }));
  await within(Promise.all(waits));
  answer = () => Promise.reject(new TypeError('offline'));
  assert.equal((await (await w.dispatch('/me/next', zh).responded).json()).label, 'late');
});

test('/me/next: one copy per place, stop, clock and language, never one for another', async () => {
  let n = 0;
  let online = true;
  const w = worker({ fetch: (req) => (online ? Promise.resolve(json({ n: ++n, url: req.url })) : Promise.reject(new TypeError('offline'))) });
  const en = { headers: { 'accept-language': 'en' } };
  await w.dispatch('/me/next?lat=1.3&lon=103.7&acc=10', en).responded;
  await w.dispatch('/me/next?to=COM3', en).responded;
  online = false;
  // Somewhere else, the same plan: its copy.
  assert.equal((await (await w.dispatch('/me/next?lat=1.2&lon=103.8', en).responded).json()).n, 1);
  // A stop's card never stands in for the plan's, nor the plan's for a stop's.
  assert.equal((await (await w.dispatch('/me/next?to=COM3&lat=1', en).responded).json()).n, 2);
  await assert.rejects(w.dispatch('/me/next?to=UTOWN', en).responded);
  // Another language or clock has no copy.
  await assert.rejects(w.dispatch('/me/next', { headers: { 'accept-language': 'zh-Hans' } }).responded);
  await assert.rejects(w.dispatch('/me/next?h12=1', en).responded);
});

test('/me/next: a server error gives the kept copy; a 401 empties the kept replies', async () => {
  let status = 200;
  const w = worker({ fetch: () => Promise.resolve(status === 200 ? json({ ok: 1 }) : json({ error: 'x' }, { status })) });
  await w.dispatch('/me/next').responded;
  status = 503;
  const res = await w.dispatch('/me/next').responded;
  assert.equal(res.status, 200);
  assert.ok(res.headers.get('x-terminus-cached'));
  status = 401;
  assert.equal((await w.dispatch('/me/next').responded).status, 401);
  assert.equal(await w.caches.has(w.get('DATA')), false);
});

test('signing in or out empties the kept replies, and a reply on its way then is not kept', async () => {
  for (const [method, path] of [['POST', '/auth/logout'], ['POST', '/auth/code'], ['POST', '/auth/verify'], ['POST', '/auth/anon/web'], ['DELETE', '/me/sessions'], ['DELETE', '/me']]) {
    let hang = null;
    const w = worker({ fetch: (req) => (hang && req.url.includes('/me/next') ? hang.promise : Promise.resolve(json({ who: 'a' }))) });
    await w.dispatch('/me/next').responded;
    assert.ok(await w.caches.has(w.get('DATA')));
    // A refresh starts, then the account changes before it answers.
    hang = held();
    const { responded, waits } = w.dispatch('/me/next');
    await new Promise((ok) => setImmediate(ok));
    await w.dispatch(path, { method }).responded;
    assert.equal(await w.caches.has(w.get('DATA')), false, `${method} ${path}`);
    hang.release(json({ who: 'a' }));
    await within(responded);
    await within(Promise.all(waits));
    // The old account's reply never reaches the next one to sign in.
    const kept = await (await w.caches.open(w.get('DATA'))).keys();
    assert.deepEqual(kept, [], `${method} ${path}: nothing kept`);
  }
});

test("the timelapse's video encoder is never kept, nor answered by the worker", async () => {
  let fetched = 0;
  const w = worker({ fetch: () => {
      fetched++;
      return Promise.resolve(new Response('x'));
    }, });
  const { responded } = w.dispatch('/vendor/mediabunny@1.61.3/mediabunny.min.mjs');
  assert.equal(responded, null);
  assert.equal(fetched, 0);
  assert.deepEqual(await w.caches.keys(), []);
});

test("installing keeps every app file, and Chinese only for a browser that reads it", async () => {
  for (const [language, withZh] of [['en-SG', false], ['zh-CN', true]]) {
    const w = worker({ fetch: (req) => Promise.resolve(new Response(new URL(req.url).pathname)), language });
    const waits = [];
    w.listeners.install({ waitUntil: (p) => waits.push(p) });
    await Promise.all(waits);
    const kept = (await (await w.caches.open(w.get('SHELL'))).keys()).map((r) => new URL(r.url).pathname);
    for (const f of w.get('SHELL_FILES')) assert.ok(kept.includes(f), f);
    assert.equal(kept.includes('/assets/zh.js'), withZh, language);
  }
});
