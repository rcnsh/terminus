/**
 * The street map's pieces from R2 (map.ts): exact byte ranges with an empty
 * edge cache, R2's own answers when there is no cache (304, 404, ranges), and
 * a file replaced while its pieces were cached.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { FROZEN_NOW, installGlobals, makeBucket, makeCtx, makeEnv, makeFetch } from './_stubs.mjs';
import worker from '../src/index.ts';

const BASE = 'https://bus.example.test';
const SIZE = 2000;
const bytesOf = (seed) => Uint8Array.from({ length: SIZE }, (_, i) => (i * 7 + seed) % 251);

// The Worker remembers the file's ETag per isolate for five minutes: each
// test starts well past the last one's, so none sees another's file.
let clock = FROZEN_NOW;
function setup(files) {
  clock += 3_600_000;
  installGlobals(makeFetch(), clock);
  const bucket = makeBucket(async (key) => files.get(key));
  const env = { ...makeEnv(), DOWNLOADS: bucket };
  const get = async (path, headers = {}) => {
    const ctx = makeCtx();
    const res = await worker.fetch(new Request(BASE + path, { headers }), env, ctx);
    await ctx.settle();
    return res;
  };
  return { env, bucket, get };
}
const body = async (res) => new Uint8Array(await res.arrayBuffer());

// First, while this isolate knows nothing of the file: with no ETag to go
// by, a refused read can only be a 429, not a 404.
test('reading R2 for the file is refused past RL_MAP, with a retry-after', async () => {
  const { env, get } = setup(new Map([['map/campus.pmtiles', bytesOf(7)]]));
  env.RL_MAP = { limit: async () => ({ success: false }) };
  const res = await get('/map/campus.pmtiles', { range: 'bytes=0-99' });
  assert.equal(res.status, 429);
  assert.equal(res.headers.get('retry-after'), '60');
});

test('the last 512 bytes, with nothing cached yet: 206 with the exact range and length', async () => {
  const data = bytesOf(1);
  const { get } = setup(new Map([['map/campus.pmtiles', data]]));
  const res = await get('/map/campus.pmtiles', { range: 'bytes=-512' });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('content-range'), `bytes ${SIZE - 512}-${SIZE - 1}/${SIZE}`);
  assert.equal(res.headers.get('content-length'), '512');
  assert.deepEqual(await body(res), data.slice(SIZE - 512));
});

test('bytes 100 to 199: 206, exactly those bytes, then from the cache with no R2 read', async () => {
  const data = bytesOf(2);
  const { get, bucket } = setup(new Map([['map/campus.pmtiles', data]]));
  const res = await get('/map/campus.pmtiles', { range: 'bytes=100-199' });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('content-range'), `bytes 100-199/${SIZE}`);
  assert.equal(res.headers.get('content-length'), '100');
  assert.deepEqual(await body(res), data.slice(100, 200));
  const reads = bucket.gets;
  const again = await get('/map/campus.pmtiles', { range: 'bytes=100-199' });
  assert.equal(again.status, 206);
  assert.equal(again.headers.get('content-range'), `bytes 100-199/${SIZE}`);
  assert.deepEqual(await body(again), data.slice(100, 200));
  assert.equal(bucket.gets, reads, 'the piece came from the edge cache');
});

test('a map file that is not in R2 is a 404, for the tiles and for a font', async () => {
  const { get } = setup(new Map());
  assert.equal((await get('/map/campus.pmtiles', { range: 'bytes=0-99' })).status, 404);
  assert.equal((await get('/map/campus.pmtiles')).status, 404);
  assert.equal((await get('/map/fonts/Noto%20Sans%20Regular/0-255.pbf')).status, 404);
});

test('with no edge cache, R2 answers itself: its range, its 304, its 404', async () => {
  const data = bytesOf(3);
  const { get } = setup(new Map([['map/campus.pmtiles', data]]));
  delete globalThis.caches;
  const part = await get('/map/campus.pmtiles', { range: 'bytes=100-199' });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), `bytes 100-199/${SIZE}`);
  assert.equal(part.headers.get('content-length'), '100');
  assert.deepEqual(await body(part), data.slice(100, 200));
  const etag = part.headers.get('etag');
  assert.ok(etag);
  // R2's onlyIf says the client's copy is current.
  const same = await get('/map/campus.pmtiles', { 'if-none-match': etag });
  assert.equal(same.status, 304);
  assert.equal(same.headers.get('etag'), etag);
  assert.equal((await get('/map/campus.pmtiles', { 'if-none-match': '"something-else"' })).status, 200);
  const { get: getNone } = setup(new Map());
  delete globalThis.caches;
  assert.equal((await getNone('/map/campus.pmtiles')).status, 404);
});

test('a font asked for with a range and an ETag that matches: R2 answers 304', async () => {
  const font = bytesOf(4);
  const { get } = setup(new Map([['map/fonts/Noto Sans Regular/0-255.pbf', font]]));
  const first = await get('/map/fonts/Noto%20Sans%20Regular/0-255.pbf');
  assert.equal(first.status, 200);
  const etag = first.headers.get('etag');
  const res = await get('/map/fonts/Noto%20Sans%20Regular/0-255.pbf', { range: 'bytes=0-9', 'if-none-match': etag });
  assert.equal(res.status, 304);
});

test('a map file replaced since its pieces were cached is served new, never mixed with the old', async () => {
  const files = new Map([['map/campus.pmtiles', bytesOf(5)]]);
  const { get } = setup(files);
  const old = await get('/map/campus.pmtiles', { range: 'bytes=0-99' });
  assert.deepEqual(await body(old), bytesOf(5).slice(0, 100));
  const oldTag = old.headers.get('etag');

  // A new upload, inside the five minutes the old ETag is trusted for.
  const fresh = bytesOf(6);
  files.set('map/campus.pmtiles', fresh);
  const other = await get('/map/campus.pmtiles', { range: 'bytes=100-199' });
  assert.equal(other.status, 206);
  assert.deepEqual(await body(other), fresh.slice(100, 200), 'R2 refused the old ETag, so the new file answered');
  assert.notEqual(other.headers.get('etag'), oldTag);
  // The piece cached from the old file is no longer used.
  const again = await get('/map/campus.pmtiles', { range: 'bytes=0-99' });
  assert.deepEqual(await body(again), fresh.slice(0, 100));
  assert.equal(again.headers.get('content-range'), `bytes 0-99/${SIZE}`);
});

test('the stable site and the beta share one edge cache but never serve each other its map files', async () => {
  const stableFont = bytesOf(5);
  const betaFont = bytesOf(6);
  const { get: stable } = setup(new Map([['map/fonts/Noto Sans Regular/0-255.pbf', stableFont], ['map/campus.pmtiles', bytesOf(8)]]));
  // Same cache (installed by setup above), the beta's own bucket.
  const betaEnv = { ...makeEnv(), PUBLIC_ORIGIN: 'https://beta.terminus.run', DOWNLOADS: makeBucket(async (key) => new Map([['map/fonts/Noto Sans Regular/0-255.pbf', betaFont], ['map/campus.pmtiles', bytesOf(9)]]).get(key)) };
  const beta = async (path, headers = {}) => {
    const ctx = makeCtx();
    const res = await worker.fetch(new Request(BASE + path, { headers }), betaEnv, ctx);
    await ctx.settle();
    return res;
  };
  const font = '/map/fonts/Noto%20Sans%20Regular/0-255.pbf';
  assert.deepEqual(await body(await stable(font)), stableFont);
  assert.deepEqual(await body(await beta(font)), betaFont, 'the beta reads its own font, not the stable one cached');
  assert.deepEqual(await body(await stable(font)), stableFont);
  const stableTag = (await stable('/map/campus.pmtiles', { range: 'bytes=0-9' })).headers.get('etag');
  const betaTag = (await beta('/map/campus.pmtiles', { range: 'bytes=0-9' })).headers.get('etag');
  assert.notEqual(stableTag, betaTag, 'each site has its own map file');
  assert.equal((await stable('/map/campus.pmtiles', { range: 'bytes=0-9' })).headers.get('etag'), stableTag);
});
