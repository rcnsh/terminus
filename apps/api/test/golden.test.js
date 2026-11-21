import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { FROZEN_NOW, installGlobals, makeCtx, makeDurableObjects, makeEnv, makeFetch, makeKV } from './_stubs.mjs';
import { makeD1, makeEmail } from './_d1.mjs';
import worker from '../src/index.ts';
import { Trip } from '../src/push/tripdo.ts';
import { ASSUME_MS, CHANGE_GRACE_MS, RIDE_GRACE_MS } from '../src/answer/phase.ts';
import { onRideQuery, rideLength } from './_ride.mjs';
import { withoutMeasuredHeadways } from './_headways.mjs';

withoutMeasuredHeadways();

const DIR = new URL('../../../fixtures/answers/', import.meta.url);
const ZH_DIR = new URL('./zh/', DIR);
const BASE = 'https://bus.example.test';

const UPDATE_RAW = process.env.UPDATE_GOLDEN ?? '';
const UPDATE_ALL = UPDATE_RAW === '1' || UPDATE_RAW === 'true';
const UPDATE_ONLY = new Set(
  UPDATE_ALL || !UPDATE_RAW
    ? []
    : UPDATE_RAW.split(',')
        .map((s) => s.trim())
        .filter(Boolean),
);
const updating = (name) => UPDATE_ALL || UPDATE_ONLY.has(name);

const MIN = 60_000;
const sgtAt = (date, hhmm) => Date.parse(`${date}T${hhmm}:00+08:00`);

const FEED = {};
for (const code of ['PGP', 'PGPR', 'COM3', 'UTOWN', 'KR-MRT', 'KR-MRT-OPP', 'CLB', 'LT27', 'AS5']) {
  FEED[code] = [
    { name: 'D2', arrivalTime: '4', nextArrivalTime: '14', passengers: 'low' },
    { name: 'A1', arrivalTime: '9', nextArrivalTime: '19', passengers: 'high' },
    { name: 'R2', arrivalTime: '6', nextArrivalTime: '18', passengers: 'medium' },
    { name: 'D1', arrivalTime: '7', nextArrivalTime: '17', passengers: 'low' },
  ];
}

const LATE_FEED = {
  PGP: [
    { name: 'D2', arrivalTime: '4', nextArrivalTime: '14', passengers: 'low' },
    { name: 'A1', arrivalTime: '9', nextArrivalTime: '19', passengers: 'low' },
  ],
};

