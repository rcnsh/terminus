import test from 'node:test';
import assert from 'node:assert/strict';

import graphJson from './fixtures/graph.json' with { type: 'json' };
import realGraph from '../data/stops.json' with { type: 'json' };
import serviceHoursJson from '../data/service-hours.json' with { type: 'json' };
import COM3_FIXTURE from './fixtures/stop-COM3.json' with { type: 'json' };
import UHALL_FIXTURE from './fixtures/stop-UHALL-OPP.json' with { type: 'json' };
import UHC_FIXTURE from './fixtures/stop-UHC.json' with { type: 'json' };
import CONNECTX_FIXTURE from './fixtures/connectx-ShuttleService-COM3.json' with { type: 'json' };
import {
  candidateStops,
  confidence,
  haversineM,
  indexGraph,
  hhmmToMin,
  mergeServiceHours,
  inService,
  pickAlt,
  reach,
  rideStops,
  resolveBerths,
  scoreOptions,
  nearestStop,
  walkAllTheWayS,
} from '../src/resolve.ts';
import { arrivalsProblem, busesProblem, crowdFromLoad, hasList, normalize, normalizeBuses, parseCrowd, parseEtaS, parseSeconds, pickList, proxyOk, proxyUrl, unwrap } from '../src/fms.ts';
import { buildAnswer, clampLabel, fitsTile, mins, shortStop, walkVerdict } from '../src/format.ts';
import { LABEL_MAX, WALK } from '../src/config.ts';
import { apiKeyHeaders, authUrl, extractSession, jwtExpMs, proxyHeaders } from '../src/auth.ts';

const GRAPH = graphJson;
const NOW = Date.UTC(2026, 7, 27, 1, 0, 0); // Thu 09:00 SGT

const arrivalsFor = (map) => new Map(Object.entries(map));
const sa = (code, arrivals, fetchedAt = NOW, stale = false) => [
  code,
  { code, arrivals, fetchedAt, stale, available: true },
];
/** The feed was unreachable for this stop: no data, as opposed to no bus. */
const unavailable = (code) => [code, { code, arrivals: [], fetchedAt: NOW, stale: false, available: false }];

/* ------------------------------------------------------------------ */
/* Direction: the whole point of the project                           */
/* ------------------------------------------------------------------ */

// The directional pair, 32 m apart -- inside GPS error near dense buildings.
const KRMRT = { code: 'KRMRT', name: 'Kent Ridge MRT', lat: 1.29473, lon: 103.78448 };
const OPPKRMRT = { code: 'OPPKRMRT', name: 'Opp Kent Ridge MRT', lat: 1.29497, lon: 103.78432 };

// The same pair as it really exists in the graph: 22 m apart, which is well
// inside GPS error next to the MRT viaduct.
const KR = { code: 'KR-MRT', name: 'KR MRT', lat: 1.29482, lon: 103.784413 };
const KR_OPP = { code: 'KR-MRT-OPP', name: 'Opp KR MRT', lat: 1.294962, lon: 103.784556 };

/** Two strictly linear routes: one side reaches UTown, the other cannot. */
const PAIR_GRAPH = {
  generated: NOW,
  stops: [
    KRMRT,
    OPPKRMRT,
    { code: 'UTOWN', name: 'University Town', lat: 1.30442, lon: 103.77337 },
    { code: 'MUSEUM', name: 'Museum', lat: 1.30201, lon: 103.77363 },
    { code: 'PGP', name: "Prince George's Park", lat: 1.29094, lon: 103.78065 },
    { code: 'KRB', name: 'Kent Ridge Bus Terminal', lat: 1.29452, lon: 103.7695 },
  ],
  routes: {
    NORTH: ['KRMRT', 'MUSEUM', 'UTOWN'],
    SOUTH: ['OPPKRMRT', 'PGP', 'KRB'],
  },
  loops: { NORTH: false, SOUTH: false },
};

test('standing on Opp Kent Ridge MRT heading to UTown returns the FURTHER stop', () => {
  // Exactly on top of the wrong-direction stop. Distance says OPPKRMRT.
  const input = { lat: OPPKRMRT.lat, lon: OPPKRMRT.lon, to: 'UTOWN', originCode: null };

  const dOpp = haversineM(input.lat, input.lon, OPPKRMRT.lat, OPPKRMRT.lon);
  const dKr = haversineM(input.lat, input.lon, KRMRT.lat, KRMRT.lon);
  assert.ok(dKr > dOpp, 'precondition: KRMRT is the further stop');
  assert.ok(dKr < 60, 'precondition: the pair is within GPS error of each other');

  const cands = candidateStops(PAIR_GRAPH, input);
  assert.deepEqual(
    cands.map((c) => c.stop.code),
    ['KRMRT'],
    'the near stop is dropped because nothing from it reaches UTown',
  );

  const options = scoreOptions(
    PAIR_GRAPH,
    cands,
    arrivalsFor(
      Object.fromEntries([
        sa('KRMRT', [{ svc: 'NORTH', etaS: 300, crowd: 'low', plate: 'PA1' }]),
        sa('OPPKRMRT', [{ svc: 'SOUTH', etaS: 60, crowd: 'low', plate: 'PA2' }]),
      ]),
    ),
    NOW,
  );

  assert.equal(options[0].stop.code, 'KRMRT');
  // ...even though the wrong-side bus is arriving four minutes sooner.
});

test('when every listed bus leaves too soon, the guess is a bus you can still reach', () => {
  const input = { lat: OPPKRMRT.lat, lon: OPPKRMRT.lon, to: 'UTOWN', originCode: null };
  // Twenty minutes' walk to the stop; the one bus listed is in two.
  const cands = candidateStops(PAIR_GRAPH, input).map((c) => ({ ...c, walkS: 1200 }));
  const [best] = scoreOptions(PAIR_GRAPH, cands, arrivalsFor(Object.fromEntries([sa('KRMRT', [{ svc: 'NORTH', etaS: 120, crowd: null, plate: null }])])), NOW);
  assert.equal(best.quality, 'scheduled');
  assert.ok(best.boardS >= 1200, `boards at ${best.boardS}s, before the walk is done`);
});

test('a bus that left while the answer aged is not offered as catchable', () => {
  const input = { lat: OPPKRMRT.lat, lon: OPPKRMRT.lon, to: 'UTOWN', originCode: null };
  const cands = candidateStops(PAIR_GRAPH, input).map((c) => ({ ...c, walkS: 0 }));
  // Fetched four minutes ago (now stale), when the bus was two minutes out.
  const old = arrivalsFor(Object.fromEntries([sa('KRMRT', [{ svc: 'NORTH', etaS: 120, crowd: null, plate: null }], NOW - 240_000, true)]));
  const [best] = scoreOptions(PAIR_GRAPH, cands, old, NOW);
  assert.notEqual(best.quality, 'stale', 'the bus has gone; only a guess is left');
  assert.ok(best.fetchedAt + best.boardS * 1000 >= NOW, 'never a departure in the past');
});

test('a headway guess from a stale stop stays a guess, not "stale" (measured)', () => {
  const input = { lat: OPPKRMRT.lat, lon: OPPKRMRT.lon, to: 'UTOWN', originCode: null };
  const cands = candidateStops(PAIR_GRAPH, input);
  // The feed's last answer for this stop is old, and had no NORTH bus in it.
  const old = arrivalsFor(Object.fromEntries([sa('KRMRT', [], NOW - 120_000, true)]));
  const [best] = scoreOptions(PAIR_GRAPH, cands, old, NOW);
  assert.equal(best.quality, 'scheduled');
});

test('on a loop route both sides reach UTown, but the wrong side loses on cost', () => {
  const input = { lat: KR_OPP.lat, lon: KR_OPP.lon, to: 'UTOWN', originCode: null };
  const cands = candidateStops(GRAPH, input);
  const codes = cands.map((c) => c.stop.code).sort();
  assert.deepEqual(codes, ['KR-MRT', 'KR-MRT-OPP'], 'both sides are genuine candidates on a loop');

  // Identical live times at both stops: only the hop count can decide.
  const options = scoreOptions(
    GRAPH,
    cands,
    arrivalsFor(
      Object.fromEntries([
        sa('KR-MRT', [{ svc: 'D2', etaS: 180, crowd: null, plate: null }]),
        sa('KR-MRT-OPP', [{ svc: 'D2', etaS: 180, crowd: null, plate: null }]),
      ]),
    ),
    NOW,
  );
  assert.equal(options[0].stop.code, 'KR-MRT');
  // Five stops the right way round against eleven the wrong way, on the real
  // D2 sequence. This is the bug the project exists to prevent.
  assert.equal(options[0].hops, 5);
  assert.equal(options.find((o) => o.stop.code === 'KR-MRT-OPP').hops, 11);
  assert.ok(confidence(options, true) > 0.9, 'a decisive margin should report high confidence');
});

