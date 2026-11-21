import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

import { buildCampusMap, shapeFor } from '../../api/src/map/campus.ts';
import { placeBuses, pointAlong } from '../../api/src/map/buses.ts';
import { GRAPH } from '../../api/src/answer/graph.ts';
import { haversineM } from '../../api/src/geo.ts';

const PUBLIC = new URL('../public/', import.meta.url);
registerHooks({
  resolve: (spec, ctx, next) => next(/^\/(assets|account|app|vendor)\//.test(spec) ? new URL(`.${spec}`, PUBLIC).href : spec, ctx),
});
globalThis.document ??= { addEventListener() {} };
const { aheadBy, busesWaitMs, campusBounds, freePadding, pathOf, pointAt, positionAt, slideMs } = await import('../public/app/map.js');

const CAMPUS = buildCampusMap(GRAPH);
const SERVICES = Object.keys(GRAPH.routes).filter((svc) => shapeFor(svc, GRAPH.routes[svc]));
const pathFor = (svc) => pathOf(CAMPUS.routes[svc].line, CAMPUS.routes[svc].loop);

test('every service has a road shape to slide along', () => {
  assert.deepEqual(SERVICES.sort(), Object.keys(GRAPH.routes).sort());
});

test('metres along a line are the API’s metres: the same point within 1 m all the way along', () => {
  for (const svc of SERVICES) {
    const shape = shapeFor(svc, GRAPH.routes[svc]);
    const path = pathFor(svc);
    const api = pointAlong(shape, Infinity).along;
    assert.ok(Math.abs(path.total - api) < 1, `${svc}: ${path.total} m on the map, ${api} m in the API`);
    for (let m = 0; m <= path.total; m += 25) {
      const a = pointAt(path, m);
      const b = pointAlong(shape, m);
      assert.ok(haversineM(a.lat, a.lon, b.lat, b.lon) < 1, `${svc} at ${m} m`);
    }
  }
});

test('the map takes a loop from /campus, not from where its line ends (A1 ends some 40 m from its start)', () => {
  for (const svc of SERVICES) assert.equal(pathFor(svc).loop, GRAPH.loops[svc], svc);
  const [a, z] = [CAMPUS.routes.A1.line[0], CAMPUS.routes.A1.line.at(-1)];
  assert.ok(haversineM(a[1], a[0], z[1], z[0]) > 5, 'A1’s ends meet: this test no longer covers the gap');
});

async function drive(svc) {
  const shape = shapeFor(svc, GRAPH.routes[svc]);
  const total = pointAlong(shape, Infinity).along;
  const laps = GRAPH.loops[svc] ? 1.5 : 1;
  const shown = [];
  let tracks = {};
  for (let m = 0, now = 0; m <= total * laps; m += 120, now += 15_000) {
    const p = pointAlong(shape, m % total);
    const raw = [{ plate: 'PX1', lat: p.lat, lon: p.lon, heading: p.bearing, speed: 30, crowd: null }];
    const placed = await placeBuses(GRAPH, svc, raw, now, tracks, shape);
    tracks = placed.tracks;
    assert.equal(placed.buses.length, 1, `${svc}: placed at ${m} m`);
    shown.push({ ...placed.buses[0], offset: [0, 0] });
  }
  return shown;
}

test('A1 slides on past KRB, round its loop, rather than jumping back to the start', async () => {
  const path = pathFor('A1');
  const shown = await drive('A1');
  const i = shown.findIndex((b, k) => k > 0 && b.along < shown[k - 1].along);
  assert.ok(i > 0, 'the bus never came round to the start');
  const d = aheadBy(path, shown[i - 1], shown[i]);
  assert.ok(d != null && d > 0 && d < path.total / 2, `from ${shown[i - 1].along} m to ${shown[i].along} m: ${d}`);
  const g = { from: shown[i - 1], to: shown[i], start: 0, path, d, ms: slideMs(d) };
  const mid = positionAt(g, g.ms / 2);
  assert.ok(mid.along >= 0 && mid.along < path.total);
});

test('on every line a bus never slides backwards, never jumps between stops it drove past, and slides for 1 to 4 s', async () => {
  for (const svc of SERVICES) {
    const path = pathFor(svc);
    const shown = await drive(svc);
    for (let k = 1; k < shown.length; k++) {
      const [f, b] = [shown[k - 1], shown[k]];
      const d = aheadBy(path, f, b);
      const on = GRAPH.loops[svc] ? (((b.along - f.along) % path.total) + path.total) % path.total : b.along - f.along;
      if (on > 0 && on <= 1_500)
        assert.ok(d != null && Math.abs(d - on) < 0.01, `${svc}: ${f.along} m to ${b.along} m slides ${d}, not ${on}`);
      else assert.equal(d, null, `${svc}: ${f.along} m to ${b.along} m`);
      if (d == null) continue;
      const ms = slideMs(d);
      assert.ok(ms >= 1_000 && ms <= 4_000, `${svc}: ${d} m takes ${ms} ms`);
      const g = { from: f, to: b, start: 0, path, d, ms };
      let was = 0;
      for (let t = 0; t <= ms; t += ms / 20) {
        const p = positionAt(g, t);
        const gone = ((((p.along - f.along + path.total / 2) % path.total) + path.total) % path.total) - path.total / 2;
        assert.ok(gone + 0.01 >= was && gone <= d + 0.01, `${svc}: from ${f.along} m to ${b.along} m, back at ${t} ms`);
        was = Math.min(gone, d);
      }
      assert.equal(positionAt(g, ms), b);
    }
  }
});

test('a slide takes 1 s for a short hop, 100 m a second, and 4 s at most', () => {
  assert.equal(slideMs(1), 1_000);
  assert.equal(slideMs(250), 2_500);
  assert.equal(slideMs(1_500), 4_000);
});

test('on a one-way line, a bus back at the start jumps; it does not slide on round', () => {
  const path = pathFor('K');
  assert.equal(path.loop, false);
  assert.equal(aheadBy(path, { along: path.total - 10 }, { along: 10 }), null);
});

test('failed polls for the buses back off from 5 s to a minute, never before the server says', () => {
  assert.deepEqual(
    [0, 1, 2, 3, 4, 9].map((n) => busesWaitMs(n)),
    [5_000, 10_000, 20_000, 40_000, 60_000, 60_000],
  );
  assert.equal(busesWaitMs(0, 30_000), 30_000);
  assert.equal(busesWaitMs(4, 90_000), 90_000);
});

test("the first view frames the campus's stops and the whole line of each service that stays on it, not P's trip out", () => {
  const core = new Set(CAMPUS.stops.filter((s) => s.core).map((s) => s.code));
  const [[west, south], [east, north]] = campusBounds(CAMPUS);
  const stopsEast = Math.max(...CAMPUS.stops.filter((s) => core.has(s.code)).map((s) => s.lon));
  const onCampus = Object.keys(CAMPUS.routes).filter((svc) => CAMPUS.routes[svc].seq.every((code) => core.has(code)));
  assert.ok(!onCampus.includes('P') && onCampus.includes('K'), onCampus.join());
  for (const svc of onCampus)
    for (const [lon, lat] of CAMPUS.routes[svc].line)
      assert.ok(lon >= west && lon <= east && lat >= south && lat <= north, `${svc} at ${lon},${lat}`);
  const kEast = Math.max(...CAMPUS.routes.K.line.map((p) => p[0]));
  assert.ok(kEast > stopsEast && east === Math.max(kEast, ...onCampus.map((svc) => Math.max(...CAMPUS.routes[svc].line.map((p) => p[0])))));
  assert.ok(east < 103.79 && north < 1.31, `${east},${north}`);
});

function fitted(points, box, pad, maxZoom) {
  const merc = ([lon, lat]) => [(lon + 180) / 360, (1 - Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / Math.PI) / 2];
  const m = points.map(merc);
  const [x0, x1] = [Math.min(...m.map((p) => p[0])), Math.max(...m.map((p) => p[0]))];
  const [y0, y1] = [Math.min(...m.map((p) => p[1])), Math.max(...m.map((p) => p[1]))];
  const w = box.right - box.left - pad.left - pad.right;
  const h = box.bottom - box.top - pad.top - pad.bottom;
  const scale = Math.min(w / (x1 - x0), h / (y1 - y0), 512 * 2 ** maxZoom);
  const cx = box.left + pad.left + w / 2;
  const cy = box.top + pad.top + h / 2;
  return m.map(([x, y]) => [cx + (x - (x0 + x1) / 2) * scale, cy + (y - (y0 + y1) / 2) * scale]);
}

test("a chosen service's whole line fits the map's free area: clear of the pills, the status line, the buttons and an open sheet, at every width", () => {
  const rect = (left, top, right, bottom) => ({ left, top, right, bottom });
  const layout = (w, h, rail = 0) => ({
    box: rect(rail, 0, w, h),
    covers: [
      { rect: rect(rail, 10, w, 54), side: 'top' },
      { rect: rect(rail + 12, 62, rail + 128, 95), side: 'top' },
      { rect: rect(w - 39, h - 107, w - 10, h - 78), side: 'right' },
      { rect: rect(w - 39, h - 68, w - 10, h - 10), side: 'right' },
    ],
  });
  const widths = [
    layout(390, 784),
    layout(700, 940),
    layout(834, 1112, 88),
    layout(1024, 768, 88),
    layout(1210, 834, 88),
    layout(1280, 860, 88),
  ];
  const sheet = (w, h, rail, r, side) => {
    const l = layout(w, h, rail);
    l.covers.push({ rect: r, side, sheet: true });
    return l;
  };
  const sheets = [
    sheet(390, 784, 0, rect(0, 298, 390, 784), 'bottom'),
    sheet(390, 784, 0, rect(0, 420, 390, 784), 'bottom'),
    sheet(700, 940, 0, rect(16, 402, 376, 924), 'left'),
    sheet(834, 1112, 88, rect(104, 574, 464, 1096), 'left'),
    sheet(1024, 768, 88, rect(104, 300, 464, 752), 'left'),
    sheet(1280, 860, 88, rect(104, 340, 464, 844), 'left'),
  ];
  for (const { box, covers } of [...widths, ...sheets]) {
    const pad = freePadding(box, covers);
    for (const svc of Object.keys(CAMPUS.routes)) {
      if (svc === 'P') continue;
      for (const [x, y] of fitted(CAMPUS.routes[svc].line, box, pad, 16.5)) {
        const where = `${svc} at ${Math.round(x)},${Math.round(y)} in ${box.right - box.left}x${box.bottom}`;
        assert.ok(x >= box.left + 23.5 && x <= box.right - 23.5 && y >= box.top + 23.5 && y <= box.bottom - 23.5, `${where}: the margin`);
        for (const c of covers)
          assert.ok(
            x < c.rect.left - 23.5 || x > c.rect.right + 23.5 || y < c.rect.top - 23.5 || y > c.rect.bottom + 23.5,
            `${where}: under a cover`,
          );
      }
    }
  }
  const crowded = freePadding(rect(0, 0, 390, 400), [{ rect: rect(0, 0, 390, 380), side: 'top' }]);
  assert.ok(crowded.top + crowded.bottom <= 340);
  const tight = freePadding(rect(0, 0, 390, 784), [
    { rect: rect(0, 10, 390, 54), side: 'top' },
    { rect: rect(0, 200, 390, 784), side: 'bottom' },
  ]);
  assert.deepEqual([tight.top, tight.bottom], [54 + 14, 584 + 14], 'clear of both, the margins smaller');
});
