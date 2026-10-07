import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_PROFILE, GAP_RETURN_MIN, MAX_VENUE_WALK_S, isResting, nextClass, parseProfile, planFor, restDetail, restLabel, timingFor, upcomingClass } from '../src/profile.ts';
import { withLang } from '../src/i18n.ts';

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
    [{ home: 'PGP' }, /home must be/],
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

test('pinnedStops: known stops in the user’s order, repeats dropped, at most 8', () => {
  // A pin may also name a public stop of its own (LTA's code), which isn't a shuttle stop.
  const pinnable = (c) => isStop(c) || c === '16009';
  const r = parseProfile({ pinnedStops: ['utown', 'PGP', '16009', 'UTOWN'] }, isStop, isStop, pinnable);
  assert.ok(r.ok);
  assert.deepEqual(r.profile.pinnedStops, ['UTOWN', 'PGP', '16009']);
  assert.deepEqual(parseProfile({}, isStop).profile.pinnedStops, [], 'none until pinned');
  for (const bad of [['NOPE'], 'PGP', [1], null]) {
    const b = parseProfile({ pinnedStops: bad }, isStop, isStop, pinnable);
    assert.equal(b.ok, false, JSON.stringify(bad));
    assert.equal(b.error, 'pinnedStops must be up to 8 known stop codes');
  }
  // Nine pins of which one repeats are eight.
  const nine = ['PGP', 'COM3', 'UTOWN', 'KR-MRT', 'LT27', '16009', 'PGP', 'COM3', 'UTOWN'];
  assert.ok(parseProfile({ pinnedStops: nine }, isStop, isStop, pinnable).ok);
  const tooMany = parseProfile({ pinnedStops: Array.from({ length: 9 }, (_, i) => `S${i}`) }, isStop, isStop, () => true);
  assert.equal(tooMany.ok, false, 'nine different stops are too many');
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

test("the next class's card: when, what, and where to get off", () => {
  const name = (code) => ({ COM3: 'COM 3', UTOWN: 'UTown' })[code] ?? code;
  // Its room isn't at the stop: both, so you know where to get off.
  const tt = [cls(10, 12, 'COM3', 'CS2030 @ COM1'), { ...cls(9, 10, 'UTOWN', 'GEA1000 @ UTown'), day: 5, venue: 'UT-AUD1' }];
  assert.deepEqual(upcomingClass(profile(tt), thu(20), false, name), { when: 'Tomorrow · Fri', title: 'GEA1000 at 09:00', where: 'At UT-AUD1 · get off at UTown', off: null });
  // Later today, at its stop, in the 12-hour style.
  const today = upcomingClass(profile(tt), thu(5), true, name);
  // (The 12-hour clock has a narrow space before AM.)
  assert.deepEqual({ ...today, title: today.title.replace(/\s/g, ' ') }, { when: 'Today', title: 'CS2030 at 10:00 AM', where: 'At COM 3', off: null });
  assert.equal(upcomingClass(profile(tt), thu(20), false, name, new Set()).when, 'Tomorrow · Fri');
  assert.equal(withLang('zh', () => upcomingClass(profile(tt), thu(20), false, name).where), '在 UT-AUD1 · 在 UTown 下车');
  // Nothing coming: no card.
  assert.equal(upcomingClass(profile([]), thu(20), false, name), null);
});

test('day hours must be ordered', () => {
  const r = parseProfile({ dayStartMin: 1200, dayEndMin: 600 }, isStop);
  assert.equal(r.ok, false);
  assert.match(r.error, /start before it ends/);
});

test('timing: on time, tight and late against the class start', () => {
  const c = cls(10, 12, 'COM3', 'CS2030 @ COM1');
  const now = thu(9, 30);
  const arrive = (h, m) => new Date(thu(h, m)).toISOString();
  // Stop at 09:50 + 2 min walk = 09:52: 8 min early.
  assert.deepEqual(
    [timingFor(arrive(9, 50), c, 120, now).status, timingFor(arrive(9, 50), c, 120, now).text],
    ['on-time', 'Arrive 09:52 · 8 min early'],
  );
  assert.equal(timingFor(arrive(9, 57), c, 60, now).status, 'tight');
  // Tight is the colour; the words count the minutes, same as the class card.
  assert.equal(timingFor(arrive(9, 57), c, 60, now).text, 'Arrive 09:58 · 2 min early');
  assert.equal(timingFor(arrive(9, 59), c, 60, now).text, 'Arrive 10:00 · just in time');
  assert.equal(timingFor(arrive(9, 57), c, 60, now, true).text, 'Arrive 9:58\u00a0AM · 2 min early');
  assert.deepEqual([timingFor(arrive(10, 3), c, 120, now).status, timingFor(arrive(10, 3), c, 120, now).text], ['late', '~5 min late']);
  assert.equal(timingFor(null, c, 0, now), null, 'no arrival time, no claim');
});

test('rest label: early morning says when the day starts, not "Done for today"', () => {
  const tt = [{ day: 4, arriveByMin: 600, to: 'COM3', label: 'CS2030 @ COM1', venue: '' }];
  assert.equal(restLabel(profile(tt), thu(5)), 'Day starts 06:00');
  assert.equal(restLabel(profile(tt), thu(20)), 'Done for today');
});

test('timing: an absurd walk from the stop to the venue gives no lateness figure', () => {
  const trip = { day: 4, arriveByMin: 600, to: 'COM3', label: 'x', venue: '' };
  assert.equal(timingFor('2026-08-27T01:50:00Z', trip, MAX_VENUE_WALK_S + 1, thu(9, 30)), null);
  assert.ok(timingFor('2026-08-27T01:50:00Z', trip, 120, thu(9, 30)));
});

test('clock times go out without milliseconds', () => {
  const trip = { day: 4, arriveByMin: 600, to: 'COM3', label: 'x', venue: '' };
  assert.doesNotMatch(timingFor('2026-08-27T01:50:00Z', trip, 0, thu(9, 30)).classAt, /\.\d{3}Z$/);
});

test('between classes the plan names the room you leave from; from home it does not', () => {
  const tt = [
    { ...cls(10, 12, 'COM3'), venue: 'COM1-0212' },
    { ...cls(13, 14, 'LT27'), venue: 'LT27' },
  ];
  assert.equal(planFor(profile(tt), thu(12, 10)).fromVenue, 'COM1-0212');
  assert.equal(planFor(profile(tt), thu(8)).fromVenue, null);
  // After the last class, the trip home starts from that room too.
  assert.equal(planFor(profile(tt), thu(14, 30)).fromVenue, 'LT27');
});

test('clock and card text: campus time in the client\'s 12- or 24-hour style', async () => {
  const { clockMin, slackText } = await import('../src/clock.ts');
  assert.deepEqual([clockMin(0), clockMin(0, true), clockMin(754, true), clockMin(1110, true), clockMin(1110)], ['00:00', '12:00\u00a0AM', '12:34\u00a0PM', '6:30\u00a0PM', '18:30']);
  assert.deepEqual([slackText(260), slackText(20), slackText(-200)], ['4 min early', 'just in time', '~3 min late']);
});