test('the walk on from the stop counts in the ranking: the bus to the nearer side of a place wins', () => {
  const input = { lat: KR_OPP.lat, lon: KR_OPP.lon, to: 'UTOWN', originCode: null };
  const cands = candidateStops(GRAPH, input);
  const arrivals = arrivalsFor(
    Object.fromEntries([
      sa('KR-MRT', [{ svc: 'D2', etaS: 180, crowd: null, plate: null }]),
      sa('KR-MRT-OPP', [{ svc: 'D2', etaS: 180, crowd: null, plate: null }]),
    ]),
  );
  // As above, KR-MRT gets there first...
  assert.equal(scoreOptions(GRAPH, cands, arrivals, NOW)[0].stop.code, 'KR-MRT');
  // ...but not once its trip ends with a long walk on to the place and the other's doesn't.
  const endWalk = (o) => (o.stop.code === 'KR-MRT' ? 3_600 : 0);
  const options = scoreOptions(GRAPH, cands, arrivals, NOW, endWalk);
  assert.equal(options[0].stop.code, 'KR-MRT-OPP');
  // And it's sure of that by the same measure: an hour's margin, not a coin flip.
  assert.ok(confidence(options, true, endWalk) > 0.9, 'confidence uses the time to the place, as the ranking does');
});

test('near PGP Foyer, trips it would reach the long way round board at PGP instead', () => {
  // Between the two stops, closer to Foyer (40 m against 78 m). Foyer's
  // services leave the wrong way for everything except COM3.
  const at = { lat: 1.29125, lon: 103.7809 };
  const board = (to) => {
    const cands = candidateStops(realGraph, { ...at, to, originCode: null });
    const byStop = Object.fromEntries(
      cands.map((c) => sa(c.stop.code, c.legs.map((l) => ({ svc: l.svc, etaS: 240, crowd: null, plate: null })))),
    );
    return scoreOptions(realGraph, cands, arrivalsFor(byStop), NOW)[0].stop.code;
  };
  for (const to of ['KR-MRT', 'UHC', 'UTOWN', 'LT27']) assert.equal(board(to), 'PGP', to);
  assert.equal(board('COM3'), 'PGPR', 'COM3 really is the Foyer direction');
});

test('either side of the road counts: PGP to UHC takes A1 to Opp UHC in 4 stops', () => {
  const pgp = realGraph.stops.find((x) => x.code === 'PGP');
  const cands = candidateStops(realGraph, { lat: pgp.lat, lon: pgp.lon, to: 'UHC', originCode: null });
  const byStop = Object.fromEntries(
    cands.map((c) => sa(c.stop.code, c.legs.map((l) => ({ svc: l.svc, etaS: 240, crowd: null, plate: null })))),
  );
  const best = scoreOptions(realGraph, cands, arrivalsFor(byStop), NOW)[0];
  assert.equal(best.stop.code, 'PGP');
  assert.equal(best.svc, 'A1');
  assert.equal(best.hops, 4);
});

test('standing at the opposite stop of the destination is not a boarding option', () => {
  const opp = realGraph.stops.find((x) => x.code === 'UHC-OPP');
  const cands = candidateStops(realGraph, { lat: opp.lat, lon: opp.lon, to: 'UHC', originCode: null });
  assert.ok(cands.every((c) => c.stop.code !== 'UHC-OPP' || c.legs.length === 0));
});

test('reach(): linear routes are strict, loop routes wrap', () => {
  const linear = indexGraph(PAIR_GRAPH);
  assert.deepEqual(reach(linear, 'NORTH', 'KRMRT', 'UTOWN'), { hops: 2 });
  assert.equal(reach(linear, 'NORTH', 'UTOWN', 'KRMRT'), null, 'no travelling backwards');
  assert.equal(reach(linear, 'SOUTH', 'OPPKRMRT', 'UTOWN'), null, 'not on this route at all');

  const loop = indexGraph(GRAPH);
  assert.deepEqual(reach(loop, 'D2', 'KR-MRT', 'UTOWN'), { hops: 5 });
  assert.deepEqual(reach(loop, 'D2', 'KR-MRT-OPP', 'UTOWN'), { hops: 11, through: true }, 'wraps the long way, on past the terminal at COM3');
  assert.deepEqual(reach(loop, 'D2', 'KR-MRT-OPP', 'COM3'), { hops: 3 }, 'to the terminal itself: getting off there');
  assert.deepEqual(reach(loop, 'D2', 'KR-MRT', 'KR-MRT'), { hops: 0 });
  assert.equal(reach(loop, 'A1', 'KR-MRT', 'UTOWN'), null, 'A1 serves KR MRT but not UTown');
});

test('rideStops(): the stops ridden, the same way round as reach()', () => {
  const linear = indexGraph(PAIR_GRAPH);
  const ride = rideStops(linear, 'NORTH', 'KRMRT', 'UTOWN');
  assert.equal(ride.length, 3, 'two hops, three stops');
  assert.equal(ride[0], 'KRMRT');
  assert.equal(ride[2], 'UTOWN');
  assert.equal(rideStops(linear, 'NORTH', 'UTOWN', 'KRMRT'), null);

  const loop = indexGraph(GRAPH);
  assert.equal(rideStops(loop, 'D2', 'KR-MRT', 'UTOWN').length, reach(loop, 'D2', 'KR-MRT', 'UTOWN').hops + 1);
  const wrapped = rideStops(loop, 'D2', 'KR-MRT-OPP', 'UTOWN');
  assert.equal(wrapped.length, 12, 'the long way round, past the end of the sequence');
  assert.deepEqual([wrapped[0], wrapped.at(-1)], ['KR-MRT-OPP', 'UTOWN']);
});

test('a bus that arrives before you can walk there is not offered', () => {
  const far = { lat: 1.2985, lon: 103.7845, to: 'UTOWN', originCode: null }; // ~400 m from KRMRT
  const cands = candidateStops(PAIR_GRAPH, far);
  const walkS = cands.find((c) => c.stop.code === 'KRMRT').walkS;
  assert.ok(walkS > 120, 'precondition: a real walk');

  const options = scoreOptions(
    PAIR_GRAPH,
    cands,
    arrivalsFor(
      Object.fromEntries([
        sa('KRMRT', [
          { svc: 'NORTH', etaS: 30, crowd: null, plate: null }, // unreachable
          { svc: 'NORTH', etaS: 600, crowd: null, plate: null }, // the real answer
        ]),
      ]),
    ),
    NOW,
  );
  assert.equal(options[0].boardS, 600);
});

test('no coordinates still resolves the configured origin stop', () => {
  const cands = candidateStops(GRAPH, { lat: null, lon: null, to: 'COM3', originCode: 'PGP' });
  assert.equal(cands.length, 1);
  assert.equal(cands[0].stop.code, 'PGP');
  assert.equal(cands[0].walkS, 0);
});

test('a point far from every stop degrades to the nearest rather than nothing', () => {
  const cands = candidateStops(GRAPH, { lat: 1.35, lon: 103.85, to: null, originCode: null });
  assert.equal(cands.length, 1);
  assert.ok(cands[0].distM > 1000);
});

/* ------------------------------------------------------------------ */
/* FMS normalisation                                                   */
/* ------------------------------------------------------------------ */

test('"-" parses to null, not 0 -- and "Arr" parses to 0', () => {
  assert.equal(parseEtaS('-'), null, 'this is the bug that makes you sprint for a bus that does not exist');
  assert.equal(parseEtaS('Arr'), 0);
  assert.equal(parseEtaS('arriving'), 0);
  assert.equal(parseEtaS('4'), 240);
  assert.equal(parseEtaS('12 min'), 720);
  assert.equal(parseEtaS(3), 180);

  // Every value that Number() silently turns into 0.
  for (const v of [null, undefined, '', '   ', '--', 'N.A.', 'NA', 'nil']) {
    assert.equal(parseEtaS(v), null, `${JSON.stringify(v)} must be null`);
  }
  assert.equal(Number(null), 0, 'the reason the check above exists');
});

