import test from 'node:test';
import assert from 'node:assert/strict';
import { web } from './_web.mjs';

import { MAP_BOUNDS } from '../../api/src/map/map.ts';
import { MAX_FIX_ACC_M } from '../../api/src/config.ts';
import { FEEDBACK_LIMITS, REASONS } from '../../api/src/ops/feedback.ts';

test("the map's first frame stays inside the map file's extent, the API's MAP_BOUNDS", async () => {
  const { BOUNDS } = await web('app/map.js');
  assert.deepEqual(BOUNDS.flat(), [...MAP_BOUNDS]);
});

test('a position is sent with the accuracy the API takes, MAX_FIX_ACC_M', async () => {
  const { FIX_MAX_ACC_M } = await web('app/timing.js');
  assert.equal(FIX_MAX_ACC_M, MAX_FIX_ACC_M);
});

test("Feedback's note stops at the length /api/me/feedback takes", async () => {
  const { NOTE_MAX } = await web('account/settings-pages.js');
  assert.equal(NOTE_MAX, FEEDBACK_LIMITS.note);
});

test('"Is this wrong?" offers the reasons /api/me/feedback takes, each once', async () => {
  const { REPORT_REASONS } = await web('account/preview.js');
  assert.deepEqual(REPORT_REASONS.map(([key]) => key).sort(), Object.keys(REASONS).sort());
});
