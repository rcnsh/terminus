#!/usr/bin/env node
/**
 * Records, from a live site's own API, what the arrival-time backtest
 * (scripts/probes/eta_backtest.mjs) needs when there's no recorder day to hand:
 * where each bus is (/api/buses, per service) and what the boards say
 * (/api/arrivals, per stop), timestamped, appended as JSON lines to a local
 * file. It's for a developer's machine, never the Worker: the Worker
 * already has both (the timelapse recorder's days in R2, the feed's
 * predictions in Analytics Engine; see src/ops/eta.ts).
 *
 * Polite by construction, and read-only:
 * - each service's buses at most once per --every seconds (20 at least),
 *   each through the Worker's 5 s cache and feed gate, as the map's are;
 * - one board per --board-every seconds, taking the stops in turn, so a
 *   stop is asked again only after every other stop has been;
 * - while no bus is out (overnight), one service is asked every 5 minutes
 *   and nothing else;
 * - a failed request backs the whole loop off, doubling to 5 minutes.
 *
 * It signs in as a throwaway anonymous account, deleted at the end, as
 * record_buses.mjs does. The site's /api/buses gives each bus where the map
 * draws it (at a stop, or between two), not its raw position, so arrivals
 * read from this are good to about half the polling interval.
 *
 *   node scripts/probes/record_eta.mjs [--site https://terminus.run] [--until 11:00] [--every 20] [--board-every 15]
 *                               [--out ../../dev/eta/<date>.jsonl] [A1 A2 D1 D2 K]
 *
 * --until is a Singapore clock time today (or tomorrow, if already past).
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const usage = (why) => {
  console.error(`record_eta: ${why}`);
  process.exit(2);
};
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = args.splice(i, 2)[1];
  if (v === undefined || v.startsWith('--')) usage(`--${name} needs a value`);
  return v;
};

const SGT_MS = 8 * 3_600_000;
const sgtDate = (ms) => new Date(ms + SGT_MS).toISOString().slice(0, 10);
const SITE = opt('site', 'https://terminus.run').replace(/\/+$/, '');
const EVERY_S = Number(opt('every', '20'));
if (!(EVERY_S >= 20)) usage('--every is at least 20 seconds');
const BOARD_EVERY_S = Number(opt('board-every', '15'));
if (!(BOARD_EVERY_S >= 10)) usage('--board-every is at least 10 seconds');
const UNTIL = opt('until', '11:00');
const m = /^(\d\d):(\d\d)$/.exec(UNTIL);
if (!m) usage('--until is HH:MM, Singapore time');
const here = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(opt('out', resolve(here, `../../../../dev/eta/${sgtDate(Date.now())}.jsonl`)));
const SERVICES = args.length ? args : ['A1', 'A2', 'D1', 'D2', 'K'];

/** --until as epoch ms: today's in Singapore, or tomorrow's once that's past. */
function untilMs(now) {
  const midnight = Date.parse(`${sgtDate(now)}T00:00:00Z`) - SGT_MS;
  const at = midnight + (Number(m[1]) * 60 + Number(m[2])) * 60_000;
  return at > now ? at : at + 86_400_000;
}
const END = untilMs(Date.now());
const IDLE_MS = 5 * 60_000;
const MAX_BACKOFF_MS = 5 * 60_000;
const TIMEOUT_MS = 15_000;
const within = () => AbortSignal.timeout(TIMEOUT_MS);
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

mkdirSync(dirname(OUT), { recursive: true });
const write = (row) => appendFileSync(OUT, `${JSON.stringify(row)}\n`);
const log = (...a) => console.log(new Date().toISOString(), ...a);

let stopping = false;
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => (stopping = true));