test('a minus or a clock time is not minutes to go', () => {
  assert.equal(parseEtaS('-3'), null, 'not 3 min');
  assert.equal(parseEtaS('12:30'), null, 'not 1230 min');
});

test('a live bus with no position is skipped, not drawn at 0', () => {
  const buses = normalizeBuses({ activebus: [
    { vehplate: 'PA1234A', lat: null, lng: 103.77, direction: 90 },
    { vehplate: 'PA1234B', lat: 1.29, lng: 103.77, direction: '' },
  ] });
  assert.deepEqual(buses.map((b) => b.plate), ['PA1234B']);
  assert.equal(buses[0].heading, null, 'a blank direction is no heading, not north');
});

test('crowd level survives the shapes the feed uses', () => {
  assert.equal(parseCrowd('low'), 'low');
  assert.equal(parseCrowd('Standing'), 'medium');
  assert.equal(parseCrowd('HIGH'), 'high');
  assert.equal(parseCrowd(80), 'high');
  assert.equal(parseCrowd(''), null);
  assert.equal(parseCrowd('purple'), null);
});

test('the unwrapper recurses through envelopes nested deeper than expected', () => {
  const deep = { ShuttleServiceResult: { data: { result: { shuttles: [{ name: 'D2' }] } } } };
  assert.deepEqual(pickList(deep, ['shuttles']), [{ name: 'D2' }]);
  assert.deepEqual(unwrap({ data: { Result: [1, 2] } }), [1, 2]);
  assert.deepEqual(pickList([{ name: 'A1' }], ['shuttles']), [{ name: 'A1' }], 'bare array');
  assert.deepEqual(pickList({}, ['shuttles']), []);
  assert.deepEqual(pickList(null, ['shuttles']), []);
});

test('normalize() flattens the real shuttle shape and keeps "no bus" as information', () => {
  const out = normalize({
    ShuttleServiceResult: {
      data: {
        shuttles: [
          { name: 'D2', arrivalTime: '4', nextArrivalTime: '14', passengers: 'low', arrivalTime_veh_plate: 'PA1234A' },
          { name: 'D1', arrivalTime: '-', nextArrivalTime: '-', passengers: '' },
          { name: 'A1', _etas: [{ eta: 2, passengers: 'high', plate: 'PB1' }, { eta: 9, passengers: 'low' }] },
        ],
      },
    },
  });
  assert.deepEqual(out.filter((a) => a.svc === 'D2').map((a) => a.etaS), [240, 840]);
  assert.deepEqual(out.filter((a) => a.svc === 'D1').map((a) => a.etaS), [null]);
  assert.deepEqual(out.filter((a) => a.svc === 'A1').map((a) => a.etaS), [120, 540]);
  assert.equal(out.find((a) => a.svc === 'A1').crowd, 'high');
  assert.equal(out.find((a) => a.svc === 'D2').plate, 'PA1234A');
});

/* ------------------------------------------------------------------ */
/* Formatting and the degrade ladder                                   */
/* ------------------------------------------------------------------ */

const opt = (over = {}) => ({
  stop: KRMRT,
  svc: 'D2',
  distM: 40,
  walkS: 30,
  hops: 3,
  boardS: 240,
  rideS: 285,
  totalS: 525,
  quality: 'live',
  arrival: { svc: 'D2', etaS: 240, crowd: 'low', plate: 'PA1' },
  fetchedAt: NOW,
  fromMs: NOW,
  ...over,
});

test('label is never longer than 40 characters', () => {
  const cases = [
    [opt(), null],
    [opt({ quality: 'scheduled', boardS: 900 }), opt({ svc: 'A1' })],
    [opt({ quality: 'stale', fetchedAt: NOW - 47 * 60_000 }), opt({ svc: 'A1' })],
    [opt({ svc: 'BTC-EXPRESS-LATE', boardS: 5999, quality: 'stale', fetchedAt: NOW - 999 * 60_000 }), null],
    [opt({ boardS: 0 }), null],
    [opt({ stop: { ...KRMRT, name: 'Opposite University Town Education Resource Centre' } }), null],
  ];
  for (const [best, alt] of cases) {
    const a = buildAnswer({
      options: [best],
      alt,
      fallbackStop: best.stop,
      nearestStop: null,
      destLabel: 'UTown',
      walkAllS: 1400,
      confidence: 0.8,
      arrivals: [],
      nowMs: NOW,
    });
    assert.ok(a.label.length <= LABEL_MAX, `too long (${a.label.length}): ${a.label}`);
    assert.ok(a.detail.length > 0);
    assert.ok(!a.detail.includes('\n'), 'detail is one line, never a table');
  }
  assert.ok(fitsTile(buildLabelOf(opt())), 'the everyday label must also fit a real tile');
  assert.equal(clampLabel('x'.repeat(80)).length, LABEL_MAX);
});

function buildLabelOf(o) {
  return buildAnswer({
    options: [o],
    alt: null,
    fallbackStop: o.stop,
    nearestStop: null,
    destLabel: 'UTown',
    walkAllS: null,
    confidence: 1,
    arrivals: [],
    nowMs: NOW,
  }).label;
}

test('an ended service offers a walking time rather than a blank tile', () => {
  const sunday = Date.UTC(2026, 7, 30, 4, 0, 0); // Sun 12:00 SGT; nothing runs
  assert.equal(inService(GRAPH, 'D2', sunday), false);

  const input = { lat: null, lon: null, to: 'UTOWN', originCode: 'COM3' };
  const cands = candidateStops(GRAPH, input);
  const options = scoreOptions(GRAPH, cands, new Map(), sunday);
  assert.deepEqual(options, [], 'nothing is boardable');

  const walkAllS = walkAllTheWayS(GRAPH, input, cands[0].stop);
  const answer = buildAnswer({
    options,
    alt: null,
    fallbackStop: cands[0].stop,
    nearestStop: null,
    destLabel: 'UTown',
    walkAllS,
    confidence: confidence(options, false),
    arrivals: [],
    nowMs: sunday,
  });

  assert.equal(answer.quality, 'ended');
  assert.match(answer.label, /walk/i);
  assert.match(answer.detail, /walk/i);
  assert.ok(answer.label.length <= LABEL_MAX);
  assert.ok(walkAllS > 300, 'a real walking estimate, not a placeholder');
  // The card draws it as a walk, and says why there's no bus.
  assert.deepEqual(answer.foot, { s: walkAllS, why: 'Services ended for the night' });
});

test('"the feed said no bus" is scheduled; "we never reached the feed" is not', () => {
  const cands = candidateStops(GRAPH, { lat: null, lon: null, to: 'COM3', originCode: 'PGP' });

  // The feed answered and had nothing. We know the service runs, so a headway
  // is an honest guess.
  const answered = scoreOptions(GRAPH, cands, arrivalsFor(Object.fromEntries([sa('PGP', [])])), NOW);
  assert.ok(answered.length > 0);
  assert.ok(answered.every((o) => o.quality === 'scheduled'));
  assert.ok(answered[0].boardS > 0);

  // We never reached the feed. Same absence of buses, completely different
  // thing to say about it.
  const unreachable = scoreOptions(GRAPH, cands, arrivalsFor(Object.fromEntries([unavailable('PGP')])), NOW);
  assert.ok(unreachable.length > 0, 'the graph still knows which service goes there');
  assert.ok(unreachable.every((o) => o.quality === 'unknown'));

  // A stop we never even attempted is treated as unreachable, not as empty.
  const absent = scoreOptions(GRAPH, cands, new Map(), NOW);
  assert.ok(absent.every((o) => o.quality === 'unknown'));
});

test('an unknown option never puts a fabricated minute count on screen', () => {
  const cands = candidateStops(GRAPH, { lat: null, lon: null, to: 'COM3', originCode: 'PGP' });
  const options = scoreOptions(GRAPH, cands, arrivalsFor(Object.fromEntries([unavailable('PGP')])), NOW);
  const a = buildAnswer({
    options,
    alt: pickAlt(options),
    fallbackStop: options[0].stop,
    nearestStop: null,
    destLabel: 'COM3',
    walkAllS: null,
    confidence: 0.75,
    arrivals: [],
    nowMs: NOW,
  });

  assert.equal(a.quality, 'unknown');
  assert.match(a.label, /no times/);
  // Service names carry digits; times must not. Check the eta segment alone.
  const eta = a.label.split(' · ')[1];
  assert.ok(!/\d/.test(eta) && eta !== 'now', `label invented a time: ${a.label}`);
  assert.match(a.detail, /live times unavailable/);
  // Hop count is real information from the graph, so it may appear.
  assert.match(a.detail, /COM3, 13 stops/);
  assert.ok(a.label.length <= LABEL_MAX);
});

