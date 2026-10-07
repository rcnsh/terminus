/**
 * The words the server sends ready-made, so the clients show them instead of
 * building them (CLAUDE.md rule 1): a board row's times and direction, the
 * card's headline, heading and reminder time, the journey's lines, and a
 * Today row's second line. English and Chinese, from the same facts.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { cardFor, headingOf, remindAtOf, titleOf } from '../src/card.ts';
import { dayLine } from '../src/day.ts';
import { etaText, thenText, towardsText } from '../src/resolve.ts';
import { DUE_MS } from '../src/trip.ts';
import { withLang } from '../src/i18n.ts';

const load = async (name) => {
  const { default: fixture } = await import(`./fixtures/answers/${name}.json`, { with: { type: 'json' } });
  const { card: _card, refreshAt: _r, ...answer } = fixture;
  return answer;
};
const zh = (fn) => withLang('zh', fn);

test('a board row says its time in words, with "~" for a timetable time', () => {
  assert.equal(etaText(240, 'live'), '4 min');
  assert.equal(etaText(360, 'scheduled'), '~6 min');
  assert.equal(etaText(240, 'stale'), '4 min', 'an old live time is still not a guess');
  assert.equal(etaText(20, 'live'), 'now');
  assert.equal(etaText(20, 'scheduled'), 'now', '"~now" says nothing more than "now"');
  assert.equal(zh(() => etaText(360, 'scheduled')), '约 6 分钟');
});

test('"then" names up to three later buses, each timetable one marked', () => {
  assert.equal(thenText([]), null);
  assert.equal(thenText([{ etaS: 720, quality: 'live' }]), 'then 12 min');
  const later = [
    { etaS: 720, quality: 'live' },
    { etaS: 1200, quality: 'scheduled' },
    { etaS: 1500, quality: 'live' },
    { etaS: 2400, quality: 'live' },
  ];
  assert.equal(thenText(later), 'then 12, ~20, 25 min');
  assert.equal(zh(() => thenText(later)), '之后 12、约 20、25 分钟');
  // Never "0": a bus under a minute away is still a minute.
  assert.equal(thenText([{ etaS: 10, quality: 'live' }]), 'then 1 min');
});

test('"to" says where the service goes: the next stop, then its end, or that it ends here', () => {
  assert.equal(towardsText(['Central Library', 'Kent Vale']), 'to Central Library, Kent Vale');
  assert.equal(towardsText(['COM 3']), 'to COM 3');
  assert.equal(towardsText([]), 'Ends here');
  assert.equal(zh(() => towardsText(['Central Library', 'Kent Vale'])), '经 Central Library，开往 Kent Vale');
  assert.equal(zh(() => towardsText(['COM 3'])), '开往 COM 3');
  assert.equal(zh(() => towardsText([])), '本站为终点站');
});

test('the card title is the departure as a clock time, marked when it is an estimate', async () => {
  const place = await load('place');
  assert.equal(titleOf(place, false), 'A1 · 09:09');
  assert.equal(titleOf(place, true), 'A1 · 9:09 AM');
  assert.equal(titleOf({ ...place, quality: 'scheduled' }, false), 'A1 · ~09:09');
  assert.equal(zh(() => titleOf({ ...place, quality: 'scheduled' }, false)), 'A1 · 约 09:09');
  // An old reading aged to now is no more exact than a guess.
  assert.equal(titleOf({ ...place, quality: 'stale' }, false), 'A1 · ~09:09');
  // No time to count down to: the label as it is.
  assert.equal(titleOf(await load('class-walk'), false), 'Walk · 3 min');
  assert.equal(titleOf({ ...place, quality: 'unknown' }, false), place.label);
  assert.equal(titleOf(await load('free'), false), 'No classes today');
});

test('the heading above the card says why you are going', async () => {
  assert.equal(headingOf(await load('class-bus')), 'Next class · GEA1000 @ UTown');
  assert.equal(headingOf(await load('place')), 'Going to KR MRT');
  assert.equal(headingOf(await load('evening-home')), 'Heading home');
  const gap = { ...(await load('evening-home')), dest: { to: 'PGP', label: 'Home', why: 'gap-home' } };
  assert.equal(headingOf(gap), 'Long gap · Home');
  assert.equal(zh(() => headingOf({ ...gap, dest: { ...gap.dest, label: '家' } })), '空档较长 · 回家');
  assert.equal(headingOf(await load('free')), null);
  assert.equal(headingOf(await load('nearby-list')), null);
});

test('the reminder goes five minutes before the leave-by, only for a class with reminders on', async () => {
  const cls = await load('class-bus');
  const card = cardFor(cls);
  assert.equal(Date.parse(card.remindAt), Date.parse(cls.leave.at) - DUE_MS);
  assert.equal(card.remindAt, '2026-08-27T01:31:40Z');
  assert.equal(remindAtOf(cls, 'class', { key: 'k', phase: 'idle', remind: false }), null, 'reminders off');
  assert.equal(remindAtOf(cls, 'class', { key: 'k', phase: 'heading' }), null, 'already on the way');
  assert.equal(remindAtOf(cls, 'class', { key: 'k', phase: 'due' }), card.remindAt, 'still due');
  assert.equal(remindAtOf({ ...cls, leave: null }, 'class', { key: null, phase: 'idle' }), null, 'no leave-by');
  assert.equal(cardFor(await load('place')).remindAt, null, 'a favourite is not a class');
  assert.equal(cardFor(await load('class-started')).remindAt, null, 'the class has started');
  // On foot to a class there is still a time to leave by.
  assert.ok(cardFor(await load('class-walk')).remindAt);
});

test('the journey comes worded: its title, the lines under each step, the backup and a one-liner', async () => {
  const j = cardFor(await load('class-bus')).journey;
  assert.equal(j.title, 'To GEA1000 @ UTown · starts 10:00');
  assert.equal(j.place, 'GEA1000');
  assert.equal(j.byText, 'by ~09:36');
  assert.equal(j.walkText, '5 min walk');
  assert.equal(j.rideText, '10 min ride');
  assert.equal(j.walkEndText, null);
  assert.equal(j.arriveText, 'Arrive ~09:51 · 9 min early');
  assert.equal(j.arriveWhere, 'at UTown');
  assert.equal(j.backupText, 'Or go now: R2 at 09:06 from PGP');
  assert.equal(j.summary, 'arrive ~09:51 · R2 ~09:42 at PGP');

  const zj = zh(async () => cardFor(await load('class-bus')).journey);
  const z = await zj;
  assert.equal(z.title, '去 GEA1000 @ UTown · 10:00 开始');
  assert.equal(z.backupText, '或现在走：在 PGP 搭 09:06 的 R2');

  // A trip: no start time, and the other bus is just another way.
  const trip = cardFor(await load('place')).journey;
  assert.equal(trip.title, 'To KR MRT');
  assert.equal(trip.backupText, 'Or D2 at 09:14 from PGP');
  assert.equal(trip.arriveText, 'Arrive 09:10');
  assert.equal(trip.summary, 'Walk to PGP · A1 09:09');
  // At the stop: no walk, no "by", and the one-liner is the bus there.
  const waiting = cardFor(await load('place'), false, { key: 'mrt', phase: 'waiting' }).journey;
  assert.equal(waiting.byText, null);
  assert.equal(waiting.walkText, null);
  assert.equal(waiting.summary, 'A1 09:09 at PGP');

  // A room a walk from its stop: the walk on, under the stop and the arrival
  // (as the server sent it: the walk on isn't in the answer's own fields).
  const { default: classRoom } = await import('./fixtures/answers/class-room.json', { with: { type: 'json' } });
  const room = classRoom.card.journey;
  assert.equal(room.walkEndText, '2 min walk');
  assert.equal(room.arriveWhere, '2 min walk from UTown');

  // On foot: the walk, and the bus it beats.
  const foot = cardFor(await load('class-walk')).journey;
  assert.equal(foot.rideText, null);
  assert.equal(foot.walkText, '3 min walk');
  assert.equal(foot.backupText, 'D1 would be 16 min');
  assert.equal(foot.summary, 'arrive 09:57 · 3 min walk · D1 would be 16 min');
});

test('a bus off across the road says so under the ride', async () => {
  const answer = await load('place');
  const j = cardFor({ ...answer, leave: { ...answer.leave, off: 'Opp NUSS' } }).journey;
  assert.equal(j.rideText, `${j.ride} ride · off at Opp NUSS`);
});

test("a Today row's second line: the leave-by and how, the bus you're on, or nothing once done", () => {
  const base = { kind: 'class', key: 'k', label: 'CS2030', title: 'CS2030', line: null, status: 'next', from: 'PGP', fromName: "Prince George's Park", to: 'COM3', toName: 'COM 3', startsAt: '2026-08-27T02:00:00Z', endsAt: null, removable: true };
  const leave = { at: '2026-08-27T01:38:00Z', estimated: true, svc: 'D2', stop: 'PGP', board: '2026-08-27T01:41:00Z', arrive: null };
  assert.equal(dayLine({ ...base, leave }, false), 'Leave by ~09:38 · D2 from PGP');
  assert.equal(dayLine({ ...base, leave: { ...leave, estimated: false } }, true), 'Leave by 9:38 AM · D2 from PGP');
  assert.equal(dayLine({ ...base, leave: { ...leave, stop: null } }, false), "Leave by ~09:38 · D2 from Prince George's Park");
  assert.equal(dayLine({ ...base, leave: { ...leave, svc: null, stop: null, board: null } }, false), 'Leave by ~09:38 · walk');
  assert.equal(dayLine({ ...base, leave, timing: { status: 'late', text: '~5 min late', classAt: base.startsAt, reachAt: base.startsAt } }, false), 'Leave by ~09:38 · D2 from PGP · ~5 min late');
  assert.equal(dayLine({ ...base, onBus: { svc: 'D2', off: 'UTown', arrive: '2026-08-27T01:52:00Z' } }, false), 'On the D2 · off at UTown · arrive 09:52');
  assert.equal(dayLine({ ...base, status: 'skipped' }, false), 'Not going');
  assert.equal(dayLine({ ...base, status: 'done', leave }, false), null, 'done: nothing under it');
  assert.equal(dayLine(base, false), null, 'nothing to say yet');
  assert.equal(zh(() => dayLine({ ...base, leave }, false)), '约 09:38 前出发 · 在 PGP 搭 D2');
});

test('the Today golden has its rows worded, and a finished one says nothing', async () => {
  const { default: day } = await import('./fixtures/answers/day.json', { with: { type: 'json' } });
  const first = day.items[0];
  assert.equal(first.title, 'GEA1000 @ UTown');
  assert.match(first.line, /^Leave by ~?\d{2}:\d{2} · R2 from PGP$/);
  const home = day.items.find((x) => x.kind === 'home');
  assert.equal(home.title, 'Home, from UTown');
  for (const it of day.items) if (it.status === 'done') assert.equal(it.line, null);
});

test('outside a trip the glance is a clock time, never a minute count that a menu bar would freeze', async () => {
  const place = await load('place');
  assert.equal(place.label, 'A1 · 9 min');
  assert.equal(cardFor(place).glance, 'A1 09:09');
  assert.equal(cardFor(place, true).glance, 'A1 9:09a');
  assert.equal(cardFor({ ...place, quality: 'scheduled' }).glance, 'A1 ~09:09');
  assert.equal(zh(() => cardFor({ ...place, quality: 'scheduled' }).glance), 'A1 约 09:09');
  assert.equal(cardFor({ ...place, quality: 'stale' }).glance, 'A1 ~09:09');
  // The same as the title, without the separator.
  assert.equal(cardFor(place).glance, cardFor(place).title.replace(' · ', ' '));
  // With no time to give, the label's own words.
  assert.equal(cardFor({ ...place, quality: 'unknown' }).glance, 'A1 9 min'.slice(0, 12));
  assert.equal(cardFor(await load('class-walk')).glance, 'Walk 3 min');
  for (const name of ['class-bus', 'place', 'landmark', 'room', 'scheduled', 'evening-home']) assert.ok(cardFor(await load(name), true).glance.length <= 12, name);
});
