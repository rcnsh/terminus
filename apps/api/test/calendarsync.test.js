import test from 'node:test';
import assert from 'node:assert/strict';
import nusmods from './fixtures/calendar/nusmods.json' with { type: 'json' };
import holidays from './fixtures/calendar/holidays.json' with { type: 'json' };
import { BUNDLED, calendarThrough, termDay } from '../src/calendar.ts';
import { CALENDAR_DATA_KEY, CALENDAR_NEXT_KEY, NUSMODS_CALENDAR, SG_HOLIDAYS, calendarSource, fromSources, loadCalendar, refreshCalendar, resetCalendar, valid } from '../src/calendarsync.ts';
import { checkCalendar, runCron } from '../src/monitor.ts';
import { makeEnv, makeKV } from './_stubs.mjs';

// test/fixtures/calendar: the two sources' real replies on 3 October 2026,
// cut to the fields the code reads.

const NOW = Date.UTC(2026, 9, 5, 2, 0); // Monday 5 October 2026, 10:00 SGT
const DAY = 86_400_000;
/** NUSMods once it lists 2027/2028 (semester 1 from 9 August 2027). */
const withNextYear = { ...nusmods, '2027/2028': { 1: { start: [2027, 8, 9] }, 2: { start: [2028, 1, 10] } } };

/** fetch answering the two sources, counting the calls. */
function sources({ cal = withNextYear, days = holidays, status = 200 } = {}) {
  const calls = [];
  const fn = async (url) => {
    calls.push(String(url));
    if (status !== 200) return new Response('down', { status });
    if (String(url) === NUSMODS_CALENDAR) return Response.json(cal);
    if (String(url) === SG_HOLIDAYS) return Response.json(days);
    return new Response('unexpected', { status: 599 });
  };
  fn.calls = calls;
  return fn;
}

test.beforeEach(() => resetCalendar());

test('the bundled calendar passes the checks the fetched one must', () => {
  assert.ok(valid(BUNDLED));
  assert.ok(valid(fromSources(nusmods, holidays, NOW)));
});

test('the sources read as fetch_calendar.py reads them', () => {
  const c = fromSources(nusmods, holidays, NOW);
  assert.ok(c.semesters.every((s) => Number(s.acadYear.slice(5)) >= 2025), 'from last year on');
  assert.deepEqual(c.semesters.find((s) => s.acadYear === '2026/2027' && s.semester === 1), { acadYear: '2026/2027', semester: 1, start: '2026-08-10' });
  assert.ok(c.holidays.some((h) => h.date === '2026-08-09' && h.name === 'National Day'));
  assert.ok(c.holidays.every((h) => !h.name.includes('’')), 'plain apostrophes, as in the bundled file');
  // Every semester and holiday in the bundled file from last year on is in the fetched one.
  for (const s of BUNDLED.semesters.filter((x) => Number(x.acadYear.slice(5)) >= 2025)) assert.ok(c.semesters.some((x) => x.acadYear === s.acadYear && x.semester === s.semester && x.start === s.start), `${s.acadYear} ${s.semester}`);
  assert.throws(() => fromSources({ '2026/2027': { 1: {} } }, holidays, NOW), /no start date/);
  assert.throws(() => fromSources(nusmods, { result: {} }, NOW), /no records/);
});

test('the cron fetches a newer calendar into KV, and every instance answers from it', async () => {
  const env = makeEnv(makeKV());
  globalThis.fetch = sources();
  // 31 August 2027 is past the bundled calendar: every week counts, as "unknown".
  const aug2027 = Date.UTC(2027, 7, 31, 2, 0);
  assert.equal(termDay(aug2027).kind, 'unknown');
  assert.equal(await refreshCalendar(env, NOW), 'updated');
  assert.ok(calendarThrough() > '2028-01-01', `now through ${calendarThrough()}`);
  assert.deepEqual(termDay(aug2027), { acadYear: '2027/2028', semester: 1, kind: 'instructional', week: 4, holiday: null });
  // Another instance, starting with only the bundled copy, reads it from KV.
  resetCalendar();
  assert.equal(termDay(aug2027).kind, 'unknown');
  await loadCalendar(env, NOW);
  assert.equal(termDay(aug2027).week, 4);
  assert.equal(calendarSource(), 'fetched');
});

