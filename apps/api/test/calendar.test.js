import test from 'node:test';
import assert from 'node:assert/strict';

import { BUNDLED, calendarThrough, importedClassRuns, sgtDate, termDay, termsForImport } from '../src/calendar.ts';
import { DEFAULT_PROFILE, classesOn, needsReimport, nextClass, reimportReason, restDetail } from '../src/profile.ts';

// Fixed calendar, so these tests don't move when data/calendar.json refreshes.
const CAL = {
  semesters: [
    { acadYear: '2026/2027', semester: 1, start: '2026-08-10' },
    { acadYear: '2026/2027', semester: 2, start: '2027-01-11' },
  ],
  holidays: [
    { date: '2026-08-10', name: 'National Day (Observed)' },
    { date: '2026-11-09', name: 'Deepavali (Observed)' },
  ],
};

/** 10:00 SGT on a YYYY-MM-DD date. */
const at = (date) => Date.parse(`${date}T02:00:00Z`);
const SEM1 = { acadYear: '2026/2027', semester: 1 };

test('sgtDate crosses midnight in Singapore, not UTC', () => {
  assert.equal(sgtDate(Date.parse('2026-08-10T16:30:00Z')), '2026-08-11');
});

test('week structure: 6 teaching weeks, recess, 7 more, reading, 2 exam weeks', () => {
  const cases = [
    ['2026-08-11', 'instructional', 1],
    ['2026-09-18', 'instructional', 6],
    ['2026-09-21', 'recess', null],
    ['2026-09-28', 'instructional', 7],
    ['2026-11-13', 'instructional', 13],
    ['2026-11-16', 'reading', null],
    ['2026-11-23', 'exam', null],
    ['2026-12-04', 'exam', null],
    ['2026-12-07', 'vacation', null],
    ['2027-01-11', 'instructional', 1],
  ];
  for (const [date, kind, week] of cases) {
    const d = termDay(at(date), CAL);
    assert.equal(d.kind, kind, date);
    assert.equal(d.week, week, date);
  }
  assert.equal(termDay(at('2027-01-11'), CAL).semester, 2);
});

test('public holidays are flagged', () => {
  assert.equal(termDay(at('2026-08-10'), CAL).holiday, 'National Day (Observed)');
  assert.equal(termDay(at('2026-08-11'), CAL).holiday, null);
});

test('a week 3-13 lab does not run in weeks 1-2, recess or exams', () => {
  const weeks = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13];
  assert.equal(importedClassRuns(weeks, SEM1, at('2026-08-14'), CAL), false, 'week 1');
  assert.equal(importedClassRuns(weeks, SEM1, at('2026-08-28'), CAL), true, 'week 3');
  assert.equal(importedClassRuns(weeks, SEM1, at('2026-09-25'), CAL), false, 'recess');
  assert.equal(importedClassRuns(weeks, SEM1, at('2026-11-27'), CAL), false, 'exams');
});

test('no class on a public holiday, even in a teaching week', () => {
  assert.equal(importedClassRuns([13], SEM1, at('2026-11-09'), CAL), false);
});

test('a semester 1 timetable does not run in semester 2', () => {
  assert.equal(importedClassRuns([1], SEM1, at('2027-01-12'), CAL), false);
  assert.equal(importedClassRuns([1], null, at('2027-01-12'), CAL), true, 'old imports without a term: any teaching week');
});

test('date-range lessons run on their own dates and interval', () => {
  const range = { start: '2026-08-11', end: '2026-09-08', weekInterval: 2 };
  assert.equal(importedClassRuns(range, SEM1, at('2026-08-11'), CAL), true);
  assert.equal(importedClassRuns(range, SEM1, at('2026-08-18'), CAL), false, 'off week');
  assert.equal(importedClassRuns(range, SEM1, at('2026-08-25'), CAL), true);
  assert.equal(importedClassRuns(range, SEM1, at('2026-09-15'), CAL), false, 'after the range');
});

