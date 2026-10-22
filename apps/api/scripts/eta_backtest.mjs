#!/usr/bin/env node
/**
 * Backtests src/etamodel.ts against the feed's own arrival times: fits the
 * model on the earlier data, then, on the later data it never saw, scores
 * each method against when the bus really came. Prints Markdown (MAE,
 * median and 90th-percentile absolute error, mean signed error, by how far
 * ahead the feed was looking), and writes it with --out.
 *
 * Two kinds of input, either or both:
 *
 * - `--recording dev/eta/2026-10-22.jsonl`: what scripts/record_eta.mjs
 *   wrote (the map's buses and the boards, from a live site). Passings come
 *   from the buses as the map placed them (passingsFromReadings); the
 *   boards carry no plate, so a board's time is for the service's next bus
 *   of any plate.
 * - `--day timelapse/2026-10-21.json.gz --predictions ae-2026-10-21.jsonl`:
 *   a timelapse recorder day from R2 and the feed's predictions for it from
 *   Analytics Engine, one JSON object a line, `{t, svc, plate, stop, etaS}`
 *   (eta.ts Prediction; docs/eta-model.md has the query). Passings come
 *   from eta.ts passingsOf, and each prediction is for its own plate.
 *
 * With data from two Singapore days or more, the last day is the test and
 * the rest train; with one, the first --split of its time trains (0.6 by
 * default) and the rest tests. A question whose bus could have come after
 * the data ends isn't asked, so a short recording can't favour short
 * horizons. Nothing here is random: the same files give the same report.
 *
 *   node scripts/eta_backtest.mjs [--recording f.jsonl]... [--day d.json.gz --predictions p.jsonl]...
 *                                 [--split 0.6] [--out results.md] [--model-out model.json]
 *                                 [--recent-min 30] [--recent-n 2] [--recent-prior 0]
 *
 * The --recent-* settings are the buses just ahead's (etamodel.ts Recent):
 * how many minutes back a segment counts, how many are needed, and how
 * many segments history's median is worth beside them (0: replaced).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { GRAPH } from '../src/graph.ts';
import { HORIZONS, aeTime, passingsOf } from '../src/eta.ts';
import { windowOf } from '../src/timelapse.ts';
import { SGT_MS } from '../src/config.ts';
import { METHODS, RECENT, casesOf, errorStats, fitModel, passingsFromReadings, ringOf, scoreCases, segmentsOf } from '../src/etamodel.ts';

const args = process.argv.slice(2);
const usage = (why) => {
  console.error(`eta_backtest: ${why}`);
  process.exit(2);
};
const all = (name) => {
  const out = [];
  for (let i = args.indexOf(`--${name}`); i >= 0; i = args.indexOf(`--${name}`)) {
    const v = args.splice(i, 2)[1];
    if (v === undefined || v.startsWith('--')) usage(`--${name} needs a value`);
    out.push(v);
  }
  return out;
};
const one = (name, fallback) => all(name).at(-1) ?? fallback;

const recordings = all('recording');
const days = all('day');
const predictionFiles = all('predictions');
const SPLIT = Number(one('split', '0.6'));
const OUT = one('out', null);
const MODEL_OUT = one('model-out', null);
const recent = {
  windowMs: Number(one('recent-min', `${RECENT.windowMs / 60_000}`)) * 60_000,
  minN: Number(one('recent-n', `${RECENT.minN}`)),
  prior: Number(one('recent-prior', `${RECENT.prior}`)),
};
if (args.length) usage(`unknown arguments: ${args.join(' ')}`);
if (!recordings.length && !days.length) usage('give at least one --recording, or --day with --predictions');
if (days.length !== predictionFiles.length) usage('each --day needs its --predictions, in the same order');
if (!(SPLIT > 0 && SPLIT < 1)) usage('--split is between 0 and 1');
if (!(recent.windowMs > 0 && recent.minN >= 1 && recent.prior >= 0))
  usage('--recent-min over 0, --recent-n 1 or more, --recent-prior 0 or more');

/** After the time a question was given, how long its bus may take to come: the data must run that long. */
const TAIL_MS = 10 * 60_000;
const sgtDate = (ms) => new Date(ms + SGT_MS).toISOString().slice(0, 10);
const clock = (ms) => new Date(ms + SGT_MS).toISOString().slice(11, 16);
const jsonLines = (path) =>
  readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));

/** This deploy's routes, rung: the default where a recording doesn't say. */
const routes = Object.fromEntries(
  Object.entries(GRAPH.routes ?? {}).map(([svc, seq]) => [
    svc,
    ringOf(seq, GRAPH.loops?.[svc] ?? (seq.length > 2 && seq[0] === seq[seq.length - 1])),
  ]),
);

/** Units of data: {source, date, start, end, passings, queries, lagMs, readings}. */
const units = [];

