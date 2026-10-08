/**
 * The web card's journey (apps/web/public/account/journey.js): the only words
 * it works out itself are the countdowns, "Leave in 4 min" and the bus's "in
 * 4 min"; every other line is the server's, worded here only for an answer
 * from before the server sent them. Both must read as the Android app's card
 * styles do (JourneyText.kt), on every answer the apps share in
 * fixtures/answers, in English and Chinese.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { useLang, web } from './_web.mjs';

const J = await web('account/journey.js');
const { setClockPref, t } = await web('account/dom.js');
// The fixtures' times are in the 24-hour clock.
setClockPref('24');

const ANSWERS = new URL('./fixtures/answers/', import.meta.url);
/** Every shared answer with a journey, in each language: [lang, name, answer]. */
function answers() {
  const out = [];
  for (const [lang, dir] of [['en', ANSWERS], ['zh', new URL('zh/', ANSWERS)]]) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
      const a = JSON.parse(fs.readFileSync(new URL(f, dir), 'utf8'));
      if (a.card?.journey) out.push([lang, f, a]);
    }
  }
  return out;
}

/** The lines the server sends, by name, with the function that shows each. */
const LINES = {
  title: (a, j) => J.to(a, j),
  walkText: (a, j) => J.walkText(j),
  walkEndText: (a, j) => J.walkEndText(j),
  rideText: (a, j) => J.rideText(j),
  arriveText: (a, j) => J.arrive(j),
  arriveWhere: (a, j) => J.arriveWhere(j),
  backupText: (a, j) => J.backup(a, j),
};

/**
 * JourneyText.kt's countdowns, as written there: whole seconds to leave
 * (none at the stop, without a leave time, or once it has passed), rounded
 * minutes from two minutes, then minutes and seconds, then seconds.
 */
const android = {
  secondsToLeave(a, j, now) {
    if (a.card.phase === 'waiting') return null;
    const at = a.leave?.at ? Date.parse(a.leave.at) : null;
    if (at == null || j.leave == null || now >= at) return null;
    return Math.trunc((at - now) / 1000);
  },
  countdown: (left, min, minS, s) => (left >= 120 ? t(min, Math.trunc((left + 30) / 60)) : left >= 60 ? t(minS, Math.trunc(left / 60), left % 60) : t(s, Math.max(1, left))),
  leaveIn(a, j, now) {
    if (a.card.phase === 'waiting') return (a.leave?.at ? a.card.leaveBy : null) ?? t('Leave now');
    const left = android.secondsToLeave(a, j, now);
    return left == null ? t('Leave now') : android.countdown(left, 'Leave in {0} min', 'Leave in {0} min {1} s', 'Leave in {0} s');
  },
  leaveTime(a, j, now) {
    const left = android.secondsToLeave(a, j, now);
    return left == null ? null : android.countdown(left, '{0} min', '{0} min {1} s', '{0} s');
  },
  by(a, j, now) {
    if (a.card.phase === 'waiting' || !a.leave?.at || now >= Date.parse(a.leave.at)) return null;
    return j.byText ?? (j.leave ? t('by {0}', j.leave) : null);
  },
  busIn(j, now) {
    if (!j.boardAt) return null;
    const left = Math.trunc((Date.parse(j.boardAt) - now) / 1000);
    if (left <= 0) return null;
    return left >= 120 ? t('in {0} min', Math.trunc((left + 30) / 60)) : t('in {0} min {1} s', Math.trunc(left / 60), left % 60);
  },
};

/** Seconds either side of the leave time (or the bus) the countdown is read at: each step of its wording, and the edges between them. */
const OFFSETS_S = [-3_600, -601, -150, -149.5, -121, -120, -119.9, -90, -61, -60, -59.5, -30, -1, -0.4, 0, 0.5, 60, 600];

test('there are shared answers with a journey in both languages', () => {
  const all = answers();
  assert.ok(all.filter(([l]) => l === 'en').length >= 5);
  assert.ok(all.filter(([l]) => l === 'zh').length >= 5);
});

test('the countdowns read as the Android app reads them, on every shared answer, in English and Chinese', () => {
  for (const [lang, name, a] of answers()) {
    useLang(lang);
    const j = a.card.journey;
    // The leave time, else the bus, else when the answer is from.
    const mark = Date.parse(a.leave?.at ?? j.boardAt ?? a.asOf);
    for (const s of OFFSETS_S) {
      const now = mark + s * 1000;
      const at = `${lang}/${name} at ${s} s`;
      assert.equal(J.secondsToLeave(a, j, now), android.secondsToLeave(a, j, now), at);
      assert.equal(J.leaveIn(a, j, now), android.leaveIn(a, j, now), at);
      assert.equal(J.leaveTime(a, j, now), android.leaveTime(a, j, now), at);
      assert.equal(J.by(a, j, now), android.by(a, j, now), at);
      assert.equal(J.busIn(j, now), android.busIn(j, now), at);
      // The time drawn in the accent is inside its headline, in both languages.
      const time = J.leaveTime(a, j, now);
      if (time !== null) assert.ok(J.leaveIn(a, j, now).includes(time), `${at}: "${time}" in "${J.leaveIn(a, j, now)}"`);
    }
  }
});