test('a measurement always outranks a guess, however good the guess looks', () => {
  const cands = candidateStops(GRAPH, { lat: KR.lat, lon: KR.lon, to: 'UTOWN', originCode: null });
  assert.ok(cands.length > 1, 'precondition: more than one candidate stop');

  // The measured option is deliberately the slower one.
  const options = scoreOptions(
    GRAPH,
    cands,
    arrivalsFor(
      Object.fromEntries([
        sa('KR-MRT', [{ svc: 'D2', etaS: 600, crowd: null, plate: null }]),
        unavailable('KR-MRT-OPP'),
      ]),
    ),
    NOW,
  );
  assert.equal(options[0].quality, 'live');
  assert.ok(options.some((o) => o.quality === 'unknown'));
  assert.ok(options.at(-1).quality === 'unknown', 'guesses sort last');
});

test('a stale stop marks every option stale and keeps the original timestamp', () => {
  const fetchedAt = NOW - 190_000;
  const cands = candidateStops(GRAPH, { lat: null, lon: null, to: 'COM3', originCode: 'PGP' });
  const options = scoreOptions(
    GRAPH,
    cands,
    arrivalsFor(Object.fromEntries([sa('PGP', [{ svc: 'D2', etaS: 240, crowd: null, plate: null }], fetchedAt, true)])),
    NOW,
  );
  assert.equal(options[0].quality, 'stale');
  const a = buildAnswer({
    options,
    alt: pickAlt(options),
    fallbackStop: options[0].stop,
    nearestStop: null,
    destLabel: 'COM3',
    walkAllS: null,
    confidence: 0.75,
    arrivals: [],
    nowMs: NOW,
  });
  assert.equal(Date.parse(a.asOf), fetchedAt, 'asOf is the ORIGINAL fetch time');
  assert.match(a.detail, /old/);
});

test('a stale answer under a minute old never reads "0 min old"', async () => {
  const { withLang } = await import('../src/i18n.ts');
  const fetchedAt = NOW - 20_000;
  const cands = candidateStops(GRAPH, { lat: null, lon: null, to: 'COM3', originCode: 'PGP' });
  const options = scoreOptions(
    GRAPH,
    cands,
    arrivalsFor(Object.fromEntries([sa('PGP', [{ svc: 'D2', etaS: 240, crowd: null, plate: null }], fetchedAt, true)])),
    NOW,
  );
  const answer = () => buildAnswer({ options, alt: null, fallbackStop: options[0].stop, nearestStop: null, destLabel: 'COM3', walkAllS: null, confidence: 0.75, arrivals: [], nowMs: NOW });
  const a = answer();
  assert.equal(a.quality, 'stale');
  assert.match(a.label, /\(<1m\)$/);
  assert.match(a.detail, /under a minute old/);
  assert.doesNotMatch(`${a.label} ${a.detail}`, /\b0 ?m/);
  const zh = withLang('zh', answer);
  assert.match(zh.label, /不到 1 分钟前/);
  assert.match(zh.detail, /不到 1 分钟前的数据/);
});

test('alt always differs in its first leg', () => {
  const options = [opt(), opt({ boardS: 250, totalS: 535 }), opt({ svc: 'A1', boardS: 400, totalS: 600 })];
  assert.equal(pickAlt(options).svc, 'A1');
  assert.equal(pickAlt([opt()]), null);
});

test('mins() says "now" rather than "0 min"', () => {
  assert.equal(mins(0), 'now');
  assert.equal(mins(44), 'now');
  assert.equal(mins(75), '1 min');
  assert.equal(mins(605), '10 min');
});

test('shortStop abbreviates but never drops the direction word', () => {
  assert.equal(shortStop('Opp Kent Ridge MRT'), 'Opp KR MRT');
  assert.ok(shortStop('Opposite University Town Education Resource Centre').startsWith('Opp '));
});

/* ------------------------------------------------------------------ */
/* The cue that saves the bus                                          */
/* ------------------------------------------------------------------ */

test('being sent across the road says so, in words', () => {
  const input = { lat: KR_OPP.lat, lon: KR_OPP.lon, to: 'UTOWN', originCode: null };
  const near = nearestStop(GRAPH, input.lat, input.lon);
  assert.equal(near.code, 'KR-MRT-OPP', 'the nearest stop is the wrong one');

  const cands = candidateStops(GRAPH, input);
  const options = scoreOptions(
    GRAPH,
    cands,
    arrivalsFor(
      Object.fromEntries([
        sa('KR-MRT', [{ svc: 'D2', etaS: 300, crowd: null, plate: null }]),
        sa('KR-MRT-OPP', [{ svc: 'D2', etaS: 120, crowd: null, plate: null }]),
      ]),
    ),
    NOW,
  );
  const a = buildAnswer({
    options,
    alt: pickAlt(options),
    fallbackStop: options[0].stop,
    nearestStop: near,
    destLabel: 'UTown',
    walkAllS: null,
    confidence: confidence(options, true),
    arrivals: [],
    nowMs: NOW,
  });

  assert.equal(a.stop.code, 'KR-MRT');
  assert.match(a.detail, /cross the road/);
  // The D2 from this side goes the wrong way round the loop: no alternative.
  assert.equal(a.alt, null);
  assert.ok(!/ or /.test(a.detail), a.detail);

  // When the same service from the other stop is a real alternative, it's
  // named by its stop: naming only the service would read as "another D2 is
  // coming here", which is the opposite of true.
  const other = options.find((o) => o.stop.code === 'KR-MRT-OPP');
  const b = buildAnswer({ options, alt: other, fallbackStop: options[0].stop, nearestStop: near, destLabel: 'UTown', walkAllS: null, confidence: 0.9, arrivals: [], nowMs: NOW });
  assert.match(b.detail, /or Opp KR MRT/);
  assert.ok(!/or D2/.test(b.detail));
});

test('the same service from the other stop is an alternative only when it gets you there about as soon', () => {
  const at = (code, totalS) => ({ stop: { code, name: code }, svc: 'D2', totalS, boardS: 60, quality: 'live' });
  assert.equal(pickAlt([at('KR-MRT', 600), at('KR-MRT-OPP', 600 + WALK.mentionWithinS)]).stop.code, 'KR-MRT-OPP');
  assert.equal(pickAlt([at('KR-MRT', 600), at('KR-MRT-OPP', 601 + WALK.mentionWithinS)]), null, 'round the loop the wrong way');
  // Another service is a choice whatever it takes.
  assert.equal(pickAlt([at('KR-MRT', 600), { ...at('KR-MRT', 2000), svc: 'A1' }]).svc, 'A1');
});

test('standing at the right stop does not invent a walk', () => {
  const input = { lat: KR.lat, lon: KR.lon, to: 'UTOWN', originCode: null };
  const cands = candidateStops(GRAPH, input);
  const options = scoreOptions(
    GRAPH,
    cands,
    arrivalsFor(Object.fromEntries([sa('KR-MRT', [{ svc: 'D2', etaS: 300, crowd: null, plate: null }])])),
    NOW,
  );
  const a = buildAnswer({
    options,
    alt: null,
    fallbackStop: options[0].stop,
    nearestStop: nearestStop(GRAPH, input.lat, input.lon),
    destLabel: 'UTown',
    walkAllS: null,
    confidence: 0.9,
    arrivals: [],
    nowMs: NOW,
  });
  assert.match(a.detail, /right here/);
  assert.ok(!/cross the road/.test(a.detail));
});

/* ------------------------------------------------------------------ */
/* Walking                                                             */
/* ------------------------------------------------------------------ */

const busOpt = (over = {}) => ({
  stop: KR,
  svc: 'D2',
  distM: 40,
  walkS: 30,
  hops: 3,
  boardS: 600,
  rideS: 285,
  totalS: 885,
  quality: 'live',
  arrival: { svc: 'D2', etaS: 600, crowd: null, plate: null },
  fetchedAt: NOW,
  fromMs: NOW,
  ...over,
});

const answerWith = (options, walkAllS, alt = null) =>
  buildAnswer({
    options,
    alt,
    fallbackStop: options[0]?.stop ?? null,
    nearestStop: null,
    destLabel: 'UTown',
    walkAllS,
    confidence: 0.9,
    arrivals: [],
    nowMs: NOW,
  });