for (const path of recordings) {
  const rows = jsonLines(path);
  const meta = rows.find((r) => r.k === 'meta');
  for (const [svc, r] of Object.entries(meta?.routes ?? {})) if (r.seq?.length) routes[svc] = ringOf(r.seq, r.loop);
  const readings = rows.filter((r) => r.k === 'bus');
  const passings = passingsFromReadings(readings);
  // A board's time at a route's first stop is for the bus leaving it (its -S
  // berth), not one reaching it, so it can't be scored against a passing.
  const queries = rows
    .filter((r) => r.k === 'board' && r.available !== false)
    .flatMap((r) =>
      r.rows
        .filter((x) => x.quality === 'live' && Number.isFinite(x.etaS) && routes[x.svc] && routes[x.svc].seq[0] !== r.stop)
        .map((x) => ({ t: r.t, svc: x.svc, stop: r.stop, etaS: x.etaS })),
    );
  if (!readings.length) {
    console.error(`${path}: no buses recorded`);
    continue;
  }
  const start = readings.reduce((a, r) => Math.min(a, r.t), Infinity);
  const end = readings.reduce((a, r) => Math.max(a, r.t), -Infinity);
  units.push({ source: path, date: sgtDate(start), start, end, passings, queries, lagMs: 0, readings: readings.length });
}

/**
 * The feed's predictions in [path]: JSON lines of {t, svc, plate, stop,
 * etaS}, or Analytics Engine's SQL reply as it comes ({data: [{plate, stop,
 * svc, eta, timestamp}]}, the query in docs/eta-model.md).
 */
function predictionsIn(path) {
  const text = readFileSync(path, 'utf8');
  let whole = null;
  try {
    whole = JSON.parse(text);
  } catch {
    // JSON lines, then.
  }
  if (Array.isArray(whole?.data)) {
    return whole.data.map((r) => ({
      t: aeTime(r.timestamp),
      svc: String(r.svc),
      plate: String(r.plate),
      stop: String(r.stop),
      etaS: Number(r.eta),
    }));
  }
  return jsonLines(path);
}

for (let i = 0; i < days.length; i++) {
  const raw = readFileSync(days[i]);
  const day = JSON.parse((days[i].endsWith('.gz') ? gunzipSync(raw) : raw).toString('utf8'));
  const passings = passingsOf(day);
  // The day's own predictions (one file can serve several days), each
  // cached answer once (as eta.ts scoreEtas), up to 30 minutes ahead.
  const { open, close } = windowOf(day.date);
  const seen = new Set();
  const queries = predictionsIn(predictionFiles[i])
    .filter((q) => {
      if (!(q.t >= open && q.t < close && q.etaS >= 0 && q.etaS <= 30 * 60)) return false;
      const once = `${q.svc}|${q.plate}|${q.stop}|${Math.floor(q.t / 15_000)}`;
      if (seen.has(once)) return false;
      seen.add(once);
      return true;
    })
    .map((q) => ({ t: q.t, svc: q.svc, stop: q.stop, etaS: q.etaS, plate: q.plate || undefined }));
  let end = day.t0;
  for (const s of day.samples) end += s[0];
  units.push({ source: days[i], date: day.date, start: day.t0, end, passings, queries, lagMs: day.pollMs, readings: day.samples.length });
}

if (!units.length) usage('no usable data');

// Questions whose bus may not have come before the data ends are left out.
const answerable = (end, q) => q.t + (q.etaS ?? 0) * 1000 + TAIL_MS <= end;

const dates = [...new Set(units.map((u) => u.date))].sort();
let train;
let test;
let how;
if (dates.length >= 2) {
  const last = dates.at(-1);
  train = units.filter((u) => u.date !== last).map((u) => ({ ...u, queries: u.queries.filter((q) => answerable(u.end, q)) }));
  test = units.filter((u) => u.date === last).map((u) => ({ ...u, queries: u.queries.filter((q) => answerable(u.end, q)) }));
  how = `trained on ${dates.slice(0, -1).join(', ')}; tested on ${last}`;
} else {
  const start = Math.min(...units.map((u) => u.start));
  const end = Math.max(...units.map((u) => u.end));
  const cut = start + SPLIT * (end - start);
  // Training sees only what was known before the cut: its passings, and
  // questions whose bus came (or should have) before it.
  train = units.map((u) => ({
    ...u,
    passings: u.passings.filter((x) => (x.seen ?? x.t + u.lagMs) < cut),
    queries: u.queries.filter((q) => answerable(cut, q)),
  }));
  test = units.map((u) => ({ ...u, queries: u.queries.filter((q) => q.t >= cut && answerable(u.end, q)) }));
  how = `one day (${dates[0]}): trained on ${clock(start)} to ${clock(cut)} SGT, tested on ${clock(cut)} to ${clock(end)}`;
}

const model = fitModel(routes, train);
const cases = test.flatMap((u) => casesOf(model, routes, u, recent));
const result = scoreCases(cases);
const trainCases = train.flatMap((u) => casesOf(model, routes, u, recent)).length;
const segments = train.flatMap((u) => segmentsOf(u.passings, routes));
const pairs = Object.values(model.table.all);