// The profile helpers use the bundled calendar; AY2026/27 sem 1 starts 10 Aug.
const lab = (day) => ({ day, arriveByMin: 600, endMin: 720, to: 'COM3', label: 'CS2030 Lab', venue: '', weeks: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13] });
const gym = (day) => ({ day, arriveByMin: 1080, endMin: 1140, to: 'UHALL', label: 'Gym', venue: '' });

test('classesOn: imported classes follow the calendar, manual ones run every week', () => {
  const p = { ...structuredClone(DEFAULT_PROFILE), trips: [lab(5)], manual: [gym(5)], term: SEM1 };
  assert.deepEqual(classesOn(p, at('2026-08-14')).map((c) => c.label), ['Gym'], 'week 1 Friday: lab not yet');
  assert.deepEqual(classesOn(p, at('2026-08-28')).map((c) => c.label), ['CS2030 Lab', 'Gym'], 'week 3 Friday');
  assert.deepEqual(classesOn(p, at('2026-09-25')).map((c) => c.label), ['Gym'], 'recess Friday');
});

test('the rest message skips recess to the first real class', () => {
  const p = { ...structuredClone(DEFAULT_PROFILE), trips: [lab(1)], term: SEM1 };
  // Friday of recess week, evening.
  const n = nextClass(p, Date.parse('2026-09-25T12:00:00Z'));
  assert.equal(n.daysAhead, 3, 'Monday of week 7, not the recess Monday');
  assert.equal(restDetail(p, Date.parse('2026-09-18T12:00:00Z')), 'Next: CS2030 Lab, Mon 28 Sep 10:00');
});

test('a current timetable, or none, needs no re-import', () => {
  const p = { ...structuredClone(DEFAULT_PROFILE), trips: [lab(1)], term: SEM1 };
  const now = at('2026-09-01');
  assert.equal(needsReimport(p, now), false);
  assert.equal(needsReimport({ ...p, trips: [] }, now), false);
  assert.equal(needsReimport({ ...p, term: null }, now), false, 'no term to have ended');
});

test('a timetable whose semester has ended asks for this semester, and says so', () => {
  const p = { ...structuredClone(DEFAULT_PROFILE), trips: [lab(1)], term: SEM1 };
  const sem2Week1 = at('2027-01-11');
  assert.equal(reimportReason(p, at('2026-11-20')), null, 'still sem 1 (exams)');
  assert.equal(reimportReason(p, sem2Week1), 'ended');
  assert.match(restDetail(p, sem2Week1), /Sem 1 2026\/27/);
});

test('import picks the coming semester: a sem-1 link in July means August', () => {
  assert.deepEqual(termsForImport(1, at('2026-07-01'))[0], SEM1);
  assert.deepEqual(termsForImport(2, at('2026-12-20'))[0], { acadYear: '2026/2027', semester: 2 });
  assert.deepEqual(termsForImport(1, at('2026-10-01'))[0], SEM1, 'during sem 1, sem 1');
});

test('past the end of the calendar data, imported classes run every week (fail open)', () => {
  const far = at('2031-03-03'); // a Monday
  assert.equal(termDay(far).kind, 'unknown');
  assert.equal(importedClassRuns([3], { acadYear: '2030/2031', semester: 2 }, far), true, 'a term the data has never heard of');
  assert.equal(importedClassRuns([3], null, far), true, 'no term recorded');
  assert.ok(calendarThrough() > '2027-01-01');
});

