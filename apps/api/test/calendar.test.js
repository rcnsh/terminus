import test from 'node:test';
import assert from 'node:assert/strict';

import { importedClassRuns, sgtDate, termDay } from '../src/calendar.ts';
import { DEFAULT_PROFILE, classesOn, needsReimport, nextClass, restDetail } from '../src/profile.ts';

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

test('old imports without weeks ask for a re-import', () => {
  const p = { ...structuredClone(DEFAULT_PROFILE), trips: [{ ...lab(1), weeks: undefined }] };
  assert.equal(needsReimport(p), true);
  assert.equal(needsReimport({ ...p, trips: [lab(1)], term: SEM1 }), false);
  assert.equal(needsReimport({ ...p, trips: [] }), false);
});
