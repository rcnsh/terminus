import test from 'node:test';
import assert from 'node:assert/strict';

import { footM, paceSpeed, stopFootM } from '../src/walk.ts';
import { haversineM } from '../src/resolve.ts';
import { DEFAULT_PROFILE, parseProfile } from '../src/profile.ts';
import walks from '../data/walks.json' with { type: 'json' };
import graph from '../data/stops.json' with { type: 'json' };

const stop = (code) => graph.stops.find((s) => s.code === code);

test('pace: normal is the old 1.3 m/s; slow and fast either side', () => {
  assert.equal(paceSpeed('normal'), 1.3);
  assert.equal(paceSpeed(undefined), 1.3);
  assert.ok(paceSpeed('slow') < 1.3 && paceSpeed('fast') > 1.3);
});

test('a walk to a stop is never shorter than the straight line', () => {
  const s = stop('COM3');
  const straight = haversineM(1.2950, 103.7740, s.lat, s.lon);
  const walked = footM(1.2950, 103.7740, s);
  assert.ok(walked >= straight);
  assert.equal(walked, straight * (walks.detour.COM3 ?? 1));
});

test('stop to stop uses the routed distance when there is one', () => {
  const [a, b] = [stop('PGP'), stop('KR-MRT')];
  const routed = walks.stopPairs['PGP>KR-MRT'];
  assert.ok(routed, 'PGP to KR MRT is routed');
  assert.equal(stopFootM(a, b), routed);
  assert.ok(routed >= haversineM(a.lat, a.lon, b.lat, b.lon));
});

test('profile: walkPace, fullBusMargin and seen', () => {
  const ok = () => true;
  const d = parseProfile({}, ok).profile;
  assert.deepEqual([d.walkPace, d.fullBusMargin, d.seen], ['normal', true, []]);
  assert.equal(DEFAULT_PROFILE.walkPace, 'normal');
  const p = parseProfile({ walkPace: 'fast', fullBusMargin: false, seen: ['onboarding', 'pace', 'pace'] }, ok).profile;
  assert.deepEqual([p.walkPace, p.fullBusMargin, p.seen], ['fast', false, ['onboarding', 'pace']]);
  for (const bad of [{ walkPace: 'jog' }, { fullBusMargin: 'yes' }, { seen: 'pace' }, { seen: ['Not OK'] }]) {
    assert.equal(parseProfile(bad, ok).ok, false, JSON.stringify(bad));
  }
});