test('fetched once a week; after a failure, again the next day, and nothing changes', async () => {
  const env = makeEnv(makeKV());
  const ok = sources();
  globalThis.fetch = ok;
  await refreshCalendar(env, NOW);
  assert.equal(await refreshCalendar(env, NOW + 6 * DAY), 'not due');
  assert.equal(ok.calls.length, 2);
  assert.equal(await refreshCalendar(env, NOW + 7 * DAY), 'unchanged');
  const kept = await env.KV.get(CALENDAR_DATA_KEY);

  // A source down: thrown (for the cron's log), retried the next day, KV untouched.
  globalThis.fetch = sources({ status: 503 });
  await assert.rejects(refreshCalendar(env, NOW + 14 * DAY), /503/);
  assert.equal(Number(await env.KV.get(CALENDAR_NEXT_KEY)), NOW + 15 * DAY);
  assert.equal(await env.KV.get(CALENDAR_DATA_KEY), kept);

  // A reply in a new shape, or with dates that make no sense: the same.
  globalThis.fetch = sources({ cal: { '2027/2028': { 1: { start: [2027, 8, 10] } } } });
  await assert.rejects(refreshCalendar(env, NOW + 15 * DAY), /checks/, 'a Tuesday start is no semester');
  globalThis.fetch = sources({ days: { result: { records: [] } } });
  await assert.rejects(refreshCalendar(env, NOW + 16 * DAY), /checks/, 'no holidays at all');
  assert.equal(await env.KV.get(CALENDAR_DATA_KEY), kept);
});

test('a source that drops a year loses nothing', async () => {
  const env = makeEnv(makeKV());
  globalThis.fetch = sources();
  await refreshCalendar(env, NOW);
  const { '2027/2028': _gone, ...without } = withNextYear;
  globalThis.fetch = sources({ cal: without });
  assert.equal(await refreshCalendar(env, NOW + 7 * DAY), 'unchanged');
  resetCalendar();
  await loadCalendar(env, NOW + 7 * DAY);
  assert.equal(termDay(Date.UTC(2027, 7, 31, 2, 0)).acadYear, '2027/2028');
});

test('a KV read that fails keeps the merged years: nothing is written over them', async () => {
  const env = makeEnv(makeKV());
  globalThis.fetch = sources();
  await refreshCalendar(env, NOW);
  const kept = await env.KV.get(CALENDAR_DATA_KEY);
  const { '2027/2028': _gone, ...without } = withNextYear;
  globalThis.fetch = sources({ cal: without });
  const get = env.KV.get;
  env.KV.get = async (k, ...rest) => {
    if (k === CALENDAR_DATA_KEY) throw new Error('KV unavailable');
    return get.call(env.KV, k, ...rest);
  };
  await assert.rejects(refreshCalendar(env, NOW + 7 * DAY), /KV unavailable/);
  env.KV.get = get;
  assert.equal(await env.KV.get(CALENDAR_DATA_KEY), kept);
  assert.equal(Number(await env.KV.get(CALENDAR_NEXT_KEY)), NOW + 8 * DAY, 'tried again the next day');
});

test('a broken copy in KV is ignored: the bundled calendar answers', async () => {
  const env = makeEnv(makeKV({ [CALENDAR_DATA_KEY]: { semesters: [{ acadYear: 'x', semester: 9, start: 'soon' }], holidays: [] } }));
  await loadCalendar(env, NOW);
  assert.equal(calendarSource(), 'bundled');
  assert.equal(calendarThrough(), calendarThrough(BUNDLED));
});

test('the cron refreshes the calendar, and warns only when even the fetched one runs out', async () => {
  // Mid-July 2027: the bundled calendar runs out (23 August) within the warning window.
  const july = Date.UTC(2027, 6, 15, 2, 0);
  const sent = [];
  // Calendar warnings only: the fake fetch has no NUS feed, which is an outage alert of its own.
  const env = { ...makeEnv(makeKV()), EMAIL: { send: async (m) => /calendar/.test(m.subject) && sent.push(m) }, EMAIL_FROM: 'a@b.c', ALERT_EMAIL: 'ops@b.c' };
  globalThis.fetch = sources({ cal: nusmods });
  await runCron(env, july);
  assert.equal(sent.length, 1, 'NUSMods has no 2027/2028 yet: warned');
  assert.match(sent[0].text, /fetches the calendar itself every week/);

  // A week later NUSMods lists it: fetched, and no more warnings.
  resetCalendar();
  sent.length = 0;
  globalThis.fetch = sources();
  await runCron(env, july + 14 * DAY);
  assert.ok(calendarThrough() > '2028-01-01');
  assert.equal(await checkCalendar(env, july + 21 * DAY), false);
  assert.equal(sent.length, 0);
});
