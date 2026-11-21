import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { busesTabIndex, grouped, rank, results, samePlace, score } from '../public/account/search.js';

const FIXTURE = JSON.parse(fs.readFileSync(new URL('../../../fixtures/search.json', import.meta.url), 'utf8'));
const ids = (list) => list.map((d) => `${d.kind}:${d.code}`);

const D = [
  { code: 'COM3', label: 'COM 3', stopCode: 'COM3', kind: 'stop', aliases: ['soc', 'computing'] },
  { code: 'COM1', label: 'School of Computing (COM1)', stopCode: 'COM3', kind: 'building', walkM: 224, aliases: ['soc', 'computing'] },
  { code: 'AS1', label: 'Faculty of Arts & Social Sciences (AS1)', stopCode: 'CLB', kind: 'building', walkM: 120, aliases: ['fass'] },
  { code: 'COM1-0203', label: 'Seminar Room 6', stopCode: 'COM3', kind: 'room', walkM: 210 },
  { code: 'LT27', label: 'Lecture Theatre 27', stopCode: 'LT27', kind: 'building', walkM: 40 },
];

test('a nickname beats a word that merely starts the same way', () => {
  const r = rank(D, 'soc').map((d) => d.code);
  assert.deepEqual(r.slice(0, 2), ['COM3', 'COM1']);
  assert.ok(r.indexOf('AS1') > 1, 'Social Sciences comes after Computing');
});

test('room codes match with a space or no dash; one letter never lists rooms', () => {
  assert.equal(rank(D, 'com1 02')[0].code, 'COM1-0203');
  assert.equal(rank(D, 'com10203')[0].code, 'COM1-0203');
  assert.ok(!rank(D, 'c').some((d) => d.kind === 'room'));
});

test('score ladder: exact, starts with, word, contains', () => {
  assert.equal(score(D[4], 'lt27'), 0);
  assert.equal(score(D[4], 'lectu'), 1);
  assert.equal(score(D[4], 'theatre'), 2);
  assert.equal(score(D[4], 'eatr'), 3);
  assert.equal(score(D[4], 'zzz'), -1);
});

test('the Buses tab: a service before a stop that matches as well', () => {
  const withServices = [
    ...D,
    { code: 'AS5', label: 'AS 5', stopCode: 'AS5', kind: 'stop' },
    { code: 'A1', label: 'A1', kind: 'service', detail: 'Loop from KRB' },
    { code: 'A2', label: 'A2', kind: 'service', detail: 'Loop from KRB' },
  ];
  assert.deepEqual(
    rank(withServices, 'a')
      .map((d) => d.code)
      .slice(0, 3),
    ['A1', 'A2', 'AS5'],
  );
  assert.equal(rank(withServices, 'a2')[0].code, 'A2');
});

test('the Buses tab: stops by their long names, found by those, their short names and codes', () => {
  const stops = [
    { code: 'CLB', label: 'Central Library', stopCode: 'CLB', kind: 'stop', aliases: ['clb'] },
    { code: 'YIH', label: 'Yusof Ishak House', stopCode: 'YIH', kind: 'stop', aliases: ['yih'] },
    { code: 'YIH-OPP', label: 'Opp Yusof Ishak House', stopCode: 'YIH-OPP', kind: 'stop', aliases: ['opp yih'] },
  ];
  assert.deepEqual(
    rank(stops, 'library').map((d) => d.code),
    ['CLB'],
  );
  assert.deepEqual(
    rank(stops, 'yih').map((d) => d.code),
    ['YIH', 'YIH-OPP'],
  );
  assert.deepEqual(
    rank(stops, 'yusof').map((d) => d.code),
    ['YIH', 'YIH-OPP'],
  );
});

test('the box lists each kind once: groups in the order of their best result, rank order inside', () => {
  const index = [
    { code: 'COM3', label: 'COM 3', stopCode: 'COM3', kind: 'stop' },
    { code: 'COM1', label: 'COM1', stopCode: 'COM3', kind: 'building' },
    { code: 'OPP-COM', label: 'Opp COM', stopCode: 'OPP-COM', kind: 'stop' },
    { code: 'COM2', label: 'Computing 2', stopCode: 'COM3', kind: 'building' },
  ];
  const ranked = rank(index, 'com');
  assert.deepEqual(ids(ranked), ['stop:COM3', 'building:COM1', 'building:COM2', 'stop:OPP-COM']);
  assert.deepEqual(ids(grouped(ranked)), ['stop:COM3', 'stop:OPP-COM', 'building:COM1', 'building:COM2']);
  const mixed = [
    { kind: 'building', code: 'A' },
    { kind: 'stop', code: 'B' },
    { kind: 'shop', code: 'C' },
    { kind: 'building', code: 'D' },
    { kind: 'cafe', code: 'E' },
    { kind: 'toString', code: 'F' },
  ];
  assert.deepEqual(ids(grouped(mixed)), ['building:A', 'building:D', 'stop:B', 'shop:C', 'cafe:E', 'toString:F']);
  const pinned = [{ code: 'T1', label: 'COM2 (CS2030)', stopCode: 'COM3', kind: 'timetable' }];
  const got = ids(grouped(results('com', { source: () => index, suggestions: () => [], pinned: () => pinned })));
  assert.deepEqual(got, ['timetable:T1', 'stop:COM3', 'stop:OPP-COM', 'building:COM1', 'building:COM2']);
});

