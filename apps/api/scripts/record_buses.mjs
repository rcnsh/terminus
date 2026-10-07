#!/usr/bin/env node
/**
 * Records what the map is shown: /buses on a live site, every 5 s per
 * service, for a few minutes, with a throwaway anonymous account (deleted at
 * the end). Then checks each bus's `along` (metres along its route line):
 * between two readings on its line it may go back at most 60 m (GPS error)
 * and forward at most 100 m + 20 m/s since, as src/buses.ts tracks it. A
 * jump outside that is a bus switching to the other side of the road, or
 * being drawn backwards. Prints a Markdown report.
 *
 * The load is one person watching the map: one /buses call per service
 * every 5 s, which the Worker caches 5 s per service anyway.
 *
 *   node scripts/record_buses.mjs [--site https://terminus.rcn.sh] [--minutes 10] [--out trace.json] [A1 A2 D1 D2]
 */

import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? fallback : args.splice(i, 2)[1];
};
const SITE = opt('site', 'https://terminus.rcn.sh').replace(/\/+$/, '');
const MINUTES = Number(opt('minutes', '10'));
const OUT = opt('out', null);
const SERVICES = args.length ? args : ['A1', 'A2', 'D1', 'D2'];
const EVERY_MS = 5_000;
const BACK_M = 60;
const AHEAD_M = 100;
const AHEAD_MS = 20;
/** A request the site hasn't answered in this long has failed: a hung one would stall the recording. */
const TIMEOUT_MS = 15_000;
const within = () => AbortSignal.timeout(TIMEOUT_MS);

function haversine(aLat, aLon, bLat, bLon) {
  const r = Math.PI / 180;
  const s = Math.sin(((bLat - aLat) * r) / 2) ** 2 + Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(((bLon - aLon) * r) / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** A route line's length. */
function lengthOf(line) {
  let total = 0;
  for (let i = 1; i < line.length; i++) total += haversine(line[i - 1][1], line[i - 1][0], line[i][1], line[i][0]);
  return total;
}

async function record() {
  const res = await fetch(`${SITE}/auth/anon`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-terminus-client': 'probe/1' }, body: '{"name":"bus recorder"}', signal: within() });
  const { token } = await res.json().catch(() => ({}));
  if (!token) throw new Error(`no anonymous account: HTTP ${res.status}`);
  const headers = { authorization: `Bearer ${token}` };
  const rows = [];
  let failed = 0;
  let routes = {};
  try {
    const campus = await (await fetch(`${SITE}/campus`, { headers, signal: within() })).json();
    // /campus says which routes are loops: a loop's line can end tens of
    // metres from where it starts (A1, A2), so the ends can't tell.
    routes = Object.fromEntries(SERVICES.map((s) => [s, { line: campus.routes?.[s]?.line ?? [], loop: campus.routes?.[s]?.loop === true }]));
    const end = Date.now() + MINUTES * 60_000;
    while (Date.now() < end) {
      const tick = Date.now();
      await Promise.all(
        SERVICES.map(async (svc) => {
          try {
            const r = await fetch(`${SITE}/buses?svc=${encodeURIComponent(svc)}`, { headers, signal: within() });
            if (!r.ok) return void failed++;
            const d = await r.json();
            // Which Cloudflare data centre answered: each keeps its own tracks.
            const colo = r.headers.get('cf-ray')?.split('-')[1] ?? '?';
            for (const b of d.buses ?? []) rows.push({ t: tick, svc, colo, ...b });
          } catch {
            failed++;
          }
        }),
      );
      await new Promise((ok) => setTimeout(ok, Math.max(0, EVERY_MS - (Date.now() - tick))));
    }
  } finally {
    await fetch(`${SITE}/me`, { method: 'DELETE', headers, signal: within() }).catch(() => {});
  }
  return { routes, rows, failed };
}

function check({ routes, rows }) {
  const out = [];
  const bad = [];
  for (const svc of SERVICES) {
    const { line = [], loop = false } = routes[svc] ?? {};
    const total = lengthOf(line);
    const byBus = new Map();
    for (const r of rows.filter((x) => x.svc === svc)) {
      if (!byBus.has(r.id)) byBus.set(r.id, []);
      byBus.get(r.id).push(r);
    }
    let moves = 0, offLine = 0, readings = 0, maxBack = 0, maxRate = 0;
    for (const [id, list] of byBus) {
      let prev = null;
      for (const r of list) {
        readings++;
        if (r.along == null) {
          offLine++;
          prev = null; // a gap off its line: start again
          continue;
        }
        if (prev && r.along !== prev.along) {
          moves++;
          let gone = r.along - prev.along;
          // Round a loop, past its start.
          if (loop && total > 0 && gone < -total / 2) gone += total;
          if (loop && total > 0 && gone > total / 2) gone -= total;
          const dt = (r.t - prev.t) / 1000;
          maxBack = Math.max(maxBack, -gone);
          if (dt > 0) maxRate = Math.max(maxRate, gone / dt);
          if (gone < -BACK_M || gone > AHEAD_M + AHEAD_MS * dt) {
            bad.push({ svc, bus: id.slice(0, 6), at: new Date(r.t).toISOString().slice(11, 19), from: Math.round(prev.along), to: Math.round(r.along), gone: Math.round(gone), dt: Math.round(dt), colos: prev.colo === r.colo ? r.colo : `${prev.colo} → ${r.colo}` });
          }
        }
        if (!prev || r.along !== prev.along) prev = r;
      }
    }
    out.push(`| ${svc} | ${byBus.size} | ${readings} | ${offLine} | ${moves} | ${Math.round(Math.max(0, maxBack))} m | ${maxRate.toFixed(1)} m/s |`);
  }
  return { table: out, bad };
}

const trace = await record();
if (OUT) writeFileSync(OUT, JSON.stringify(trace));
const { table, bad } = check(trace);
const withSpeed = trace.rows.filter((r) => r.speed != null).length;
console.log(`## Live buses on ${SITE}: ${MINUTES} min, every ${EVERY_MS / 1000} s\n`);
console.log(`A *move* is a reading whose \`along\` differs from the bus's previous one on its line. A move is flagged when it goes back more than ${BACK_M} m, or forward more than ${AHEAD_M} m + ${AHEAD_MS} m/s since the previous one: a switch to the other side of the road, or a jump.\n`);
console.log('| service | buses | readings | off its line | moves | furthest back | fastest |');
console.log('|---|---|---|---|---|---|---|');
for (const line of table) console.log(line);
const colos = [...new Set(trace.rows.map((r) => r.colo))];
console.log(`\n${trace.rows.length} readings, ${withSpeed} with \`speed\`; ${trace.failed} requests failed. Answered from ${colos.join(', ')}.`);
if (!trace.rows.length) console.log('\nNo buses seen: none running, or the feed is down.');
else if (!bad.length) console.log('\n**No flagged moves:** no bus switched sides or jumped.');
else {
  console.log(`\n**${bad.length} flagged moves:**\n\n| service | bus | at (UTC) | from | to | moved | over | data centre |\n|---|---|---|---|---|---|---|---|`);
  for (const b of bad) console.log(`| ${b.svc} | ${b.bus} | ${b.at} | ${b.from} m | ${b.to} m | ${b.gone} m | ${b.dt} s | ${b.colos} |`);
}
