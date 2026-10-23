// The operator dashboard (admin/): what its pages work out from /api/admin/stats.
import test from 'node:test';
import assert from 'node:assert/strict';
import { web } from './_web.mjs';

const { derive } = await web('admin/views.js');

test("the dashboard's days are Singapore days, and the week leaves today's few hours out", () => {
  // 06:00 on Fri 24 Oct in Singapore, 22:00 UTC on the 23rd.
  const now = '2026-10-23T22:00:00Z';
  // The server sends a row per Singapore day: 100 a day for 14 full days, then 10 so far today.
  const days = Array.from({ length: 15 }, (_, i) => new Date(Date.UTC(2026, 9, 10 + i)).toISOString().slice(0, 10));
  const daily = days.map((day, i) => ({ day, kind: 'answer', n: i === 14 ? 10 : 100 }));
  const d = derive({ now, accounts: { total: 0 }, analytics: { daily } });
  assert.equal(d.d14.at(-1), '2026-10-24');
  assert.equal(d.d14.length, 14);
  assert.equal(d.answers.at(-1), 10, "today's bar holds this morning's answers");
  assert.equal(d.answers.at(-2), 100);
  // Seven full days against the seven before: the same, not down by today's missing hours.
  assert.equal(d.answers7, 700);
  assert.equal(d.answersChange, 0);
});