test('a pinned timetable row hides only the stop or food court it is, not a building with the same code', () => {
  const index = [
    { code: 'COM3', label: 'COM3', stopCode: 'COM3', kind: 'stop' },
    { code: 'COM3', label: 'COM3', stopCode: 'COM3', kind: 'building' },
    { code: 'TECHNO', label: 'Techno Edge', stops: ['COM3'], kind: 'landmark' },
  ];
  const row = { code: 'COM3', label: 'COM3', stopCode: 'COM3', kind: 'timetable', detail: 'CS2030' };
  const got = ids(results('com3', { source: () => index, suggestions: () => [], pinned: () => [row] }));
  assert.deepEqual(got, ['timetable:COM3', 'building:COM3']);
  const food = { code: 'TECHNO', label: 'Techno Edge', stopCode: 'TECHNO', kind: 'timetable' };
  assert.deepEqual(ids(results('techno', { source: () => index, suggestions: () => [], pinned: () => [food] })), ['timetable:TECHNO']);
  assert.ok(samePlace({ kind: 'stop', code: 'COM3' }, { kind: 'stop', code: 'COM3' }));
  assert.ok(!samePlace({ kind: 'stop', code: 'COM3' }, { kind: 'building', code: 'COM3' }));
  assert.ok(!samePlace({ kind: 'timetable', code: 'COM3' }, { kind: 'room', code: 'COM3' }));
});

test('fixtures/search.json: destinations, ranked as the fixture says', () => {
  const { index, queries, limit } = FIXTURE.destinations;
  assert.ok(queries.length > 20);
  for (const { q, expect } of queries) {
    const got = ids(rank(index, q));
    assert.ok(got.length <= limit, `"${q}": at most ${limit}`);
    assert.deepEqual(got, expect, `"${q}"`);
  }
});

test('fixtures/search.json: the Buses tab, its index from /campus and its results', () => {
  const { campus, index, queries, limit } = FIXTURE.busesTab;
  const built = busesTabIndex(campus);
  assert.deepEqual(ids(built), index);
  const services = built.filter((d) => d.kind === 'service');
  assert.ok(queries.some(({ q }) => !q.trim()));
  assert.ok(queries.some(({ expect }) => expect.length === limit));
  for (const { q, expect } of queries) {
    const got = ids(results(q, { source: () => built, suggestions: () => services }));
    if (q.trim()) assert.ok(got.length <= limit, `"${q}": at most ${limit}`);
    else assert.deepEqual(got, ids(services), `"${q}": every service`);
    assert.deepEqual(got, expect, `"${q}"`);
  }
});

test('the Buses tab index: services name where they run, stops keep their short name as an alias', () => {
  const built = busesTabIndex(FIXTURE.busesTab.campus);
  const k = built.find((d) => d.code === 'K');
  assert.equal(k.detail, "Prince George's Park to Kent Vale");
  assert.equal(built.find((d) => d.code === 'A1').detail, 'Loop from Kent Ridge Bus Terminal');
  assert.deepEqual(built.find((d) => d.kind === 'stop' && d.code === 'CLB').aliases, ['clb', 'library', 'central library', 'clb']);
  assert.deepEqual(busesTabIndex(null), []);
});

test('the fixture covers what the other apps need to get right', () => {
  const { index, queries } = FIXTURE.destinations;
  const kinds = new Set(index.map((d) => d.kind));
  for (const k of ['stop', 'landmark', 'building', 'room']) assert.ok(kinds.has(k), k);
  assert.ok(
    [...kinds].some((k) => !['timetable', 'place', 'class', 'service', 'stop', 'landmark', 'building', 'room'].includes(k)),
    'an unknown kind',
  );
  assert.ok(index.some((d) => d.code.includes('_')) && index.some((d) => d.code.includes('-')) && index.some((d) => / {2}/.test(d.label)));
  for (const q of [...queries, ...FIXTURE.busesTab.queries]) assert.ok(q.why, `"${q.q}" says why`);
});