test('walking wins outright when it is genuinely faster', () => {
  const best = busOpt(); // 885 s by bus
  assert.equal(walkVerdict(600, best), 'win');

  const a = answerWith([best], 600);
  assert.equal(a.label, 'Walk · 10 min');
  assert.match(a.detail, /On foot to UTown/);
  assert.match(a.detail, /D2 would be 15 min/);
  // The bus is still offered, so following the walk is never a trap.
  assert.match(a.alt, /^D2 · 10 min · KR MRT$/);
  assert.equal(a.quality, 'live', 'quality still describes the feed, not the advice');
  assert.ok(a.label.length <= LABEL_MAX);
  // For the card's journey: the walk, and the bus it beats.
  assert.deepEqual(a.foot, { s: 600, why: 'D2 would be 15 min' });
});

test('walking does not win on thirty seconds', () => {
  const best = busOpt({ boardS: 300, totalS: 585 });
  assert.equal(walkVerdict(555, best), 'close', 'faster, but not by enough to be worth it');
  const a = answerWith([best], 555);
  assert.match(a.label, /^D2 · /);
  assert.match(a.detail, /walking 9 min/, 'mentioned, not recommended');
});

test('a walk that is much slower is not mentioned at all', () => {
  const best = busOpt({ boardS: 120, totalS: 405 });
  assert.equal(walkVerdict(1800, best), 'lose');
  assert.ok(!/walk/.test(answerWith([best], 1800).detail));
});

test('no safety margin is needed to beat a guess', () => {
  // 60 s faster is not enough against a live time...
  assert.equal(walkVerdict(825, busOpt()), 'close');
  // ...but it is enough against a headway estimate or against no data at all.
  assert.equal(walkVerdict(825, busOpt({ quality: 'scheduled' })), 'win');
  assert.equal(walkVerdict(825, busOpt({ quality: 'unknown' })), 'win');
});

test('walking beats an unknown bus and says why', () => {
  const a = answerWith([busOpt({ quality: 'unknown', arrival: null })], 700);
  assert.equal(a.label, 'Walk · 12 min');
  assert.match(a.detail, /D2 has no live times/);
  assert.ok(!/would be/.test(a.detail), 'no invented bus time in the walking answer either');
  assert.equal(a.foot.why, 'D2 has no live times');
});

test('with no destination there is nothing to walk to', () => {
  assert.equal(walkVerdict(null, busOpt()), 'lose');
  assert.equal(walkVerdict(300, undefined), 'lose');
});

/* ------------------------------------------------------------------ */
/* Real captured data                                                  */
/* ------------------------------------------------------------------ */

test('normalize() handles the real feed shape, which is not the one I guessed', () => {
  // Before this test existed, normalize() returned [] on this input: the list
  // key is `timings` under an `etas` envelope, not `shuttles`.
  const out = normalize(COM3_FIXTURE);
  assert.equal(out.length, 8, 'four services x arrival + nextArrival');

  const d2 = out.filter((a) => a.svc === 'D2');
  assert.deepEqual(d2.map((a) => a.etaS), [180, 900, 660, 1080]);
  assert.equal(d2[0].plate, 'PD1022U');
});

test('crowding comes from a headcount, not a low/medium/high string', () => {
  const out = normalize(COM3_FIXTURE);
  const byPlate = (p) => out.find((a) => a.plate === p);

  assert.equal(byPlate('PD1029B').crowd, 'low', '0 of 88');
  assert.equal(byPlate('PD804L').crowd, 'medium', '54 of 88');
  assert.equal(byPlate('PD760D').crowd, 'high', '88 of 88 -- you are not getting on this one');
  // Some vehicles report neither field, and an absent field is not an empty bus.
  assert.equal(byPlate('PD1022U').crowd, null);
  assert.equal(crowdFromLoad(88, null), null);
  assert.equal(crowdFromLoad(null, 0), null, 'Number(null) is 0, so this needs an explicit guard');
  assert.equal(crowdFromLoad(0, 0), null, 'no capacity means no information');
});

test('"0" is a real arrival time, distinct from "-"', () => {
  const a2 = normalize(UHALL_FIXTURE).find((a) => a.svc === 'A2');
  assert.equal(a2.etaS, 0);
  assert.equal(a2.crowd, 'high');
});

test('berth codes survive normalisation, because they are the only direction signal', () => {
  const com3 = normalize(COM3_FIXTURE);
  assert.deepEqual(
    [...new Set(com3.map((a) => a.berth))].sort(),
    ['COM3-D1-E', 'COM3-D1-S', 'COM3-D2-E', 'COM3-D2-S'],
  );
  // A stop the route passes once carries a bare code.
  assert.ok(normalize(UHC_FIXTURE).every((a) => a.berth === 'UHC'));
});

test('at a terminus, the boardable berth is -S and never -E', () => {
  const all = normalize(COM3_FIXTURE);
  const d2 = resolveBerths(all.filter((a) => a.svc === 'D2'));
  assert.equal(d2.ambiguousBerth, false, 'the suffix resolves it, so nothing is unconfirmed');
  assert.ok(d2.usable.every((a) => a.berth === 'COM3-D2-S'));
  assert.deepEqual(d2.usable.map((a) => a.etaS), [180, 900]);

  // The captured sample happens to list -S first, so invert it: this is the
  // case the rule exists for. A bus terminating in 2 minutes must lose to a
  // bus departing in 12.
  const inverted = [
    { svc: 'D2', etaS: 120, crowd: null, plate: 'ARRIVING', berth: 'COM3-D2-E', ends: true },
    { svc: 'D2', etaS: 720, crowd: null, plate: 'DEPARTING', berth: 'COM3-D2-S' },
  ];
  const picked = resolveBerths(inverted);
  assert.equal(picked.ambiguousBerth, false);
  assert.deepEqual(picked.usable.map((a) => a.plate), ['DEPARTING']);
});

test('a single-berth stop is left alone', () => {
  const uhc = normalize(UHC_FIXTURE);
  const r = resolveBerths(uhc.filter((a) => a.svc === 'D2'));
  assert.equal(r.ambiguousBerth, false);
  assert.equal(r.usable.length, 2, 'nothing filtered');
});

test('berths that no suffix can separate are declared, not guessed at', () => {
  // Two berths, neither marked -S. There is no basis for choosing, so the
  // answer says so rather than picking the earliest and hoping.
  const rows = [
    { svc: 'D2', etaS: 120, crowd: null, plate: 'A', berth: 'COM3-D2-1' },
    { svc: 'D2', etaS: 600, crowd: null, plate: 'B', berth: 'COM3-D2-2' },
  ];
  const r = resolveBerths(rows);
  assert.equal(r.ambiguousBerth, true);
  assert.equal(r.usable.length, 2);

  const cands = candidateStops(GRAPH, { lat: null, lon: null, to: 'UTOWN', originCode: 'COM3' });
  const options = scoreOptions(GRAPH, cands, arrivalsFor(Object.fromEntries([sa('COM3', rows)])), NOW);
  const d2 = options.find((o) => o.svc === 'D2');
  assert.equal(d2.ambiguousBerth, true);
  assert.ok(confidence([d2], false) <= 0.5, 'an unresolvable direction is not a confident answer');

  const a = buildAnswer({
    options: [d2],
    alt: null,
    fallbackStop: d2.stop,
    nearestStop: null,
    destLabel: 'UTown',
    walkAllS: null,
    confidence: confidence([d2], false),
    arrivals: [],
    nowMs: NOW,
  });
  assert.match(a.detail, /direction unconfirmed/);
});

test('the terminus split does not dent confidence once resolved', () => {
  const cands = candidateStops(GRAPH, { lat: null, lon: null, to: 'UTOWN', originCode: 'COM3' });
  const options = scoreOptions(
    GRAPH,
    cands,
    arrivalsFor(Object.fromEntries([sa('COM3', normalize(COM3_FIXTURE))])),
    NOW,
  );
  const d2 = options.find((o) => o.svc === 'D2');
  assert.equal(d2.ambiguousBerth, false);
  assert.equal(d2.boardS, 180, 'the departing bus, not the terminating one');
  assert.ok(confidence(options, false) > 0.5);
});

test('arrivalTime_ts is never used, because half of it points into the past', () => {
  const rows = COM3_FIXTURE.etas.timings;
  const updated = Date.parse(COM3_FIXTURE.etas.lastUpdated);
  const past = rows.filter((r) => Date.parse(r.arrivalTime_ts.replace(' ', 'T') + '+08:00') < updated);
  assert.ok(past.length > 0, 'precondition: the feed really does emit past timestamps');
  // Every one of those still reports a positive relative arrivalTime.
  assert.ok(past.every((r) => Number(r.arrivalTime) >= 0));
});

