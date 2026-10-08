/**
 * Golden answers: the exact JSON /me/next and /me/nearby return for a set of
 * fixed situations, each on its own frozen clock and fake feed. Refactors must
 * reproduce them byte for byte; a deliberate change is re-recorded with
 *
 *   UPDATE_GOLDEN=1 pnpm test          every case
 *   UPDATE_GOLDEN=stale pnpm test      only the cases named (comma-separated)
 *
 * and shows up as a diff in test/fixtures/answers/. A fixture that's missing
 * fails rather than being written, and so does one no case makes: a case
 * that quietly records whatever it got would pin a wrong answer as the spec.
 * The Android and Mac unit tests parse these same files, so a change in
 * shape fails there too.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { FROZEN_NOW, installGlobals, makeCtx, makeDurableObjects, makeEnv, makeFetch, makeKV } from './_stubs.mjs';
import { makeD1, makeEmail } from './_d1.mjs';
import worker from '../src/index.ts';
import { Trip } from '../src/tripdo.ts';
import { ASSUME_MS, RIDE_GRACE_MS } from '../src/trip.ts';

const DIR = new URL('./fixtures/answers/', import.meta.url);
const ZH_DIR = new URL('./zh/', DIR);
const BASE = 'https://bus.example.test';

/** UPDATE_GOLDEN=1 re-records every case; any other value names the cases to re-record. */
const UPDATE_RAW = process.env.UPDATE_GOLDEN ?? '';
const UPDATE_ALL = UPDATE_RAW === '1' || UPDATE_RAW === 'true';
const UPDATE_ONLY = new Set(UPDATE_ALL || !UPDATE_RAW ? [] : UPDATE_RAW.split(',').map((s) => s.trim()).filter(Boolean));
const updating = (name) => UPDATE_ALL || UPDATE_ONLY.has(name);

const MIN = 60_000;
/** A Singapore wall-clock time as epoch ms: sgtAt('2026-08-27', '09:00'). */
const sgtAt = (date, hhmm) => Date.parse(`${date}T${hhmm}:00+08:00`);

// Every service at every stop: D2 in 4 and 14 min, A1 in 9, R2 in 6.
const FEED = {};
for (const code of ['PGP', 'PGPR', 'COM3', 'UTOWN', 'KR-MRT', 'KR-MRT-OPP', 'CLB', 'LT27', 'AS5']) {
  FEED[code] = [
    { name: 'D2', arrivalTime: '4', nextArrivalTime: '14', passengers: 'low' },
    { name: 'A1', arrivalTime: '9', nextArrivalTime: '19', passengers: 'high' },
    { name: 'R2', arrivalTime: '6', nextArrivalTime: '18', passengers: 'medium' },
    { name: 'D1', arrivalTime: '7', nextArrivalTime: '17', passengers: 'low' },
  ];
}

// Late on a weekday: only the services that run past 19:30 (R1, R2 and P have stopped).
const LATE_FEED = {
  PGP: [
    { name: 'D2', arrivalTime: '4', nextArrivalTime: '14', passengers: 'low' },
    { name: 'A1', arrivalTime: '9', nextArrivalTime: '19', passengers: 'low' },
  ],
};

/**
 * An account with `profile`, signed in on the web, and a way to ask it things.
 *
 * - `at`: the clock to start on (epoch ms; Thursday 09:00 SGT by default).
 * - `feed`: the NUS feed's arrivals by stop, in place of FEED.
 * - `upstream`: anything else makeFetch takes (`fail`, `publicStops`, `buses`...).
 * - `kv`: KV seeded with these keys.
 * - `trips`: binds the trip engine, for a case with signals.
 * - `env`: more bindings and secrets (LTA's key, for the public buses).
 *
 * The returned `get(path)` answers the parsed JSON; `get.post` sends a
 * signal; `get.at(ms)` / `get.advance(ms)` move the clock; `get.upstream(opts)`
 * swaps the fake upstream (the feed going down after a good reading).
 */
