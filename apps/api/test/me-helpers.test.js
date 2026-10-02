/**
 * Helpers in me.ts.
 *
 * A saved profile can stop validating whole: a weekly scrape drops a stop
 * someone uses. getProfile then salvages what still holds; it used to fall
 * back to the defaults for the day's hours, usual times and one-off trips,
 * and the next save wrote those defaults back over the user's settings.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { salvageProfile } from '../src/me.ts';

const known = new Set(['PGP', 'COM3', 'UTOWN']);
const ok = (c) => known.has(c);

test('a vanished stop drops only what used it, not the hours or usual times', () => {
  const p = salvageProfile(
    {
      home: { stops: ['GONE-STOP', 'PGP'] },
      dayStartMin: 420,
      dayEndMin: 1200,
      places: [{ key: 'gym', label: 'Gym', to: 'UTOWN' }, { key: 'old', label: 'Old', to: 'GONE-STOP' }],
      usual: [{ place: 'gym', day: 2, atMin: 1080 }, { place: 'old', day: 3, atMin: 600 }],
      once: [{ date: '2026-10-05', arriveByMin: 600, to: 'COM3', label: 'Talk' }, { date: '2026-10-05', arriveByMin: 700, to: 'GONE-STOP', label: 'X' }],
      trips: [],
      manual: [],
      lang: 'zh',
    },
    ok,
  );
  assert.equal(p.dayStartMin, 420);
  assert.equal(p.dayEndMin, 1200);
  assert.deepEqual(p.home, { stops: ['PGP'] });
  assert.deepEqual(p.places.map((x) => x.key), ['gym']);
  assert.deepEqual(p.usual, [{ place: 'gym', day: 2, atMin: 1080 }], 'the usual time of a dropped place goes with it');
  assert.deepEqual(p.once.map((o) => o.label), ['Talk']);
  assert.equal(p.lang, 'zh');
});

test('hours that make no sense fall back to the defaults', () => {
  const p = salvageProfile({ dayStartMin: 1300, dayEndMin: 400 }, ok);
  assert.equal(p.dayStartMin, 360);
  assert.equal(p.dayEndMin, 1080);
});

test('a request body past the limit is refused while it is read', async () => {
  const { readCapped } = await import('../src/me.ts');
  // Chunked: no content-length to refuse it up front.
  const big = new ReadableStream({
    start(c) {
      for (let i = 0; i < 10; i++) c.enqueue(new TextEncoder().encode('x'.repeat(1000)));
      c.close();
    },
  });
  const req = new Request('https://x/', { method: 'POST', body: big, duplex: 'half' });
  assert.equal(await readCapped(req, 4000), null);
  const small = new Request('https://x/', { method: 'POST', body: '{"a":1}' });
  assert.equal(await readCapped(small, 4000), '{"a":1}');
});