async function account(profile, { at = FROZEN_NOW, feed = FEED, upstream = {}, kv = {}, trips = false, env: more = {} } = {}) {
  let now = at;
  installGlobals(makeFetch({ byStop: feed, ...upstream }), now);
  Date.now = () => now;
  const env = {
    ...makeEnv(makeKV(kv)),
    DB: makeD1(),
    EMAIL: makeEmail(),
    EMAIL_FROM: 'x@example.test',
    ...(trips ? { TRIPS: makeDurableObjects(Trip) } : {}),
    ...more,
  };
  const call = async (path, init = {}) => {
    const ctx = makeCtx();
    const res = await worker.fetch(new Request(BASE + path, init), env, ctx);
    await ctx.settle();
    return res;
  };
  await call('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'you@u.nus.edu' }),
  });
  const verify = await call('/auth/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `t=${env.EMAIL.lastToken()}`,
  });
  const cookie = verify.headers.get('set-cookie').split(';')[0];
  const put = await call('/api/me/profile', {
    method: 'PUT',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify(profile),
  });
  assert.equal(put.status, 200, await put.clone().text());
  const get = (path) => get.raw(path).then((r) => r.json());
  get.raw = (path) => call(path, { headers: { cookie } });
  get.post = async (path, body) => {
    const res = await call(path, {
      method: 'POST',
      headers: { cookie, origin: BASE, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(res.status, 200, await res.clone().text());
    return res.json();
  };
  get.at = (ms) => {
    now = ms;
  };
  get.advance = (ms) => {
    now += ms;
  };
  get.upstream = (opts) => {
    globalThis.fetch = makeFetch(opts);
  };
  return get;
}

const THU = 4;
const places = [
  { key: 'mrt', label: 'KR MRT', to: 'KR-MRT' },
  { key: 'deck', label: 'The Deck', to: 'THE-DECK' },
];
const cls = (arriveByMin, to, label, venue = '') => ({ day: THU, arriveByMin, endMin: arriveByMin + 60, to, label, venue });
const IN_PGP = 'lat=1.2915&lon=103.7828';
const CLB = 'lat=1.2966&lon=103.7724';
const AT_COM3 = 'lat=1.294431&lon=103.775217';
const AT_UTOWN = 'lat=1.303876&lon=103.774621';
const AT_PGP_STOP = 'lat=1.291765&lon=103.780419';
const AT_IT = 'lat=1.297204&lon=103.772688';
const AT_PGP_KR_END = 'lat=1.2915&lon=103.783';
const AT_KR_MRT = 'lat=1.29482&lon=103.784413';
const THU_DATE = '2026-08-27';

const TAP_FEED = {
  PGP: [{ name: 'D2', arrivalTime: '1', arrivalTime_veh_plate: 'SBS1234A', nextArrivalTime: '11', nextArrivalTime_veh_plate: 'SBS5678B' }],
  UTOWN: [
    { name: 'D2', arrivalTime: '10', arrivalTime_veh_plate: 'SBS1234A', nextArrivalTime: '20', nextArrivalTime_veh_plate: 'SBS5678B' },
  ],
};
const PGP_STOP = { lat: 1.291765, lon: 103.780419 };

const onceDay = { home: { stops: ['PGP'] }, manual: [{ ...cls(600, 'LT13', 'GEX1015 @ AS3'), endMin: 630 }], places };
const IN_COM3 = 'lat=1.29474&lon=103.77395';

const soon = { home: { stops: ['PGP'] }, manual: [cls(555, 'UTOWN', 'GEA1000 @ UTown')], places };

const PLATE_FEED = {
  PGP: [
    { name: 'D2', arrivalTime: '6', arrivalTime_veh_plate: 'SBS1234A', nextArrivalTime: '16', nextArrivalTime_veh_plate: 'SBS5678B' },
    { name: 'R2', arrivalTime: '20', arrivalTime_veh_plate: 'SBS9012C' },
  ],
  UTOWN: [
    { name: 'D2', arrivalTime: '14', arrivalTime_veh_plate: 'SBS1234A', nextArrivalTime: '24', nextArrivalTime_veh_plate: 'SBS5678B' },
  ],
};

const CHANGE_FEED = {
  PGP: [
    { name: 'R2', arrivalTime: '6', nextArrivalTime: '18' },
    { name: 'K', arrivalTime: '8', nextArrivalTime: '23' },
    { name: 'A1', arrivalTime: '9', nextArrivalTime: '19' },
    { name: 'D2', arrivalTime: '4', nextArrivalTime: '14' },
  ],
  KV: [{ name: 'P', arrivalTime: '22', nextArrivalTime: '42' }],
  'KR-MRT': [{ name: 'P', arrivalTime: '15', nextArrivalTime: '35' }],
};
const toCG = { home: { stops: ['PGP'] }, manual: [cls(600, 'CG', 'GEH1001 @ CG')], places };

const LTA = { env: { LTA_ACCOUNT_KEY: 'test-account-key' } };

const nusmods = (...days) => ({
  home: { stops: ['PGP'] },
  term: { acadYear: '2026/2027', semester: 1 },
  trips: days.map((day) => ({
    day,
    arriveByMin: 600,
    endMin: 720,
    weeks: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13],
    to: 'UTOWN',
    label: 'GEA1000 @ UTown',
    venue: '',
  })),
  places,
});

const CASES = {
  'class-bus': [{ home: { stops: ['PGP'] }, manual: [cls(600, 'UTOWN', 'GEA1000 @ UTown')], places }, '/api/me/next'],
  'class-walk': [{ home: { stops: ['PGP'] }, manual: [cls(600, 'COM3', 'CS2030 @ COM1', 'COM1')], places }, `/api/me/next?${CLB}`],
  'class-late': [{ home: { stops: ['PGP'] }, manual: [cls(545, 'UTOWN', 'GEA1000 @ UTown')], places }, '/api/me/next'],
  'class-from-dorm': [
    { home: { stops: ['PGPR', 'PGP'] }, manual: [cls(600, 'UTOWN', 'GEA1000 @ UTown')], places },
    `/api/me/next?${IN_PGP}`,
  ],
  'place': [{ home: { stops: ['PGP'] }, places }, '/api/me/next?place=mrt'],
  'landmark': [{ home: { stops: ['PGP'] }, places }, '/api/me/next?place=deck'],
  'class-room': [{ home: { stops: ['PGP'] }, manual: [cls(600, 'UTOWN', 'GEA1000 @ UTown', 'TP-SR2')], places }, '/api/me/next'],
  'room': [{ home: { stops: ['PGP'] }, places }, '/api/me/next?to=LT3'],
  'arrived': [{ home: { stops: ['PGP'] }, places }, `/api/me/next?to=COM3&${AT_COM3}`],
  'free': [{ home: { stops: ['PGP'] }, manual: [{ ...cls(600, 'COM3', 'CS2030 @ COM1'), day: 5 }], places }, `/api/me/next?${CLB}`],
  'class-started': [{ home: { stops: ['PGP'] }, manual: [cls(530, 'UTOWN', 'GEA1000 @ UTown')], places }, '/api/me/next'],
  'home-reached': [{ home: { stops: ['PGP'] }, manual: [cls(390, 'COM3', 'CS2030 @ COM1')], places }, '/api/me/next'],
  'evening-home': [{ home: { stops: ['PGP'] }, dayStartMin: 600, dayEndMin: 1200, places }, `/api/me/next?${CLB}`],
  'rest': [
    { home: { stops: ['PGP'] }, dayStartMin: 600, dayEndMin: 1200, manual: [cls(780, 'COM3', 'CS2030 @ COM1')], places },
    '/api/me/next',
  ],
  'home': [{ home: { stops: ['PGPR', 'PGP'] }, manual: [cls(420, 'COM3', 'CS2030 @ COM1')], places }, `/api/me/next?${IN_PGP}`],
  'setup': [{ manual: [cls(600, 'UTOWN', 'GEA1000 @ UTown')], places }, '/api/me/next'],
  'no-timetable': [{}, '/api/me/next'],
  'riding': [
    { home: { stops: ['PGP'] }, manual: [cls(600, 'UTOWN', 'GEA1000 @ UTown')], places },
    '/api/me/next',
    { trips: true, before: (get) => get.post('/api/me/signal', { kind: 'boarded' }) },
  ],
  'change-class': [toCG, '/api/me/next', { feed: CHANGE_FEED }],
  'change-riding': [
    toCG,
    '/api/me/next',
    { trips: true, at: sgtAt(THU_DATE, '09:20'), feed: CHANGE_FEED, before: (get) => get.post('/api/me/signal', { kind: 'boarded' }) },
  ],
  'change-at-stop': [
    toCG,
    '/api/me/next',
    {
      trips: true,
      at: sgtAt(THU_DATE, '09:20'),
      feed: CHANGE_FEED,
      before: async (get) => {
        const { card } = await get.post('/api/me/signal', { kind: 'boarded' });
        get.at(Date.parse(card.ride.arrive) + MIN);
      },
    },
  ],
  'change-riding-second': [
    toCG,
    '/api/me/next',
    {
      trips: true,
      at: sgtAt(THU_DATE, '09:20'),
      feed: CHANGE_FEED,
      before: async (get) => {
        const { card } = await get.post('/api/me/signal', { kind: 'boarded' });
        get.at(Date.parse(card.ride.change.board) + CHANGE_GRACE_MS + MIN);
      },
    },
  ],
  'scheduled': [{ home: { stops: ['PGP'] }, places }, '/api/me/next?place=mrt', { feed: {} }],
  'nearby-list': [{ home: { stops: ['PGP'] } }, `/api/me/nearby?${IN_PGP}`],
  'day': [
    { home: { stops: ['PGP'] }, manual: [cls(600, 'UTOWN', 'GEA1000 @ UTown'), cls(840, 'COM3', 'CS2030 @ COM4', 'COM4')], places },
    '/api/me/day',
  ],
  'riding-live': [
    soon,
    '/api/me/next',
    {
      trips: true,
      at: sgtAt(THU_DATE, '09:05'),
      feed: TAP_FEED,
      before: (get) => get.post('/api/me/signal', { kind: 'boarded', ...PGP_STOP }),
    },
  ],
  'riding-there': [
    soon,
    '/api/me/next',
    {
      trips: true,
      at: sgtAt(THU_DATE, '09:05'),
      feed: TAP_FEED,
      before: async (get) => {
        await get.post('/api/me/signal', { kind: 'boarded', ...PGP_STOP });
        get.at(sgtAt(THU_DATE, '09:15') + RIDE_GRACE_MS + MIN);
        get.upstream({ byStop: FEED });
      },
    },
  ],
  'missed': [
    { home: { stops: ['PGP'] }, manual: [cls(600, 'UTOWN', 'GEA1000 @ UTown')], places },
    '/api/me/next',
    {
      trips: true,
      at: sgtAt(THU_DATE, '09:38'),
      before: async (get) => {
        await get('/api/me/next');
        get.at(sgtAt(THU_DATE, '09:45'));
        await get.post('/api/me/signal', { kind: 'missed' });
      },
    },
  ],
  'assumed-riding': [
    soon,
    '/api/me/next',
    {
      trips: true,
      feed: PLATE_FEED,
      before: async (get) => {
        await get(`/api/me/next?${IN_PGP}`);
        get.at(sgtAt(THU_DATE, '09:06') + ASSUME_MS + MIN);
        await get(`/api/me/next${onRideQuery('D2', 'PGP', 'UTOWN', rideLength('D2', 'PGP', 'UTOWN') - 400)}`);
      },
    },
  ],
  'bus-gone': [
    soon,
    '/api/me/next',
    {
      trips: true,
      feed: PLATE_FEED,
      before: async (get) => {
        await get(`/api/me/next?${IN_PGP}`);
        get.at(sgtAt(THU_DATE, '09:06') + ASSUME_MS + MIN);
      },
    },
  ],
  'plan-kept': [
    soon,
    '/api/me/next',
    {
      trips: true,
      feed: PLATE_FEED,
      before: async (get) => {
        await get(`/api/me/next?${IN_PGP}`);
        get.advance(MIN);
        get.upstream({ byStop: { PGP: [{ name: 'D2', arrivalTime: '7', nextArrivalTime: '17' }] } });
      },
    },
  ],
  'once-from-home': [
    onceDay,
    `/api/me/next?${IN_PGP}`,
    {
      trips: true,
      at: sgtAt(THU_DATE, '10:40'),
      before: async (get) => {
        await get(`/api/me/next?${IN_PGP}`);
        get.at(sgtAt(THU_DATE, '11:45'));
        await get.post('/api/me/once', { to: 'COM3', label: 'COM 3', atMin: 720 });
        get.advance(4 * MIN);
      },
    },
  ],
  'once-in-building': [
    onceDay,
    `/api/me/next?${IN_COM3}`,
    {
      trips: true,
      at: sgtAt(THU_DATE, '12:45'),
      before: async (get) => {
        await get.post('/api/me/once', { to: 'COM3', label: 'COM 3', atMin: 766 });
        get.advance(MIN);
      },
    },
  ],
  'skipped-undo': [
    { home: { stops: ['PGP'] }, manual: [cls(600, 'UTOWN', 'GEA1000 @ UTown'), { ...cls(600, 'COM3', 'CS2030 @ COM1'), day: 5 }], places },
    '/api/me/next',
    { trips: true, before: (get) => get.post('/api/me/signal', { kind: 'skipped' }) },
  ],
  'away': [
    { home: { stops: ['PGP'] }, manual: [cls(600, 'UTOWN', 'GEA1000 @ UTown'), { ...cls(600, 'COM3', 'CS2030 @ COM1'), day: 5 }], places },
    '/api/me/next',
    { trips: true, before: (get) => get.post('/api/me/signal', { kind: 'away' }) },
  ],
  'walk-level': [{ places }, `/api/me/next?to=UTOWN&${AT_PGP_STOP}`, { feed: { PGP: [{ name: 'D2', _etas: [{ eta_s: 1264 }] }] } }],
  'heat-bus': [
    { places },
    `/api/me/next?to=KR-MRT&${AT_PGP_KR_END}`,
    { feed: { PGP: [{ name: 'D2', arrivalTime: '14', nextArrivalTime: '24' }] } },
  ],
  'heat-walk': [
    { places, preferBus: false },
    `/api/me/next?to=KR-MRT&${AT_PGP_KR_END}`,
    { feed: { PGP: [{ name: 'D2', arrivalTime: '14', nextArrivalTime: '24' }] } },
  ],
  'cross-road': [
    { home: { stops: ['UTOWN'] }, places },
    `/api/me/next?to=COM3&${AT_KR_MRT}`,
    {
      feed: {
        'KR-MRT': [
          { name: 'D2', arrivalTime: '2', nextArrivalTime: '12' },
          { name: 'A1', arrivalTime: '3', nextArrivalTime: '13' },
          { name: 'K', arrivalTime: '5', nextArrivalTime: '20' },
        ],
        'KR-MRT-OPP': [
          { name: 'D2', arrivalTime: '5', nextArrivalTime: '15' },
          { name: 'A2', arrivalTime: '8', nextArrivalTime: '18' },
          { name: 'K', arrivalTime: '7', nextArrivalTime: '22' },
        ],
      },
    },
  ],
  'ambiguous-berth': [
    { home: { stops: ['PGP'] }, places },
    `/api/me/next?to=UTOWN&${AT_COM3}`,
    { feed: { COM3: [{ name: 'D2', busStopCode: 'COM3-D2-E', arrivalTime: '3', nextArrivalTime: '13' }] } },
  ],
  'unknown-dest': [{ home: { stops: ['PGP'] }, manual: [cls(600, 'UTOWN', 'GEA1000 @ UTown')], places }, '/api/me/next?to=XYZ'],
  'public-level': [
    { home: { stops: ['PGP'] }, places, publicBuses: true },
    `/api/me/next?to=KR-MRT-OPP&${AT_IT}`,
    {
      ...LTA,
      feed: { IT: [{ name: 'A2', arrivalTime: '6', nextArrivalTime: '16' }] },
      upstream: { publicStops: { 16189: [{ ServiceNo: '95', buses: [{ etaS: 6 * 60 + 63, dest: '16009' }] }] } },
    },
  ],
  'public-timetabled': [
    { home: { stops: ['PGP'] }, places, publicBuses: true },
    `/api/me/next?to=CG&${AT_IT}`,
    {
      ...LTA,
      feed: {},
      upstream: { publicStops: { 16189: [{ ServiceNo: '151', buses: [{ etaS: 240, dest: '64009', monitored: false }] }] } },
    },
  ],

  'public-wins': [
    { home: { stops: ['PGP'] }, places, publicBuses: true },
    `/api/me/next?to=KR-MRT-OPP&${AT_IT}`,
    {
      ...LTA,
      feed: { IT: [{ name: 'A2', arrivalTime: '15', nextArrivalTime: '25' }] },
      upstream: { publicStops: { 16189: [{ ServiceNo: '95', buses: [{ etaS: 120, dest: '16009' }] }] } },
    },
  ],

  'holiday-class': [
    { home: { stops: ['PGP'] }, manual: [{ ...cls(600, 'UTOWN', 'GEA1000 @ UTown'), day: 1 }], places },
    '/api/me/next',
    { at: sgtAt('2026-11-09', '08:30'), feed: {} },
  ],
  'holiday-nusmods': [nusmods(1, 2), '/api/me/next', { at: sgtAt('2026-11-09', '08:30'), feed: {} }],
  'nusmods-class': [nusmods(THU), '/api/me/next'],
  'nusmods-recess': [nusmods(2), '/api/me/next', { at: sgtAt('2026-09-22', '09:00') }],
  'nusmods-reading': [nusmods(2), '/api/me/next', { at: sgtAt('2026-11-17', '09:00') }],
  'nusmods-exams': [nusmods(2), '/api/me/next', { at: sgtAt('2026-11-24', '09:00') }],
  'nusmods-vacation': [nusmods(2), '/api/me/next', { at: sgtAt('2026-12-08', '09:00') }],
  'sgt-midnight': [
    { home: { stops: ['PGP'] }, manual: [{ ...cls(600, 'COM3', 'CS2030 @ COM1'), day: 5 }], places },
    '/api/me/next',
    { at: sgtAt('2026-08-28', '00:20'), feed: {} },
  ],
  'sgt-midnight-class': [
    { home: { stops: ['PGP'] }, manual: [{ ...cls(30, 'COM3', 'CS2030 @ COM1'), day: 5 }], places },
    '/api/me/next',
    { at: sgtAt('2026-08-28', '00:20'), feed: {} },
  ],

  'after-last-bus': [{ home: { stops: ['PGP'] }, places }, `/api/me/next?${AT_UTOWN}`, { at: sgtAt(THU_DATE, '23:10'), feed: {} }],
  'last-bus-warning': [
    { home: { stops: ['UTOWN'] }, places },
    `/api/me/next?${AT_PGP_STOP}`,
    { at: sgtAt(THU_DATE, '22:40'), feed: LATE_FEED },
  ],
  'before-first-bus': [
    { home: { stops: ['PGP'] }, manual: [cls(480, 'UTOWN', 'GEA1000 @ UTown')], places },
    '/api/me/next',
    { at: sgtAt(THU_DATE, '06:30'), feed: {} },
  ],

  'feed-down': [
    { home: { stops: ['PGP'] }, manual: [cls(600, 'UTOWN', 'GEA1000 @ UTown')], places },
    '/api/me/next',
    { upstream: { fail: true } },
  ],
  'stale': [
    { home: { stops: ['PGP'] }, places },
    '/api/me/next?place=mrt',
    {
      at: FROZEN_NOW - 3 * MIN,
      before: async (get) => {
        await get('/api/me/next?place=mrt');
        get.advance(3 * MIN);
        get.upstream({ fail: true });
      },
    },
  ],
};

const SAYS = {
  'class-room': 'a class in a room a walk from its stop: the leave-by aims at the room, and the card shows the walk on',
  'room': 'a room searched for by its code: the bus to its stop, then the walk on to the room',
  'free': 'a day with no classes is said plainly, with the next one, and no bus headline',
  'class-started': 'a class that started 10 minutes ago is still where you are going',
  'home-reached': 'an hour after the last class, with no location, you are home',
  'evening-home': 'outside your day, on campus and not at home: the way home, not a moon',
  'setup': 'a class but no home stop and no location: nowhere to start from',
  'no-timetable': 'a new account with nothing in it: no timetable yet, said plainly',
  'riding': 'on the bus to a class: the ride, with its stops, in place of the journey',
  'change-class': 'no single bus goes from PGP to College Green: the trip changes to P',
  'change-riding': 'at 09:20, on the K to Kent Vale, where you change to P',
  'change-at-stop': 'off the K at Kent Vale a minute after it got there: at the stop for the P',
  'change-riding-second': 'once the P has left: on it to College Green',
  'scheduled': 'the feed answers with no buses: every time is an estimate, marked ~',
  'day': 'the day the apps keep for offline: a class, a long gap home, a class, the way home',
  'riding-live': 'on the D2 at PGP at 09:05: its plate is picked from the feed at the tap, and its live time at UTown is the arrival',
  'riding-there': 'ten minutes after the bus got there and the feed no longer lists it: you are in the class',
  'missed': 'the R2 planned for 09:44 is kept, and at 09:45 Missed it names it and gives the next way there',
  'assumed-riding': 'three minutes after the planned D2 left, the phone on its road past a walk: the Mac takes you to be on it too',
  'bus-gone': 'the planned D2 has left and no location since: not known to be on it, the next way there',
  'plan-kept': 'the feed says the planned D2 is 2 min late: the widget keeps the planned bus and times, not live',
  'once-from-home': 'COM 3 added from an app with no location, at home after a class: planned from home, Going to',
  'once-in-building': 'inside COM3, COM 3 added for a minute from now: the walk to its stop, not a bus from home',
  'skipped-undo': 'Not going to the 10:00 class: nothing left today, and an Undo',
  'away': 'Not on campus today: said, with the way back',
  'walk-level': 'a walk level with a live bus does not beat it by WALK.beatsBusByS: the bus heads the card, the walk said as close',
  'heat-bus': 'walking wins by minutes but not in the heat (WALK.sunWeight): the bus heads the card, the walk said as close',
  'heat-walk': 'the same with preferBus off: the walk',
  'cross-road': 'at KR MRT for COM 3, the buses on this side go the long way round: the D2 from across the road, and it says so',
  'ambiguous-berth': 'the D2 listed only as runs ending at COM 3: its time shown, its direction said to be unknown',
  'unknown-dest': 'a destination that is no stop, room or place is ignored: the day answer, not a free day',
  'public-level': 'the 95 level with the A2 once its fare is counted: the free bus heads the card, the 95 is the other way',
  'public-timetabled': 'only the 151 goes there and LTA times it from the timetable: an estimate, named 151',
  'public-wins': 'the 95 in 2 min beats the A2 in 15 by more than its fare: it heads the card, marked ($)',
  'holiday-class': 'Deepavali (observed) runs Sunday hours: no R2, so the first D2',
  'holiday-nusmods': 'on the holiday an imported Monday class does not run, says why, and Tuesday is next',
  'nusmods-class': 'an imported class on a Thursday in week 3 runs, ending about half an hour early',
  'nusmods-recess': 'an imported class off for the recess, said plainly',
  'nusmods-reading': 'an imported class off for reading week, said plainly',
  'nusmods-exams': 'an imported class off for the exams, said plainly',
  'nusmods-vacation': 'an imported class off for the vacation, said plainly',
  'sgt-midnight': 'Friday 00:20 in Singapore is still Thursday in UTC: the 10:00 class is today, and no bus runs',
  'sgt-midnight-class': 'a 00:30 class a 15-minute walk away: late, and the card says when you get there',
  'after-last-bus': 'Thursday 23:10 at UTown, every service stopped: the walk home, said plainly',
  'last-bus-warning': 'Thursday 22:40 at PGP, home at UTown: the D2 home, warned that it stops at 23:00',
  'before-first-bus': 'Thursday 06:30 for an 08:00 class, feed empty: the first D2, and the wait does not make walking win',
  'feed-down': 'the feed unreachable and nothing cached: no time made up, every bus unknown, worded no live times',
  'stale': 'a good reading three minutes ago then the feed fails: that reading counted down, said to be three minutes old',
};

const RUNS = [
  ['', {}, DIR],
  ['zh ', { lang: 'zh' }, ZH_DIR],
];

for (const [name, [profile, path, opts = {}]] of Object.entries(CASES))
  for (const [tag, extra, dir] of RUNS) {
    test(`golden: ${tag}${name}${SAYS[name] ? `: ${SAYS[name]}` : ''}`, async () => {
      const get = await account({ ...profile, ...extra }, opts);
      await opts.before?.(get);
      const res = await get.raw(path);
      const body = await res.json();
      assert.equal(res.status, opts.status ?? 200, JSON.stringify(body));
      const file = new URL(`${name}.json`, dir);
      const text = JSON.stringify(body, null, 2) + '\n';
      if (updating(name)) {
        fs.writeFileSync(file, text);
        return;
      }
      assert.ok(fs.existsSync(file), `no fixture for ${tag}${name}; record it with UPDATE_GOLDEN=${name} pnpm test and review it`);
      assert.equal(text, fs.readFileSync(file, 'utf8'), `${name} changed; if on purpose, UPDATE_GOLDEN=${name} pnpm test`);
    });
  }

test('golden: every fixture belongs to a case', () => {
  for (const dir of [DIR, ZH_DIR]) {
    const orphans = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !Object.hasOwn(CASES, f.slice(0, -'.json'.length)));
    if (UPDATE_ALL) for (const f of orphans) fs.unlinkSync(new URL(f, dir));
    else assert.deepEqual(orphans, [], `fixtures no case makes, in ${dir.pathname}: delete them, or UPDATE_GOLDEN=1 pnpm test`);
  }
});