async function main() {
  const res = await fetch(`${SITE}/api/auth/anon`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-terminus-client': 'probe/1' },
    body: '{"name":"eta recorder"}',
    signal: within(),
  });
  const { token } = await res.json().catch(() => ({}));
  if (!token) throw new Error(`no anonymous account: HTTP ${res.status}`);
  const headers = { authorization: `Bearer ${token}`, 'x-terminus-client': 'probe/1' };
  const get = async (path) => {
    const t0 = Date.now();
    const r = await fetch(`${SITE}${path}`, { headers, signal: within() });
    const t = Date.now();
    if (!r.ok) {
      write({ k: 'fail', t, path, status: r.status });
      throw new Error(`${path}: HTTP ${r.status}`);
    }
    // The middle of the round trip: when the Worker answered, give or take.
    return { t: Math.round((t0 + t) / 2), body: await r.json() };
  };
  try {
    const { body: campus } = await get('/api/campus');
    const routes = Object.fromEntries(
      SERVICES.map((s) => [s, { seq: campus.routes?.[s]?.seq ?? [], loop: campus.routes?.[s]?.loop === true }]),
    );
    // The boards to read: every stop these services call at, busiest first.
    const calls = new Map();
    for (const { seq } of Object.values(routes)) for (const code of new Set(seq)) calls.set(code, (calls.get(code) ?? 0) + 1);
    const stops = [...calls.keys()].sort((a, b) => calls.get(b) - calls.get(a) || a.localeCompare(b));
    write({ k: 'meta', t: Date.now(), site: SITE, services: SERVICES, routes, stops, everyS: EVERY_S, boardEveryS: BOARD_EVERY_S });
    log(`recording ${SERVICES.join(' ')} and ${stops.length} boards from ${SITE} to ${OUT} until ${new Date(END).toISOString()}`);

    let backoff = 0;
    let idleSvc = 0;
    let boardIdx = 0;
    const nextBuses = new Map(SERVICES.map((s, i) => [s, Date.now() + (i * EVERY_S * 1000) / SERVICES.length]));
    let nextBoard = Date.now();
    let anyOut = false;
    let lastOut = 0;
    while (!stopping && Date.now() < END) {
      try {
        if (!anyOut) {
          // Nothing running: one service, then wait.
          const svc = SERVICES[idleSvc++ % SERVICES.length];
          const { t, body } = await get(`/api/buses?svc=${svc}`);
          const n = body.buses?.length ?? 0;
          log(`idle check ${svc}: ${n} buses`);
          if (n) {
            anyOut = true;
            lastOut = t;
            continue;
          }
          await sleep(Math.min(IDLE_MS, Math.max(0, END - Date.now())));
          continue;
        }
        const now = Date.now();
        const svc = SERVICES.find((s) => nextBuses.get(s) <= now);
        if (svc) {
          nextBuses.set(svc, now + EVERY_S * 1000);
          const { t, body } = await get(`/api/buses?svc=${svc}`);
          const at = body.stale ? Date.parse(body.asOf) : t;
          for (const b of body.buses ?? []) {
            write({
              k: 'bus',
              t: at,
              svc,
              plate: b.plate,
              at: b.at?.code ?? null,
              last: b.stretch?.last?.code ?? null,
              next: b.nextStop?.code ?? null,
              along: b.along,
              lat: b.lat,
              lon: b.lon,
            });
          }
          if (body.buses?.length) lastOut = t;
        } else if (nextBoard <= now) {
          nextBoard = now + BOARD_EVERY_S * 1000;
          const stop = stops[boardIdx++ % stops.length];
          const { t, body } = await get(`/api/arrivals?stop=${encodeURIComponent(stop)}`);
          const rows = (body.board ?? [])
            .filter((r) => SERVICES.includes(r.svc))
            .map((r) => ({ svc: r.svc, etaS: r.etaS, quality: r.quality, later: (r.later ?? []).map((l) => l.etaS) }));
          write({ k: 'board', t, stop, asOf: body.asOf, available: body.available, rows });
        } else {
          await sleep(Math.max(50, Math.min(nextBoard, ...nextBuses.values()) - Date.now()));
          continue;
        }
        // Every service quiet for 10 minutes: back to the idle check.
        if (Date.now() - lastOut > 10 * 60_000) {
          log('no buses for 10 minutes: idle');
          anyOut = false;
        }
        backoff = 0;
      } catch (err) {
        backoff = Math.min(MAX_BACKOFF_MS, backoff ? backoff * 2 : 20_000);
        log(`failed (${err instanceof Error ? err.message : String(err)}), waiting ${backoff / 1000} s`);
        await sleep(backoff);
      }
    }
  } finally {
    await fetch(`${SITE}/api/me`, { method: 'DELETE', headers, signal: within() }).catch(() => {});
    log('stopped; anonymous account deleted');
  }
}

await main();
