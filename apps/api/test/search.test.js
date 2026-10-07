import test from 'node:test';
import assert from 'node:assert/strict';

// The account page's search ranking; the Android and Mac apps copy its rules.
import { rank, score } from '../../web/public/account/search.js';

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
  const withServices = [...D, { code: 'AS5', label: 'AS 5', stopCode: 'AS5', kind: 'stop' }, { code: 'A1', label: 'A1', kind: 'service', detail: 'Loop from KRB' }, { code: 'A2', label: 'A2', kind: 'service', detail: 'Loop from KRB' }];
  assert.deepEqual(rank(withServices, 'a').map((d) => d.code).slice(0, 3), ['A1', 'A2', 'AS5']);
  assert.equal(rank(withServices, 'a2')[0].code, 'A2');
});

test('the Buses tab: stops by their long names, found by those, their short names and codes', () => {
  // As app/buses.js lists them: the long name as the label, the short name as an alias.
  const stops = [
    { code: 'CLB', label: 'Central Library', stopCode: 'CLB', kind: 'stop', aliases: ['clb'] },
    { code: 'YIH', label: 'Yusof Ishak House', stopCode: 'YIH', kind: 'stop', aliases: ['yih'] },
    { code: 'YIH-OPP', label: 'Opp Yusof Ishak House', stopCode: 'YIH-OPP', kind: 'stop', aliases: ['opp yih'] },
  ];
  assert.deepEqual(rank(stops, 'library').map((d) => d.code), ['CLB']);
  assert.deepEqual(rank(stops, 'yih').map((d) => d.code), ['YIH', 'YIH-OPP']);
  assert.deepEqual(rank(stops, 'yusof').map((d) => d.code), ['YIH', 'YIH-OPP']);
});