/* ------------------------------------------------------------------ */
/* The real graph: schema only                                         */
/* ------------------------------------------------------------------ */

// Behavioural tests above run against a frozen fixture on purpose. These
// assert only that whatever the scraper last produced is structurally sane,
// so a route genuinely changing shape fails loudly instead of quietly
// rewriting what the other tests mean.

test('every route references stops that exist', () => {
  const codes = new Set(realGraph.stops.map((s) => s.code));
  for (const [svc, seq] of Object.entries(realGraph.routes)) {
    assert.ok(seq.length >= 2, `${svc} has a degenerate sequence`);
    for (const code of seq) assert.ok(codes.has(code), `${svc} references unknown stop ${code}`);
  }
});

test('every stop has coordinates on the Kent Ridge campus', () => {
  for (const s of realGraph.stops) {
    assert.ok(Number.isFinite(s.lat) && Number.isFinite(s.lon), `${s.code} has no coordinates`);
    assert.ok(s.lat > 1.28 && s.lat < 1.35, `${s.code} latitude ${s.lat} is not in Singapore`);
    assert.ok(s.lon > 103.7 && s.lon < 103.85, `${s.code} longitude ${s.lon} is not in Singapore`);
    assert.ok(s.name && s.name.length > 0, `${s.code} has no name`);
  }
});

test('berth sequences line up with stop sequences', () => {
  for (const [svc, seq] of Object.entries(realGraph.routes)) {
    const berths = realGraph.berths?.[svc];
    if (!berths) continue;
    assert.equal(berths.length, seq.length, `${svc} berth/stop length mismatch`);
    // A berth is either the bare stop code or that code plus a route suffix.
    berths.forEach((b, i) => {
      assert.ok(b === seq[i] || b.startsWith(`${seq[i]}-`), `${svc}[${i}]: ${b} vs ${seq[i]}`);
    });
  }
});

test('the loop flag matches the sequence', () => {
  for (const [svc, seq] of Object.entries(realGraph.routes)) {
    const closes = seq[0] === seq[seq.length - 1];
    assert.equal(realGraph.loops?.[svc] ?? closes, closes, `${svc} loop flag disagrees`);
  }
});

test('directional pairing is symmetric', () => {
  const byCode = new Map(realGraph.stops.map((s) => [s.code, s]));
  for (const s of realGraph.stops) {
    if (!s.opposite) continue;
    const twin = byCode.get(s.opposite);
    assert.ok(twin, `${s.code} points at missing twin ${s.opposite}`);
    assert.equal(twin.opposite, s.code, `${s.code} <-> ${twin.code} is not symmetric`);
  }
});

test('indexGraph survives the real graph', () => {
  const idx = indexGraph(realGraph);
  assert.ok(idx.byCode.size >= 20, 'a campus this size should have plenty of stops');
  assert.ok(idx.routes.size >= 5);
  // The core query has to work on real topology, not just the fixture.
  const r = reach(idx, 'D2', 'KR-MRT', 'UTOWN');
  assert.ok(r && r.hops > 0 && r.hops < idx.routes.get('D2').seq.length);
});

/* ------------------------------------------------------------------ */
/* Auth: the confirmed token flow                                      */
/* ------------------------------------------------------------------ */

// A real captured response, minus the signature. domain PUBLIC, no NUSNET.
const TOKEN_RESPONSE = {
  msg: '',
  code: '00000',
  data: {
    username: 'User',
    // header.payload.signature with exp 1787931982, iat 1787845582
    token:
      'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.' +
      'eyJkb21haW4iOiJQVUJMSUMiLCJhdWQiOiJURVNULVVTRVItMDAwMCIsImlzcyI6IkhURCIsImp0aSI6InRlc3RkZXZpY2UwMDAwMDAiLCJpaWF0IjoxNzg3ODQ1NTgyLCJleHAiOjE3ODc5MzE5ODIsImlhdCI6MTc4Nzg0NTU4Mn0.' +
      'c2lnbmF0dXJlLXJlbW92ZWQ',
    userid: 'TEST-USER-0000',
    domain: 'PUBLIC',
  },
  ts: '20260827234622',
};

test('the token lifetime comes from the JWT, because the response has no expires_in', () => {
  const exp = jwtExpMs(TOKEN_RESPONSE.data.token);
  assert.equal(exp, 1787931982 * 1000);
  assert.equal(jwtExpMs('not-a-jwt'), null);
  assert.equal(jwtExpMs(''), null);
  assert.equal(jwtExpMs('a.!!!not-base64!!!.c'), null);
});

test('a session carries userid, not just the token', () => {
  const now = 1787845582 * 1000;
  const s = extractSession(TOKEN_RESPONSE, now);

  assert.equal(s.userid, 'TEST-USER-0000');
  assert.equal(s.domain, 'PUBLIC');
  // userid is reissued on every mint even for one device id, so pinning it in
  // config would silently drift out of date.
  assert.ok(s.token.startsWith('eyJ'));
  assert.ok(s.expMs > now, 'not already expired');
  assert.ok(s.expMs < 1787931982 * 1000, 'refreshes early rather than racing the expiry');
});

test('"Invalid API KEY" arrives as HTTP 200, so the status line proves nothing', () => {
  // The real rejection shape. Anything that trusts res.ok will sail past it.
  assert.equal(extractSession({ msg: 'Invalid API KEY', code: '10000', data: {} }, Date.now()), null);
  assert.equal(extractSession({ code: '00000', data: { token: 'short' } }, Date.now()), null);
  assert.equal(extractSession(null, Date.now()), null);
});

test('a reshaped envelope still yields a session', () => {
  const flat = { token: TOKEN_RESPONSE.data.token, userid: 'X', domain: 'PUBLIC' };
  assert.equal(extractSession(flat, 1787845582 * 1000).userid, 'X');
});

test('authUrl appends the endpoint to a base that carries a path prefix', () => {
  const at = (NEXTBUS_AUTH_BASE) => authUrl({ NEXTBUS_AUTH_BASE });
  const real = 'https://myizaac2.nus.edu.sg/univus-public/mobile';
  // The real base is a PREFIX, not a complete endpoint. Treating "has a path"
  // as "use verbatim" posts to the directory and fails in workerd.
  assert.equal(at(real), `${real}/get-access-token`);
  assert.equal(at(`${real}/`), `${real}/get-access-token`);
  assert.equal(at(`${real}/get-access-token`), `${real}/get-access-token`, 'no double-append');
  assert.equal(at('https://example.test'), 'https://example.test/get-access-token');
});

test('outgoing headers do not send X-Forwarded-Proto', () => {
  // Sending it made the NUS load balancer intermittently reject the token mint
  // with 400 "Contradictory scheme headers". This guards against re-adding it.
  const h = apiKeyHeaders({ NEXTBUS_HTD_API: 'k1', NEXTBUS_APP_API: 'k2' });
  assert.ok(!Object.keys(h).some((k) => k.toLowerCase() === 'x-forwarded-proto'));
  assert.equal(h['X-HTD-API'], 'k1');
  assert.equal(h['X-APP-API'], 'k2');
});
test('the hours template covers every service in the real graph', () => {
  for (const svc of Object.keys(realGraph.routes)) {
    assert.ok(svc in serviceHoursJson, `no hours entry for ${svc}`);
  }
});

test('an unfilled template entry means "unknown", never "ended all day"', () => {
  const merged = mergeServiceHours({}, serviceHoursJson);
  // Placeholders must not survive the merge as real windows.
  for (const [svc, h] of Object.entries(merged)) {
    for (const day of ['weekday', 'saturday', 'sunday']) {
      const w = h[day];
      if (w == null) continue;
      assert.ok(hhmmToMin(w[0]) !== null && hhmmToMin(w[1]) !== null, `${svc}.${day} is malformed`);
    }
  }
  // And a service with nothing usable is treated as running, so a half-filled
  // file degrades to today's behaviour rather than "no buses, ever".
  const graph = { ...realGraph, serviceHours: merged };
  const anySunday = Date.UTC(2026, 7, 30, 4, 0, 0); // Sun 12:00 SGT
  assert.equal(inService(graph, 'D2', anySunday), true);
});

