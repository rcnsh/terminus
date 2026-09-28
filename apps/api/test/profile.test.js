import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_PROFILE, GAP_RETURN_MIN, isResting, nextClass, parseProfile, planFor, restDetail } from '../src/profile.ts';

const STOPS = new Set(['PGP', 'COM3', 'UTOWN', 'KR-MRT', 'LT27']);
const isStop = (c) => STOPS.has(c);

// Thursday (day 4) at hh:mm SGT.
const thu = (h, m = 0) => Date.UTC(2026, 7, 27, h - 8, m);

function profile(trips, extra = {}) {
  return {
    ...structuredClone(DEFAULT_PROFILE),
    home: { lat: 1.2918, lon: 103.7804, stops: ['PGP'] },
    manual: trips,
    ...extra,
  };
}

const cls = (startH, endH, to, label = to) => ({ day: 4, arriveByMin: startH * 60, endMin: endH * 60, to, label, venue: '' });

test('before the first class: to it, from home', () => {
  const p = planFor(profile([cls(10, 12, 'COM3'), cls(13, 14, 'LT27')]), thu(8));
  assert.deepEqual([p.to, p.why, p.from], ['COM3', 'class', 'PGP']);
});

test('between close classes: to the next, from the last venue', () => {
  const p = planFor(profile([cls(10, 12, 'COM3'), cls(13, 14, 'LT27')]), thu(12, 10));
  assert.deepEqual([p.to, p.why, p.from], ['LT27', 'class', 'COM3']);
});

test('a class counts as next until it starts', () => {
  const p = planFor(profile([cls(10, 12, 'COM3')]), thu(9, 59));
  assert.equal(p.to, 'COM3');
});

test('a gap longer than gapHours sends you home, then back', () => {
  const tt = [cls(10, 12, 'COM3'), cls(16, 18, 'UTOWN')];
  const during = planFor(profile(tt), thu(12, 5));
  assert.deepEqual([during.to, during.why, during.from], ['PGP', 'gap-home', 'COM3']);

  const back = planFor(profile(tt), thu(16) - GAP_RETURN_MIN * 60_000);
  assert.deepEqual([back.to, back.why, back.from], ['UTOWN', 'class', 'PGP']);
});

test('a gap at or under gapHours does not', () => {
  const p = planFor(profile([cls(10, 12, 'COM3'), cls(14, 15, 'UTOWN')]), thu(12, 5));
  assert.equal(p.why, 'class');
  assert.equal(p.to, 'UTOWN');
});

test('gapHours is per user', () => {
  const tt = [cls(10, 12, 'COM3'), cls(15, 16, 'UTOWN')];
  assert.equal(planFor(profile(tt), thu(12, 5)).why, 'gap-home');
  assert.equal(planFor(profile(tt, { gapHours: 4 }), thu(12, 5)).why, 'class');
});

test('after the last class: home', () => {
  const p = planFor(profile([cls(10, 12, 'COM3')]), thu(12, 30));
  assert.deepEqual([p.to, p.why, p.from], ['PGP', 'home', 'COM3']);
});

test('no classes today: no plan', () => {
  const p = planFor(profile([{ ...cls(10, 12, 'COM3'), day: 1 }]), thu(9));
  assert.equal(p, null);
});

test('no home set: long gaps and evenings fall back rather than invent a home', () => {
  const tt = [cls(10, 12, 'COM3'), cls(16, 18, 'UTOWN')];
  assert.equal(planFor(profile(tt, { home: null }), thu(12, 5)).to, 'UTOWN');
  assert.equal(planFor(profile(tt, { home: null }), thu(19)), null);
});

test('imported and manual classes are merged', () => {
  const p = planFor({ ...profile([cls(13, 14, 'LT27')]), trips: [cls(10, 11, 'COM3')] }, thu(9));
  assert.equal(p.to, 'COM3');
});

test('parseProfile fills defaults and rejects bad input with a useful message', () => {
  const ok = parseProfile({}, isStop);
  assert.ok(ok.ok);
  assert.deepEqual(ok.profile, DEFAULT_PROFILE);

  const cases = [
    [{ gapHours: 0 }, /gapHours/],
    [{ home: { lat: 1.3 } }, /lat and lon/],
    [{ home: { lat: 1.3, lon: 103.7, stops: ['NOPE'] } }, /home.stops/],
    [{ manual: [{ day: 7, arriveByMin: 600, to: 'COM3', label: 'x' }] }, /manual\[0\]: day/],
    [{ manual: [{ day: 1, arriveByMin: 600, endMin: 500, to: 'COM3', label: 'x' }] }, /endMin/],
    [{ places: [{ key: 'Gym!', label: 'Gym', to: 'PGP' }] }, /key/],
    [{ places: [{ key: 'a', label: 'A', to: 'PGP' }, { key: 'a', label: 'B', to: 'PGP' }] }, /duplicate/],
  ];
  for (const [input, re] of cases) {
    const r = parseProfile(input, isStop);
    assert.equal(r.ok, false, JSON.stringify(input));
    assert.match(r.error, re);
  }
});

test('resting hours: outside 06:00-18:00 by default', () => {
  const p = profile([cls(10, 12, 'COM3')]);
  assert.equal(isResting(p, thu(5, 59)), true);
  assert.equal(isResting(p, thu(6)), false);
  assert.equal(isResting(p, thu(17, 59)), false);
  assert.equal(isResting(p, thu(18)), true);
  assert.equal(isResting(p, thu(23)), true);
});

test('an evening class keeps the day open until 45 min after it ends', () => {
  const p = profile([cls(18, 20, 'LT27')]);
  assert.equal(isResting(p, thu(20, 30)), false);
  assert.equal(isResting(p, thu(20, 45)), true);
});

test('an early class opens the day 90 min before it', () => {
  const p = profile([{ ...cls(7, 8, 'COM3') }], { dayStartMin: 7 * 60 });
  assert.equal(isResting(p, thu(5, 30)), false);
  assert.equal(isResting(p, thu(5, 29)), true);
});

test('custom day hours are honoured', () => {
  const p = profile([], { dayStartMin: 8 * 60, dayEndMin: 22 * 60 });
  assert.equal(isResting(p, thu(7)), true);
  assert.equal(isResting(p, thu(21)), false);
});

test('the rest message names the next class', () => {
  const tt = [cls(10, 12, 'COM3', 'CS2030 @ COM1'), { ...cls(9, 10, 'UTOWN', 'GEA1000 @ UTown'), day: 5 }];
  assert.equal(restDetail(profile(tt), thu(20)), 'Next: GEA1000 @ UTown, tomorrow 09:00');
  assert.equal(restDetail(profile(tt), thu(5)), 'Next: CS2030 @ COM1, today 10:00');
  const monOnly = [{ ...cls(10, 12, 'COM3', 'CS2030 @ COM1'), day: 1 }];
  assert.equal(restDetail(profile(monOnly), thu(20)), 'Next: CS2030 @ COM1, Monday 10:00');
  assert.equal(restDetail(profile([]), thu(20)), 'Nothing on your timetable');
  assert.equal(nextClass(profile([]), thu(20)), null);
});

test('day hours must be ordered', () => {
  const r = parseProfile({ dayStartMin: 1200, dayEndMin: 600 }, isStop);
  assert.equal(r.ok, false);
  assert.match(r.error, /start before it ends/);
});