const LABELS = { gated: 'history+gate', recent: 'history+gate+recent' };
for (const m of METHODS) LABELS[m] ??= m;
const fmt = (x) => (x == null ? '–' : `${x}`);
const vs = (a, b) => (a == null || b == null || !b ? '–' : `${a <= b ? '−' : '+'}${Math.abs(Math.round(((a - b) / b) * 100))}%`);
const lines = [];
const p = (s = '') => lines.push(s);
p('# Arrival-time backtest');
p();
p(`Generated by \`apps/api/scripts/eta_backtest.mjs\`; ${how}.`);
p();
p('## Data');
p();
p('| source | date | span (SGT) | bus readings | passings | questions |');
p('|---|---|---|---|---|---|');
for (const u of units) {
  p(
    `| ${u.source.split('/').at(-1)} | ${u.date} | ${clock(u.start)}–${clock(u.end)} | ${u.readings} | ${u.passings.length} | ${u.queries.length} |`,
  );
}
p();
p(
  `Training: ${segments.length} segment times over ${pairs.length} stop pairs ` +
    `(${pairs.filter(([n]) => n >= 5).length} with 5 or more), and ${trainCases} questions with an actual arrival for the bias and weights.`,
);
p(
  `Test: ${cases.length} questions with an actual arrival; history could answer ` +
    `${result.coverage == null ? '–' : Math.round(result.coverage * 100)}% of them, and every method is scored on those ${result.overall.feed.n}.`,
);
p();
p(
  "Methods: **feed**, the feed's time as served; **corrected**, plus the feed's median error at that horizon for that service in training;",
);
p("**history**, the bus's last stop and the segment medians on from it; **history+gate**, history only where the bus needn't");
p("leave a route's first stop (where buses wait for their departure time), the feed's time otherwise; **history+gate+recent**,");
p(
  `that with each segment's median from the service's buses just ahead (the last ${recent.windowMs / 60_000} min, ` +
    `at least ${recent.minN}, ${recent.prior ? `history's median worth ${recent.prior}` : 'replacing history'}) where there are enough;`,
);
p('**blend**, history+gate+recent and corrected, weighted per horizon (corrected where the gate refuses).');
p();
p('## Errors in seconds (actual minus predicted: positive is the bus coming later)');
p();
const table = (stats) => {
  p('| method | n | MAE | p50 abs | p90 abs | mean signed | MAE vs feed |');
  p('|---|---|---|---|---|---|---|');
  for (const m of METHODS) {
    const s = stats[m];
    p(
      `| ${LABELS[m]} | ${s.n} | ${fmt(s.mae)} | ${fmt(s.p50)} | ${fmt(s.p90)} | ${fmt(s.bias)} | ${m === 'feed' ? '' : vs(s.mae, stats.feed.mae)} |`,
    );
  }
};
p('### Overall');
p();
table(result.overall);
const scored = cases.filter((c) => c.hist.alone !== null);
const gated = scored.filter((c) => c.hist.gated === null);
const fresh = scored.filter((c) => c.hist.gated !== null && c.hist.recent !== c.hist.gated);
p();
p(
  `The gate gave ${gated.length} of these ${scored.length} questions back to the feed ` +
    `(${scored.length ? Math.round((gated.length / scored.length) * 100) : 0}%); the buses just ahead changed history's answer on ${fresh.length}.`,
);
p();
p('### Where the gate lets history answer');
p();
p("Only the questions history+gate answers itself: the feed's time against history's, with and without the buses just ahead.");
p();
const open = scored.filter((c) => c.hist.gated !== null);
const row = (name, errs) => {
  const s = errorStats(errs);
  return `| ${name} | ${s.n} | ${fmt(s.mae)} | ${fmt(s.p50)} | ${fmt(s.p90)} | ${fmt(s.bias)} |`;
};
p('| method | n | MAE | p50 abs | p90 abs | mean signed |');
p('|---|---|---|---|---|---|');
p(
  row(
    'feed',
    open.map((c) => c.actualS - c.feedS),
  ),
);
p(
  row(
    'history+gate',
    open.map((c) => c.actualS - c.hist.gated),
  ),
);
p(
  row(
    'history+gate+recent',
    open.map((c) => c.actualS - c.hist.recent),
  ),
);
for (const h of result.horizons) {
  p();
  p(`### Feed said ${h.label}`);
  p();
  table(h.stats);
}
p();
p('## Fitted model');
p();
p(`Weight on history, by horizon: ${HORIZONS.map((h, i) => `${h.label} ${model.weights[i]}`).join('; ')}.`);
p();
p(
  `Feed bias (median error, s, all services), by horizon: ${HORIZONS.map(
    (h, i) => `${h.label} ${fmt(model.bias[`*|${i}`]?.[1])} (n ${model.bias[`*|${i}`]?.[0] ?? 0})`,
  ).join('; ')}.`,
);

const text = lines.join('\n') + '\n';
process.stdout.write(text);
if (OUT) writeFileSync(OUT, text);
if (MODEL_OUT) writeFileSync(MODEL_OUT, JSON.stringify(model));