test('mergeServiceHours only lets well-formed entries win', () => {
  const base = { D2: { weekday: ['07:00', '23:00'], saturday: null, sunday: null } };
  const merged = mergeServiceHours(base, {
    _help: ['ignored'],
    _routes: { D2: 'ignored' },
    D2: { weekday: ['', ''], saturday: ['08:00', '20:00'], sunday: null },
    K: { weekday: ['bad', '20:00'] },
    R1: { weekday: ['07:15', '19:45'] },
  });

  assert.deepEqual(merged.D2.weekday, ['07:00', '23:00'], 'a placeholder cannot clobber real data');
  assert.deepEqual(merged.D2.saturday, ['08:00', '20:00'], 'a valid window wins');
  assert.equal(merged.D2.sunday, null, 'explicit null means it does not run');
  assert.equal(merged.K?.weekday, undefined, 'a malformed window is simply not set');
  assert.deepEqual(merged.R1.weekday, ['07:15', '19:45']);
  assert.ok(!('_help' in merged) && !('_routes' in merged), 'doc keys are not services');
  assert.equal(mergeServiceHours({}, { P: { sunday: [null, null] } }).P.sunday, null, '[null, null] does not run either');
});

test('services that do not run at weekends are not offered then', () => {
  const graph = { ...realGraph, serviceHours: mergeServiceHours({}, serviceHoursJson) };
  const sunday = Date.UTC(2026, 7, 30, 2, 0, 0); // Sun 10:00 SGT
  for (const svc of ['K', 'P', 'R1', 'R2']) assert.equal(inService(graph, svc, sunday), false, svc);
  assert.equal(inService(graph, 'D2', sunday), true);
});

test('a filled window actually gates the ended rung', () => {
  const graph = {
    ...realGraph,
    serviceHours: mergeServiceHours({}, { D2: { weekday: ['07:00', '23:00'], sunday: null } }),
  };
  assert.equal(inService(graph, 'D2', Date.UTC(2026, 7, 27, 1, 0)), true, 'Thu 09:00 SGT');
  assert.equal(inService(graph, 'D2', Date.UTC(2026, 7, 27, 19, 0)), false, 'Thu 03:00 SGT');
  assert.equal(inService(graph, 'D2', Date.UTC(2026, 7, 30, 4, 0)), false, 'Sun: does not run');

  // Crossing midnight.
  const late = { ...realGraph, serviceHours: mergeServiceHours({}, { K: { weekday: ['07:00', '01:00'] } }) };
  assert.equal(inService(late, 'K', Date.UTC(2026, 7, 27, 16, 30)), true, 'Thu 00:30 SGT is inside');
  assert.equal(inService(late, 'K', Date.UTC(2026, 7, 27, 18, 0)), false, 'Thu 02:00 SGT is outside');
});

/* ------------------------------------------------------------------ */
/* ConnectX FMS: the confirmed query-param scheme                      */
/* ------------------------------------------------------------------ */

test('every real feed capture reads as a board; rows that changed shape do not', () => {
  // The real ones, the after-midnight ConnectX capture included: every bus
  // there is hours away, the next morning's, and that is not a fault.
  for (const raw of [COM3_FIXTURE, UHC_FIXTURE, CONNECTX_FIXTURE]) assert.equal(arrivalsProblem(raw), null);
  assert.equal(arrivalsProblem({ timings: [] }), null, 'an empty board is a real "no bus"');
  assert.equal(arrivalsProblem({ timings: [{ name: 'D2', arrivalTime: '-', nextArrivalTime: '-' }] }), null, '"-" is a real "no bus"');
  // The same board after a rename: a field normalize() reads is gone.
  const renamed = (from, to) => ({ etas: { timings: COM3_FIXTURE.etas.timings.map(({ [from]: v, ...rest }) => ({ ...rest, [to]: v })) } });
  assert.match(arrivalsProblem(renamed('name', 'routeName')), /no row names a service/);
  assert.match(arrivalsProblem(renamed('arrivalTime', 'arrival_min')), /no row has an arrival time/);
  assert.match(arrivalsProblem({ timings: [{ name: 'Route D2', arrivalTime: '3' }] }), /no service it names is known \(Route D2\)/);
  // One service unknown among known ones (a new route before the weekly scrape) is fine.
  assert.equal(arrivalsProblem({ timings: [{ name: 'D2', arrivalTime: '3' }, { name: 'Z9', arrivalTime: '5' }] }), null);
});

test('a bus list whose rows lost their plates or positions is a changed feed, not "no buses"', () => {
  const list = [{ vehplate: 'PD726D', lat: 1.2949, lng: 103.7735, speed: 20, direction: 90 }];
  assert.equal(busesProblem({ activebus: list }), null);
  assert.equal(busesProblem({ activebus: [] }), null);
  assert.equal(busesProblem({ activebus: [{ vehplate: 'PD726D', lat: 0, lng: 0 }] }), null, 'no fix yet is a real bus without a place');
  assert.match(busesProblem({ activebus: [{ busPlate: 'PD726D', lat: 1.29, lng: 103.77 }] }), /no row has a plate/);
  assert.match(busesProblem({ activebus: [{ vehplate: 'PD726D', position: [1.29, 103.77] }] }), /no row has a position/);
});

test('a bus list whose values changed is a changed feed, not "no buses"', () => {
  const at = { lat: 1.2949, lng: 103.7735 };
  // The fields are all there; not one bus can be read from them.
  for (const rows of [
    [{ vehplate: 'PD726D', lat: at.lng, lng: at.lat }], // swapped
    [{ vehplate: 'PD726D', lat: null, lng: null }],
    [{ vehplate: 'PD726D', lat: '1,2949', lng: '103,7735' }],
    [{ vehplate: null, ...at }],
    [{ vehplate: '-', ...at }],
  ]) assert.match(busesProblem({ activebus: rows }), /no bus has a plate and a position it can read/, JSON.stringify(rows));
  // One readable bus among them is a board.
  assert.equal(busesProblem({ activebus: [{ vehplate: 'PD1', lat: null, lng: null }, { vehplate: 'PD2', ...at }] }), null);
});

test('a list under a name it does not know is only a list of rows, never the hints beside it', () => {
  const result = CONNECTX_FIXTURE.ShuttleServiceResult;
  assert.ok(Array.isArray(result.hints) && result.hints.every((h) => typeof h === 'string'), 'the real reply carries hints');
  const { shuttles, ...rest } = result;
  // Gone, null, or not a list: no board, so the fetch throws, never "no bus".
  for (const board of [rest, { ...rest, shuttles: null }, { ...rest, shuttles: {} }, { ...rest, shuttles: 'none' }, { ...rest, busServices: [] }]) {
    assert.equal(hasList({ ShuttleServiceResult: board }), false, JSON.stringify(Object.keys(board)));
    assert.deepEqual(normalize({ ShuttleServiceResult: board }), []);
  }
  // Renamed with its rows, it's still the board.
  const renamed = { ShuttleServiceResult: { ...rest, busServices: shuttles } };
  assert.equal(hasList(renamed), true);
  assert.equal(normalize(renamed).length, normalize(CONNECTX_FIXTURE).length);
  assert.equal(arrivalsProblem(renamed), null);
  // An empty board under its own name is real.
  assert.equal(hasList({ ShuttleServiceResult: { ...rest, shuttles: [] } }), true);
});

test('every row needs a time it can read, so one changed service cannot hide behind the rest', () => {
  const result = CONNECTX_FIXTURE.ShuttleServiceResult;
  const etas = (f) => ({ ShuttleServiceResult: { ...result, shuttles: result.shuttles.map((s) => ({ ...s, _etas: s._etas.map(f) })) } });
  // The fields inside `_etas` renamed: every time gone.
  assert.match(arrivalsProblem(etas(({ eta, eta_s, ...e }) => ({ ...e, etaMin: eta, etaSec: eta_s }))), /no row has an arrival time/);
  // Or in another format.
  assert.match(arrivalsProblem(etas(({ eta: _m, eta_s: _s, ...e }) => ({ ...e, eta: '07:15' }))), /a time it cannot read/);
  // Null everywhere is not "-".
  assert.match(arrivalsProblem({ timings: [{ name: 'D2', arrivalTime: null }] }), /no row has an arrival time/);
  // One service changed among good ones.
  assert.match(arrivalsProblem({ timings: [{ name: 'D2', arrivalTime: '09:04' }, { name: 'D1', arrivalTime: '3' }] }), /a time it cannot read \(D2\)/);
  assert.match(arrivalsProblem({ timings: [{ name: 'D2', arrival_min: '4' }, { name: 'D1', arrivalTime: '3' }] }), /no arrival time for D2/);
  // The first time gone, the next would pass for the soonest bus.
  assert.match(arrivalsProblem({ timings: [{ name: 'D2', nextArrivalTime: '9' }, { name: 'D1', arrivalTime: '3' }] }), /no arrival time for D2/);
  // A time past a week is a changed unit or an absolute time.
  assert.match(arrivalsProblem({ timings: [{ name: 'D2', arrivalTime: 1_756_336_500 }] }), /a time it cannot read/);
  // The feed's own "no bus" passes, in each shape.
  assert.equal(arrivalsProblem({ timings: [{ name: 'D2', arrivalTime: '-', nextArrivalTime: '-' }, { name: 'D1', arrivalTime: 'Arr' }] }), null);
  assert.equal(arrivalsProblem({ shuttles: [{ name: 'D2', _etas: [] }, { name: 'D1', _etas: [{ eta_s: 60 }] }], hints: ['x'] }), null);
});