test('"Leave in 4 min", then minutes and seconds, then seconds, then "Leave now" once the leave time passes', async () => {
  const { default: a } = await import('./fixtures/answers/class-bus.json', { with: { type: 'json' } });
  const j = a.card.journey;
  const at = Date.parse(a.leave.at);
  const cases = [
    [-4 * 60, 'Leave in 4 min', '4 min'],
    [-150, 'Leave in 3 min', '3 min'],
    [-125, 'Leave in 2 min', '2 min'],
    [-119, 'Leave in 1 min 59 s', '1 min 59 s'],
    [-65, 'Leave in 1 min 5 s', '1 min 5 s'],
    [-45, 'Leave in 45 s', '45 s'],
    // Under a second left still counts down, rather than a "0 s".
    [-0.4, 'Leave in 1 s', '1 s'],
    [0, 'Leave now', null],
    [3_600, 'Leave now', null],
  ];
  useLang('en');
  for (const [s, head, time] of cases) {
    assert.equal(J.leaveIn(a, j, at + s * 1000), head, `${s} s`);
    assert.equal(J.leaveTime(a, j, at + s * 1000), time, `${s} s`);
  }
  // "by ~09:36" under it until then, and gone with "Leave now".
  assert.equal(J.by(a, j, at - 60_000), 'by ~09:36');
  assert.equal(J.by(a, j, at), null);
});

test('the same in Chinese, the time inside the sentence', async () => {
  const { default: a } = await import('./fixtures/answers/zh/class-bus.json', { with: { type: 'json' } });
  const j = a.card.journey;
  const at = Date.parse(a.leave.at);
  useLang('zh');
  assert.equal(J.leaveIn(a, j, at - 4 * 60_000), t('Leave in {0} min', 4));
  assert.notEqual(J.leaveIn(a, j, at - 4 * 60_000), 'Leave in 4 min');
  assert.match(J.leaveIn(a, j, at - 4 * 60_000), /4/);
  assert.equal(J.leaveIn(a, j, at), t('Leave now'));
  assert.notEqual(t('Leave now'), 'Leave now');
});

test('at the stop the headline is the bus to wait for, as the server words it, with no countdown', async () => {
  const { default: base } = await import('./fixtures/answers/class-bus.json', { with: { type: 'json' } });
  const a = structuredClone(base);
  a.card.phase = 'waiting';
  a.card.leaveBy = 'R2 at 09:42';
  const j = a.card.journey;
  const at = Date.parse(a.leave.at);
  for (const s of [-600, -30, 0, 600]) {
    assert.equal(J.leaveIn(a, j, at + s * 1000), 'R2 at 09:42');
    assert.equal(J.leaveTime(a, j, at + s * 1000), null);
    assert.equal(J.by(a, j, at + s * 1000), null);
  }
});

test('the bus\'s "in 4 min": minutes and seconds under two minutes, gone once it leaves, none on foot', async () => {
  const { default: a } = await import('./fixtures/answers/class-bus.json', { with: { type: 'json' } });
  const j = a.card.journey;
  const board = Date.parse(j.boardAt);
  useLang('en');
  assert.equal(J.busIn(j, board - 10 * 60_000), 'in 10 min');
  assert.equal(J.busIn(j, board - 119_000), 'in 1 min 59 s');
  assert.equal(J.busIn(j, board - 30_000), 'in 0 min 30 s');
  assert.equal(J.busIn(j, board), null);
  assert.equal(J.busIn({ ...j, boardAt: null }, board), null);
});

test("every line the server sent is shown as it is, even when it's nothing", () => {
  for (const [lang, name, a] of answers()) {
    useLang(lang);
    const j = a.card.journey;
    for (const [key, show] of Object.entries(LINES)) {
      if (j[key] === undefined) continue;
      assert.equal(show(a, j), j[key], `${lang}/${name} ${key}`);
    }
    if (j.byText !== undefined && a.leave?.at) assert.equal(J.by(a, j, Date.parse(a.leave.at) - 60_000), j.byText, `${lang}/${name} byText`);
  }
  // Said as nothing, it stays nothing: not worded here from the rest.
  assert.equal(J.said({ walkText: null, walk: '5 min' }, 'walkText', () => 'worded here'), null);
  assert.equal(J.said({ walk: '5 min' }, 'walkText', () => 'worded here'), 'worded here');
});

test("an answer from before the server sent its lines is worded here as the server words them", () => {
  // The service worker's kept copy can be from an older server: without
  // the lines, the card words them from the journey's parts, the same way.
  for (const [, name, a] of answers().filter(([l]) => l === 'en')) {
    useLang('en');
    const j = a.card.journey;
    const old = Object.fromEntries(Object.entries(j).filter(([k]) => !(k in LINES) && k !== 'byText'));
    for (const [key, show] of Object.entries(LINES)) {
      if (j[key] === undefined) continue;
      assert.equal(show(a, old), j[key], `${name} ${key}`);
    }
    if (a.leave?.at && j.leave) assert.equal(J.by(a, old, Date.parse(a.leave.at) - 60_000), j.byText, `${name} byText`);
  }
});