test('past the end of the calendar data, a semester the data says has finished stays finished', () => {
  // The bundled calendar is good to late August 2027; a Monday after that.
  const after = at('2027-08-30');
  assert.equal(termDay(after, CAL).kind, 'unknown');
  assert.equal(importedClassRuns([3], { acadYear: '2026/2027', semester: 2 }, after, CAL), false, 'Sem 2 2026/27 ended in May');
  // A date-range lesson runs on its own dates, covered by the calendar or not.
  const range = { start: '2027-06-21', end: '2027-07-26' };
  assert.equal(importedClassRuns(range, null, after, CAL), false, 'after its last date');
  assert.equal(importedClassRuns({ start: '2027-08-30', end: '2027-09-27' }, null, after, CAL), true, 'on its first date');
});

test('a calendar without the next academic year stops before its first semester would start', () => {
  // Through Special Term II 2026/27 (ends 2 August 2027), but not semester 1 2027/28.
  const data = { semesters: [...CAL.semesters, { acadYear: '2026/2027', semester: 3, start: '2027-05-10' }, { acadYear: '2026/2027', semester: 4, start: '2027-06-21' }], holidays: [] };
  assert.equal(calendarThrough(data), '2027-08-08', 'not three weeks of grace into the new year');
  assert.equal(termDay(at('2027-08-04'), data).kind, 'vacation');
  assert.equal(termDay(at('2027-08-09'), data).kind, 'unknown', 'week 1 of the new year: classes run, not hidden as vacation');
  // A sem-1 link then is for the new year, with the old one to fall back on.
  assert.deepEqual(termsForImport(1, at('2027-08-12'), data), [{ acadYear: '2027/2028', semester: 1 }, SEM1]);
});

test('the real calendar covers the next 60 days, and warns from 120', (t) => {
  // Fails when data/calendar.json has not been refreshed: the moment to
  // redeploy. scrape.yml refreshes it weekly from NUSMods, so from 120 days
  // out the test output says so first, without failing the scrape.
  const now = Date.now();
  for (let d = 0; d <= 60; d += 5) assert.notEqual(termDay(now + d * 86_400_000).kind, 'unknown');
  const left = (Date.parse(`${calendarThrough(BUNDLED)}T00:00:00+08:00`) - now) / 86_400_000;
  if (left < 120) t.diagnostic(`warning: data/calendar.json runs out in ${Math.floor(left)} days (${calendarThrough(BUNDLED)}); has NUSMods published the next academic year?`);
});

test('the real calendar lists the semester after today’s', () => {
  // So the next semester's first day is never "unknown". With the real
  // clock: it fails once the last listed semester starts.
  const today = sgtDate(Date.now());
  const started = BUNDLED.semesters.filter((s) => s.start <= today);
  assert.ok(started.length > 0, `nothing in data/calendar.json has started by ${today}`);
  const next = BUNDLED.semesters.find((s) => s.start > today);
  const now = started.at(-1);
  assert.ok(next, `data/calendar.json ends with ${now.acadYear} semester ${now.semester}: refresh it (scripts/fetch_calendar.py)`);
});

test('the real calendar: semesters in order, none listed twice, each 1 to 4', () => {
  const seen = new Set();
  let was = '';
  for (const s of BUNDLED.semesters) {
    const key = `${s.acadYear} ${s.semester}`;
    assert.ok(!seen.has(key), `${key} is listed twice`);
    seen.add(key);
    assert.match(s.acadYear, /^(\d{4})\/(\d{4})$/);
    assert.equal(Number(s.acadYear.slice(5)), Number(s.acadYear.slice(0, 4)) + 1, s.acadYear);
    assert.ok([1, 2, 3, 4].includes(s.semester), key);
    assert.match(s.start, /^\d{4}-\d{2}-\d{2}$/, key);
    assert.ok(s.start > was, `${key} starts ${s.start}, not after the one before (${was})`);
    was = s.start;
  }
});

test('the rest message says why today is empty', () => {
  const p = { ...structuredClone(DEFAULT_PROFILE), trips: [lab(1)], term: SEM1 };
  // Recess Monday evening: next class is week 7.
  assert.match(restDetail(p, Date.parse('2026-09-21T12:00:00Z')), /^Recess week · Next: /);
});