test('seconds are a number or digits; blanks and other types are no time, not "arriving now"', () => {
  for (const v of [' ', '', '-', false, true, [], [5], {}, '0x1F', '1e3', null, undefined, -5, NaN, Infinity]) assert.equal(parseSeconds(v), null, JSON.stringify(v));
  assert.equal(parseSeconds(0), 0);
  assert.equal(parseSeconds(' 42 '), 42);
  assert.equal(parseSeconds(12.4), 12);
  // Blank seconds beside good minutes: the minutes.
  assert.equal(normalize({ shuttles: [{ name: 'D2', _etas: [{ eta_s: ' ', eta: 5 }] }] })[0].etaS, 300);
});

test('a time to go past a week is no time: a changed unit, an epoch, an overflow', () => {
  assert.equal(parseEtaS(1_756_336_500), null);
  assert.equal(parseEtaS(1e308), null);
  assert.equal(parseSeconds(1e20), null);
  // A long weekend's next bus is days away, and real.
  assert.equal(parseSeconds(3 * 86_400), 3 * 86_400);
  assert.equal(parseEtaS('420'), 420 * 60, 'the after-midnight case, hours away');
});

test('service names are read as the graph spells them', () => {
  assert.deepEqual(normalize({ timings: [{ name: 'd2', arrivalTime: '3' }, { name: ' D 1 ', arrivalTime: '4' }] }).map((a) => a.svc), ['D2', 'D1']);
  assert.deepEqual(normalize({ timings: [{ name: 'Z9', arrivalTime: '3' }] }).map((a) => a.svc), ['Z9'], 'an unknown one as it is');
  assert.deepEqual(normalize({ timings: [{ name: { id: 'D2' }, arrivalTime: '3' }, { name: true, arrivalTime: '3' }] }), [], 'only a string or a number is a name');
});

test('a run ending here is flagged by normalize, the only code that reads the -E suffix', () => {
  const all = normalize(CONNECTX_FIXTURE);
  assert.ok(all.some((a) => a.ends));
  for (const a of all) assert.equal(a.ends === true, a.berth.endsWith('-E'), a.berth);
});

test('normalize handles the raw ConnectX ShuttleService shape', () => {
  // The real thing, straight from fms.connectx.com.sg -- richer than the
  // hewliyang proxy: an `_etas` array per service with eta / eta_s / plate /
  // ts / px, under a ShuttleServiceResult.shuttles envelope.
  const out = normalize(CONNECTX_FIXTURE);
  assert.ok(out.length >= 8);

  const d2s = out.filter((a) => a.svc === 'D2' && a.berth === 'COM3-D2-S');
  assert.ok(d2s.length >= 2, 'the full upcoming list, not just first+next');
  // eta_s (seconds) is used verbatim, not eta (minutes) re-multiplied.
  assert.equal(d2s[0].etaS, 24055);
  assert.notEqual(d2s[0].etaS, 24060, 'the rounded minutes value would be 24060');
  assert.ok(d2s.every((a) => a.plate && a.plate.startsWith('PD')), 'plates carry through');

  // Terminus split survives, and -S is the boardable berth.
  const berths = new Set(out.filter((a) => a.svc === 'D2').map((a) => a.berth));
  assert.ok(berths.has('COM3-D2-S') && berths.has('COM3-D2-E'));
});

test('bus proxy URL and headers match the captured uNivUS request', () => {
  const env = { NEXTBUS_PROXY_BASE: 'https://inetapps.nus.edu.sg/univus/api/bus-proxy/', NEXTBUS_PROXY_API_KEY: 'k' };
  assert.equal(proxyUrl(env, 'shuttle-service'), 'https://inetapps.nus.edu.sg/univus/api/bus-proxy/shuttle-service');
  const h = proxyHeaders(env, 'jwt');
  assert.equal(h['x-api-key'], 'k');
  assert.equal(h.authorization, 'Bearer jwt');
  assert.match(h['content-type'], /^application\/json/);
});

test('the proxy reports failure at HTTP 200, so only code "00000" counts as success', () => {
  assert.equal(proxyOk({ code: '00000', data: {} }), true);
  assert.equal(proxyOk({ code: '10009', msg: 'We have a new release of uNivUS' }), false);
  assert.equal(proxyOk({ result: false, error: 4 }), false, 'the old ConnectX error shape is not success either');
  assert.equal(proxyOk(null), false);
});

test('a place served by two stops: any bus to either one counts, the shorter ride wins', () => {
  // From KR MRT itself (its twin across the road is a candidate of its own).
  const legs = (input) => new Map((candidateStops(realGraph, input).find((c) => c.stop.code === 'KR-MRT')?.legs ?? []).map((l) => [l.svc, l.hops]));
  const base = { lat: null, lon: null, originCode: 'KR-MRT' };
  const a = legs({ ...base, to: 'AS5' });
  const b = legs({ ...base, to: 'NUSS-OPP' });
  const both = legs({ ...base, to: 'AS5', toAlso: ['NUSS-OPP'] });
  for (const [svc, hops] of [...a, ...b]) {
    assert.ok(both.has(svc), `${svc} reaches one of them`);
    assert.ok(both.get(svc) <= hops);
  }
});

test('inside a residence, only its own stops are offered, walked by the paths (PGP, not KR MRT over the hill)', async () => {
  const { candidateStops, walkAllTheWayS } = await import('../src/resolve.ts');
  const { default: g } = await import('../data/stops.json', { with: { type: 'json' } });
  const dorm = { lat: 1.291519, lon: 103.782764, originCode: null };
  const codes = candidateStops(g, { ...dorm, to: 'UTOWN' }).map((c) => c.stop.code);
  assert.ok(!codes.includes('KR-MRT') && !codes.includes('KR-MRT-OPP'), codes.join());
  assert.ok(codes.includes('PGPR'));
  // Walking to KR MRT goes out through the hall's stops: well over the 6 min a straight line gives.
  assert.ok(walkAllTheWayS(g, { ...dorm, to: 'KR-MRT' }, null) / 60 >= 10);
  // Outside every residence nothing changes.
  const out = candidateStops(g, { lat: 1.2935, lon: 103.7838, originCode: null, to: 'UTOWN' }).map((c) => c.stop.code);
  assert.ok(out.includes('KR-MRT'));
});

test('a window that crosses midnight still runs after it, by yesterday\'s hours', async () => {
  const { serviceEndsAt } = await import('../src/resolve.ts');
  const graph = { ...realGraph, serviceHours: { X: { weekday: ['07:00', '01:00'], saturday: ['08:00', '23:00'], sunday: null } } };
  const sgt = (d, h, m) => Date.UTC(2026, 7, d, h - 8, m); // August 2026, SGT
  assert.equal(inService(graph, 'X', sgt(29, 0, 30)), true, 'Sat 00:30: Friday\'s service');
  assert.equal(serviceEndsAt(graph, 'X', sgt(29, 0, 30)), sgt(29, 1, 0));
  assert.equal(inService(graph, 'X', sgt(29, 1, 30)), false, 'Sat 01:30: ended, Saturday opens at 8');
  assert.equal(inService(graph, 'X', sgt(28, 23, 30)), true, 'Fri 23:30');
  assert.equal(serviceEndsAt(graph, 'X', sgt(28, 23, 30)), sgt(29, 1, 0), 'closes tomorrow');
  assert.equal(inService(graph, 'X', sgt(31, 0, 30)), false, 'Mon 00:30: Sunday did not run');
  assert.equal(inService(graph, 'X', sgt(31, 7, 30)), true, 'Mon 07:30');
});