async function account(profile, { at = FROZEN_NOW, feed = FEED, upstream = {}, kv = {}, trips = false, env: more = {} } = {}) {
  let now = at;
  installGlobals(makeFetch({ byStop: feed, ...upstream }), now);
  Date.now = () => now;
  const env = { ...makeEnv(makeKV(kv)), DB: makeD1(), EMAIL: makeEmail(), EMAIL_FROM: 'x@example.test', ...(trips ? { TRIPS: makeDurableObjects(Trip) } : {}), ...more };
  const call = async (path, init = {}) => {
    const ctx = makeCtx();
    const res = await worker.fetch(new Request(BASE + path, init), env, ctx);
    await ctx.settle();
    return res;
  };
  await call('/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'you@u.nus.edu' }) });
  const verify = await call('/auth/verify', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `t=${env.EMAIL.lastToken()}` });
  const cookie = verify.headers.get('set-cookie').split(';')[0];
  const put = await call('/me/profile', { method: 'PUT', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(profile) });
  assert.equal(put.status, 200, await put.clone().text());
  const get = (path) => get.raw(path).then((r) => r.json());
  get.raw = (path) => call(path, { headers: { cookie } });
  get.post = async (path, body) => {
    const res = await call(path, { method: 'POST', headers: { cookie, origin: BASE, 'content-type': 'application/json' }, body: JSON.stringify(body) });
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

const THU = 4; // FROZEN_NOW is Thursday 2026-08-27, 09:00 SGT
const places = [{ key: 'mrt', label: 'KR MRT', to: 'KR-MRT' }, { key: 'deck', label: 'The Deck', to: 'THE-DECK' }];
const cls = (arriveByMin, to, label, venue = '') => ({ day: THU, arriveByMin, endMin: arriveByMin + 60, to, label, venue });
const DORM = 'lat=1.2915&lon=103.7828'; // inside PGP
const CLB = 'lat=1.2966&lon=103.7724';
const AT_COM3 = 'lat=1.294431&lon=103.775217';
const AT_UTOWN = 'lat=1.303876&lon=103.774621';
const AT_PGP = 'lat=1.291765&lon=103.780419'; // the PGP bus stop
const AT_IT = 'lat=1.297204&lon=103.772688';
const AT_KR_MRT = 'lat=1.29482&lon=103.784413';
const THU_DATE = '2026-08-27';

/** At 09:05, the D2 about to reach PGP, the feed giving its plate, and the same bus at UTown in 10 min. */
const TAP_FEED = {
  PGP: [{ name: 'D2', arrivalTime: '1', arrivalTime_veh_plate: 'SBS1234A', nextArrivalTime: '11', nextArrivalTime_veh_plate: 'SBS5678B' }],
  UTOWN: [{ name: 'D2', arrivalTime: '10', arrivalTime_veh_plate: 'SBS1234A', nextArrivalTime: '20', nextArrivalTime_veh_plate: 'SBS5678B' }],
};
/** A signal's location: at the PGP bus stop. */
const PGP_STOP = { lat: 1.291765, lon: 103.780419 };

/** A class at 09:15 at UTown: too soon for anything but the next bus. */
const soon = { home: { stops: ['PGP'] }, manual: [cls(555, 'UTOWN', 'GEA1000 @ UTown')], places };

/** The D2 at PGP in 6 min, the feed giving its plate, and the same bus at UTown in 14; the R2 not for 20. */
const PLATE_FEED = {
  PGP: [
    { name: 'D2', arrivalTime: '6', arrivalTime_veh_plate: 'SBS1234A', nextArrivalTime: '16', nextArrivalTime_veh_plate: 'SBS5678B' },
    { name: 'R2', arrivalTime: '20', arrivalTime_veh_plate: 'SBS9012C' },
  ],
  UTOWN: [{ name: 'D2', arrivalTime: '14', arrivalTime_veh_plate: 'SBS1234A', nextArrivalTime: '24', nextArrivalTime_veh_plate: 'SBS5678B' }],
};

/** LTA DataMall's key, fake, so the public buses are asked for. */
const LTA = { env: { LTA_ACCOUNT_KEY: 'test-account-key' } };

/** An imported NUSMods timetable for semester 1 of 2026/27: a class at 10:00 on each of `days`, teaching weeks 1 to 13. */
const nusmods = (...days) => ({
  home: { stops: ['PGP'] },
  term: { acadYear: '2026/2027', semester: 1 },
  trips: days.map((day) => ({ day, arriveByMin: 600, endMin: 720, weeks: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13], to: 'UTOWN', label: 'GEA1000 @ UTown', venue: '' })),
  places,
});

const CASES = {
  'class-bus': [{ home: { stops: ['PGP'] }, manual: [cls(600, 'UTOWN', 'GEA1000 @ UTown')], places }, '/me/next'],
  'class-walk': [{ home: { stops: ['PGP'] }, manual: [cls(600, 'COM3', 'CS2030 @ COM1', 'COM1')], places }, `/me/next?${CLB}`],
  'class-late': [{ home: { stops: ['PGP'] }, manual: [cls(545, 'UTOWN', 'GEA1000 @ UTown')], places }, '/me/next'],
  'class-from-dorm': [{ home: { stops: ['PGPR', 'PGP'] }, manual: [cls(600, 'UTOWN', 'GEA1000 @ UTown')], places }, `/me/next?${DORM}`],
  'place': [{ home: { stops: ['PGP'] }, places }, '/me/next?place=mrt'],
  'landmark': [{ home: { stops: ['PGP'] }, places }, '/me/next?place=deck'],
  // A class in a room a walk from its stop: the leave-by aims at the room, and the card shows the walk on.
  'class-room': [{ home: { stops: ['PGP'] }, manual: [cls(600, 'UTOWN', 'GEA1000 @ UTown', 'TP-SR2')], places }, '/me/next'],
  // A room searched for (its code, as search sends it): the bus to its stop, then the walk on to the room.
  'room': [{ home: { stops: ['PGP'] }, places }, '/me/next?to=LT3'],
  'arrived': [{ home: { stops: ['PGP'] }, places }, `/me/next?to=COM3&${AT_COM3}`],
  // A day with no classes: said plainly, with the next one; no bus headline.
  'free': [{ home: { stops: ['PGP'] }, manual: [{ ...cls(600, 'COM3', 'CS2030 @ COM1'), day: 5 }], places }, `/me/next?${CLB}`],
  // 2.1: a class that started 10 minutes ago is still where you're going.
  'class-started': [{ home: { stops: ['PGP'] }, manual: [cls(530, 'UTOWN', 'GEA1000 @ UTown')], places }, '/me/next'],
  // 2.1: an hour after the last class, with no location, you're home.
  'home-reached': [{ home: { stops: ['PGP'] }, manual: [cls(390, 'COM3', 'CS2030 @ COM1')], places }, '/me/next'],
  // 2.1: outside your day, on campus and not at home: the way home, not a moon.
  'evening-home': [{ home: { stops: ['PGP'] }, dayStartMin: 600, dayEndMin: 1200, places }, `/me/next?${CLB}`],
  'rest': [{ home: { stops: ['PGP'] }, dayStartMin: 600, dayEndMin: 1200, manual: [cls(780, 'COM3', 'CS2030 @ COM1')], places }, '/me/next'],
  'home': [{ home: { stops: ['PGPR', 'PGP'] }, manual: [cls(420, 'COM3', 'CS2030 @ COM1')], places }, `/me/next?${DORM}`],
  // A class to go to, but no home stop and no location: nowhere to start from.
  'setup': [{ manual: [cls(600, 'UTOWN', 'GEA1000 @ UTown')], places }, '/me/next'],
  // A new account with nothing in it: no timetable yet, said plainly.
  'no-timetable': [{}, '/me/next'],
  // On the bus to a class: the ride, with its stops, in place of the journey.
  'riding': [{ home: { stops: ['PGP'] }, manual: [cls(600, 'UTOWN', 'GEA1000 @ UTown')], places }, '/me/next', { trips: true, before: (get) => get.post('/me/signal', { kind: 'boarded' }) }],
  // The feed answers with no buses at all: every time is a timetable estimate, marked "~".
  'scheduled': [{ home: { stops: ['PGP'] }, places }, '/me/next?place=mrt', { feed: {} }],
  'nearby-list': [{ home: { stops: ['PGP'] } }, `/me/nearby?${DORM}`],
  // The day the apps keep for when they're offline (see offline-day.json):
  // a class, a long gap home, a class, the way home.
  'day': [{ home: { stops: ['PGP'] }, manual: [cls(600, 'UTOWN', 'GEA1000 @ UTown'), cls(840, 'COM3', 'CS2030 @ COM1', 'COM1')], places }, '/me/day'],
  // At the PGP stop at 09:05, "On it" for the D2 due in a minute to a 09:15
  // class: its plate (SBS1234A) is picked from the feed at the tap, and the
  // feed's time for that bus at UTown (09:15) is the arrival, said as live.
  'riding-live': [soon, '/me/next', { trips: true, at: sgtAt(THU_DATE, '09:05'), feed: TAP_FEED, before: (get) => get.post('/me/signal', { kind: 'boarded', ...PGP_STOP }) }],
  // Ten minutes after it got there, and the feed no longer lists it:
  // you're taken to be in the class.
  'riding-there': [soon, '/me/next', {
    trips: true,
    at: sgtAt(THU_DATE, '09:05'),
    feed: TAP_FEED,
    before: async (get) => {
      await get.post('/me/signal', { kind: 'boarded', ...PGP_STOP });
      get.at(sgtAt(THU_DATE, '09:15') + RIDE_GRACE_MS + MIN);
      get.upstream({ byStop: FEED });
    },
  }],
  // At 09:38 the 10:00 class's trip is due, and its plan, the R2 at 09:44,
  // is kept. At 09:45, "Missed it": the card names the 09:44 and gives the
  // next way there.
  'missed': [{ home: { stops: ['PGP'] }, manual: [cls(600, 'UTOWN', 'GEA1000 @ UTown')], places }, '/me/next', {
    trips: true,
    at: sgtAt(THU_DATE, '09:38'),
    before: async (get) => {
      await get('/me/next');
      get.at(sgtAt(THU_DATE, '09:45'));
      await get.post('/me/signal', { kind: 'missed' });
    },
  }],
  // The phone planned the 09:06 D2 from home; nobody said anything, and three
  // minutes after it left the Mac (no location) takes you to be on it.
  'assumed-riding': [soon, '/me/next', {
    trips: true,
    feed: PLATE_FEED,
    before: async (get) => {
      await get(`/me/next?${DORM}`);
      get.at(sgtAt(THU_DATE, '09:06') + ASSUME_MS + MIN);
    },
  }],
  // The same plan, a minute later, and the feed now says that D2 is 2 min
  // late: the widget keeps the phone's bus for the trip, not a bus of its own,
  // its times from the plan, so not live.
  'plan-kept': [soon, '/me/next', {
    trips: true,
    feed: PLATE_FEED,
    before: async (get) => {
      await get(`/me/next?${DORM}`);
      get.advance(MIN);
      get.upstream({ byStop: { PGP: [{ name: 'D2', arrivalTime: '7', nextArrivalTime: '17' }] } });
    },
  }],
  // "Not going" to the 10:00 class: nothing left today, and an Undo.
  'skipped-undo': [{ home: { stops: ['PGP'] }, manual: [cls(600, 'UTOWN', 'GEA1000 @ UTown'), { ...cls(600, 'COM3', 'CS2030 @ COM1'), day: 5 }], places }, '/me/next', { trips: true, before: (get) => get.post('/me/signal', { kind: 'skipped' }) }],
  // "Not on campus today": said, with the way back.
  'away': [{ home: { stops: ['PGP'] }, manual: [cls(600, 'UTOWN', 'GEA1000 @ UTown'), { ...cls(600, 'COM3', 'CS2030 @ COM1'), day: 5 }], places }, '/me/next', { trips: true, before: (get) => get.post('/me/signal', { kind: 'away' }) }],
  // At PGP for UTown: the walk is 1714 s, the D2 1834 s (21:04 away, 9:30
  // on board). Walking must beat a live bus by WALK.beatsBusByS (120 s), and
  // level isn't beating it: the bus heads the card, the walk said as close.
  'walk-level': [{ places }, `/me/next?to=UTOWN&${AT_PGP}`, { feed: { PGP: [{ name: 'D2', _etas: [{ eta_s: 1264 }] }] } }],
  // Standing at KR MRT for COM 3: the buses on this side go the long way
  // round, so the answer is the D2 from across the road, and it says so.
  // Each stop lists only the buses calling there.
  'cross-road': [{ home: { stops: ['UTOWN'] }, places }, `/me/next?to=COM3&${AT_KR_MRT}`, {
    feed: {
      'KR-MRT': [{ name: 'D2', arrivalTime: '2', nextArrivalTime: '12' }, { name: 'A1', arrivalTime: '3', nextArrivalTime: '13' }, { name: 'K', arrivalTime: '5', nextArrivalTime: '20' }],
      'KR-MRT-OPP': [{ name: 'D2', arrivalTime: '5', nextArrivalTime: '15' }, { name: 'A2', arrivalTime: '8', nextArrivalTime: '18' }, { name: 'K', arrivalTime: '7', nextArrivalTime: '22' }],
    },
  }],
  // At COM 3 the feed lists the D2 only as runs ending there (COM3-D2-E):
  // its time is shown, but which way it goes isn't known, and the card says so.
  'ambiguous-berth': [{ home: { stops: ['PGP'] }, places }, `/me/next?to=UTOWN&${AT_COM3}`, { feed: { COM3: [{ name: 'D2', busStopCode: 'COM3-D2-E', arrivalTime: '3', nextArrivalTime: '13' }] } }],
  // A destination that's no stop, room or place (a favourite since removed):
  // ignored, so the day's own answer, not a free day's "No more classes".
  'unknown-dest': [{ home: { stops: ['PGP'] }, manual: [cls(600, 'UTOWN', 'GEA1000 @ UTown')], places }, '/me/next?to=XYZ'],
  // The same, the A2 in 6 min and the 95 at 7:03: the 95's ride is 4 min
  // shorter, so with its fare (3 min) it's level with the A2, and level isn't
  // worth a fare: the free bus heads the card, the 95 is the other way.
  'public-level': [{ home: { stops: ['PGP'] }, places, publicBuses: true }, `/me/next?to=KR-MRT-OPP&${AT_IT}`, { ...LTA, feed: { IT: [{ name: 'A2', arrivalTime: '6', nextArrivalTime: '16' }] }, upstream: { publicStops: { 16189: [{ ServiceNo: '95', buses: [{ etaS: 6 * 60 + 63, dest: '16009' }] }] } } }],
  // At IT for College Green: only the 151 (its route 151/2) goes there, and
  // LTA has its time from the timetable (Monitored 0): an estimate, named 151.
  'public-timetabled': [{ home: { stops: ['PGP'] }, places, publicBuses: true }, `/me/next?to=CG&${AT_IT}`, { ...LTA, feed: {}, upstream: { publicStops: { 16189: [{ ServiceNo: '151', buses: [{ etaS: 240, dest: '64009', monitored: false }] }] } } }],

  // Public buses on, at IT for Opp KR MRT: the 95 in 2 min beats the A2 in
  // 15 by more than its fare is worth, so it heads the card, marked "($)".
  'public-wins': [{ home: { stops: ['PGP'] }, places, publicBuses: true }, `/me/next?to=KR-MRT-OPP&${AT_IT}`, { ...LTA, feed: { IT: [{ name: 'A2', arrivalTime: '15', nextArrivalTime: '25' }] }, upstream: { publicStops: { 16189: [{ ServiceNo: '95', buses: [{ etaS: 120, dest: '16009' }] }] } } }],

  // Monday 9 November 2026, Deepavali (observed): Sunday hours. At 08:30 the
  // D2 starts at 09:00 and R2 (which runs from 08:20 on a weekday) not at all,
  // so the 10:00 class's bus is the first D2.
  'holiday-class': [{ home: { stops: ['PGP'] }, manual: [{ ...cls(600, 'UTOWN', 'GEA1000 @ UTown'), day: 1 }], places }, '/me/next', { at: sgtAt('2026-11-09', '08:30'), feed: {} }],
  // The same holiday with an imported timetable: Monday's class doesn't run,
  // it says why, and Tuesday's is next.
  'holiday-nusmods': [nusmods(1, 2), '/me/next', { at: sgtAt('2026-11-09', '08:30'), feed: {} }],
  // An imported timetable on a Thursday in week 3: the class runs, ending about half an hour early.
  'nusmods-class': [nusmods(THU), '/me/next'],
  // Its Tuesday class off for the recess (22 Sep), reading week (17 Nov),
  // the exams (24 Nov) and the vacation (8 Dec), each said plainly.
  'nusmods-recess': [nusmods(2), '/me/next', { at: sgtAt('2026-09-22', '09:00') }],
  'nusmods-reading': [nusmods(2), '/me/next', { at: sgtAt('2026-11-17', '09:00') }],
  'nusmods-exams': [nusmods(2), '/me/next', { at: sgtAt('2026-11-24', '09:00') }],
  'nusmods-vacation': [nusmods(2), '/me/next', { at: sgtAt('2026-12-08', '09:00') }],
  // Friday 00:20 in Singapore is still Thursday in UTC: Friday's 10:00 class
  // is today's, not tomorrow's. No bus runs (nor does the feed list one).
  'sgt-midnight': [{ home: { stops: ['PGP'] }, manual: [{ ...cls(600, 'COM3', 'CS2030 @ COM1'), day: 5 }], places }, '/me/next', { at: sgtAt('2026-08-28', '00:20'), feed: {} }],
  // The same, with the class at 00:30: a 15-minute walk away, so late, and
  // the card says when you'll get there, not when you would have.
  'sgt-midnight-class': [{ home: { stops: ['PGP'] }, manual: [{ ...cls(30, 'COM3', 'CS2030 @ COM1'), day: 5 }], places }, '/me/next', { at: sgtAt('2026-08-28', '00:20'), feed: {} }],

  // Thursday 23:10, on campus at UTown, home at PGP: every service has
  // stopped (the feed lists nothing), so it's the walk home, said plainly.
  'after-last-bus': [{ home: { stops: ['PGP'] }, places }, `/me/next?${AT_UTOWN}`, { at: sgtAt(THU_DATE, '23:10'), feed: {} }],
  // Thursday 22:40, outside your day, at PGP with home at UTown: the D2
  // home, warned that it stops running at 23:00.
  'last-bus-warning': [{ home: { stops: ['UTOWN'] }, places }, `/me/next?${AT_PGP}`, { at: sgtAt(THU_DATE, '22:40'), feed: LATE_FEED }],
  // Thursday 06:30, a class at UTown at 08:00, the feed empty: the first D2
  // (07:15) is the way there, and the wait for it doesn't make walking win.
  'before-first-bus': [{ home: { stops: ['PGP'] }, manual: [cls(480, 'UTOWN', 'GEA1000 @ UTown')], places }, '/me/next', { at: sgtAt(THU_DATE, '06:30'), feed: {} }],

  // NUS's feed can't be reached and nothing is cached: no time is made up.
  // Every bus is 'unknown', worded "no live times", and its leg has none.
  'feed-down': [{ home: { stops: ['PGP'] }, manual: [cls(600, 'UTOWN', 'GEA1000 @ UTown')], places }, '/me/next', { upstream: { fail: true } }],
  // A good reading three minutes ago, then the feed fails: that reading,
  // counted down to now, said to be three minutes old, as of when it was read.
  'stale': [{ home: { stops: ['PGP'] }, places }, '/me/next?place=mrt', {
    at: FROZEN_NOW - 3 * MIN,
    before: async (get) => {
      await get('/me/next?place=mrt');
      get.advance(3 * MIN);
      get.upstream({ fail: true });
    },
  }],
};

// Each case again with the account set to Chinese (phase 10), in zh/: the
// same answers, every word the server writes in Chinese.
const RUNS = [
  ['', {}, DIR],
  ['zh ', { lang: 'zh' }, ZH_DIR],
];

for (const [name, [profile, path, opts = {}]] of Object.entries(CASES)) for (const [tag, extra, dir] of RUNS) {
  test(`golden: ${tag}${name}`, async () => {
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
    // Re-recording everything clears out what no case makes any more.
    if (UPDATE_ALL) for (const f of orphans) fs.unlinkSync(new URL(f, dir));
    else assert.deepEqual(orphans, [], `fixtures no case makes, in ${dir.pathname}: delete them, or UPDATE_GOLDEN=1 pnpm test`);
  }
});
