import test from 'node:test';
import assert from 'node:assert/strict';
import {
  acadYear,
  decodeTimetable,
  encodeTimetable,
  nextTrip,
  parseShareUrl,
  resolveTrips,
  venueToStop,
} from '../src/nusmods.ts';

const SHARE =
  'https://nusmods.com/timetable/sem-1/share?EC1101E=TUT:W11,LEC:2&MA1100=LEC:1&hidden=PC1101';

test('parseShareUrl expands short lesson codes and skips view state', () => {
  const s = parseShareUrl(SHARE);
  assert.equal(s.semester, 1);
  // hidden= is not a module.
  assert.deepEqual(
    s.selections.map((x) => `${x.module}/${x.lessonType}/${x.classNo}`).sort(),
    ['EC1101E/Lecture/2', 'EC1101E/Tutorial/W11', 'MA1100/Lecture/1'],
  );
});

test('acadYear rolls at August (sem 1 starts then)', () => {
  assert.equal(acadYear(Date.UTC(2026, 7, 28), 1), '2026-2027', 'late August is a new AY');
  assert.equal(acadYear(Date.UTC(2026, 2, 1), 2), '2025-2026', 'March belongs to the AY that began last August');
});

test('venueToStop resolves full code then building prefix', () => {
  // LT27 is itself a stop; a room in it must still resolve.
  assert.equal(venueToStop('LT27')?.stop, 'LT27');
  assert.equal(venueToStop('LT27-01-01')?.stop, 'LT27', 'falls back to the building');
  assert.equal(venueToStop('COM3')?.stop, 'COM3');
  assert.equal(venueToStop('definitely-not-a-venue'), null);
});

// Stubbed NUSMods API: no network, per the project's no-credentials rule.
function stubFetch(modules) {
  return async (u) => {
    const m = /modules\/([^.]+)\.json/.exec(String(u));
    const mod = m && modules[m[1]];
    if (!mod) return new Response('not found', { status: 404 });
    return Response.json(mod);
  };
}

const MODULES = {
  EC1101E: {
    semesterData: [
      {
        semester: 1,
        timetable: [
          { lessonType: 'Lecture', classNo: '2', day: 'Tuesday', startTime: '1600', endTime: '1800', venue: 'LT27' },
          { lessonType: 'Tutorial', classNo: 'W11', day: 'Wednesday', startTime: '1300', endTime: '1400', venue: 'COM3-0120' },
          // a class the user did NOT select -- must be ignored
          { lessonType: 'Lecture', classNo: '1', day: 'Monday', startTime: '0900', endTime: '1100', venue: 'LT27' },
        ],
      },
    ],
  },
  MA1100: {
    semesterData: [
      { semester: 1, timetable: [{ lessonType: 'Lecture', classNo: '1', day: 'Monday', startTime: '0800', endTime: '1000', venue: 'UTOWN' }] },
    ],
  },
};

test('resolveTrips turns selections into destination trips, ignoring unselected classes', async () => {
  const share = parseShareUrl(SHARE);
  const { trips, unresolved } = await resolveTrips(share, Date.UTC(2026, 7, 28), stubFetch(MODULES));
  assert.equal(unresolved.length, 0);

  // 3 selections -> 3 trips (LEC:2, TUT:W11, MA1100 LEC:1). The unselected
  // EC1101E LEC:1 on Monday must not appear.
  assert.equal(trips.length, 3);
  assert.ok(!trips.some((t) => t.day === 1 && t.arriveByMin === 540), 'unselected 09:00 Mon class leaked in');

  const tue = trips.find((t) => t.day === 2);
  assert.equal(tue.arriveByMin, 16 * 60);
  assert.equal(tue.to, 'LT27');
  assert.match(tue.label, /EC1101E/);
});

test('a stale share link (class no longer offered) is skipped, not fatal', async () => {
  const share = parseShareUrl('https://nusmods.com/timetable/sem-1/share?MA1100=TUT:GONE');
  const { trips } = await resolveTrips(share, Date.UTC(2026, 7, 28), stubFetch(MODULES));
  assert.equal(trips.length, 0, 'no crash, just nothing resolved');
});

test('encode/decode is a faithful, URL-safe roundtrip', () => {
  const tt = {
    home: 'PGP',
    trips: [
      { day: 1, arriveByMin: 480, to: 'UTOWN', label: 'MA1100 @ UTOWN', venue: '' },
      { day: 2, arriveByMin: 960, to: 'LT27', label: 'EC1101E @ LT27', venue: '' },
    ],
  };
  const enc = encodeTimetable(tt);
  assert.ok(!/[+/=]/.test(enc), 'base64url only');
  const back = decodeTimetable(enc);
  assert.equal(back.home, 'PGP');
  assert.deepEqual(
    back.trips.map((t) => [t.day, t.arriveByMin, t.to]),
    [[1, 480, 'UTOWN'], [2, 960, 'LT27']],
  );
  assert.equal(decodeTimetable('!!!not base64!!!'), null);
});

test('nextTrip finds the next class ahead today, else the next scheduled day', () => {
  const tt = {
    home: 'PGP',
    trips: [
      { day: 2, arriveByMin: 600, to: 'UTOWN', label: 'a', venue: '' }, // Tue 10:00
      { day: 2, arriveByMin: 960, to: 'LT27', label: 'b', venue: '' }, // Tue 16:00
      { day: 4, arriveByMin: 540, to: 'BIZ2', label: 'c', venue: '' }, // Thu 09:00
    ],
  };
  const tueMorning = Date.UTC(2026, 7, 25, 1, 0); // Tue 09:00 SGT
  assert.equal(nextTrip(tt, tueMorning).to, 'UTOWN', 'the 10:00, not the 16:00');

  const tueLate = Date.UTC(2026, 7, 25, 9, 0); // Tue 17:00 SGT -- both today's passed
  assert.equal(nextTrip(tt, tueLate).to, 'BIZ2', 'rolls to Thursday');

  assert.equal(nextTrip({ home: null, trips: [] }, tueMorning), null);
});
