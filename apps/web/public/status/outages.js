// The status page's outages (status/status.js): how long each lasted, and
// the last 30 days in two numbers. Apart from the page so the tests can run
// them (web-status.test.js).

import { t } from '/account/dom.js';

/** The server keeps this many outages (monitor.ts INCIDENTS_KEPT). */
export const KEPT = 20;
export const MONTH_MS = 30 * 86_400_000;

/** How long an outage lasted: "5 min", "2 h 10 min", "3 days". */
export function duration(ms) {
  const m = Math.max(1, Math.round(ms / 60_000));
  if (m < 60) return t('{0} min', m);
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? t('{0} h {1} min', h, m % 60) : t('{0} h', h);
  return t('{0} days', Math.round(h / 24));
}

/**
 * The last 30 days, from the outages kept: how many, and the share of the
 * time the feed answered. Only when the list reaches back that far (it keeps
 * the latest KEPT), so it never undercounts; otherwise null.
 */
export function month(incidents, nowMs) {
  const from = nowMs - MONTH_MS;
  const starts = incidents.map((i) => Date.parse(i.start));
  if (incidents.length >= KEPT && Math.min(...starts) > from) return null;
  let down = 0;
  let count = 0;
  for (const i of incidents) {
    const a = Math.max(Date.parse(i.start), from);
    const b = i.end ? Date.parse(i.end) : nowMs;
    if (b <= from) continue;
    count++;
    down += b - a;
  }
  // Down for a moment still isn't 100%: one decimal, rounded down.
  const live = Math.floor((1 - down / MONTH_MS) * 1000) / 10;
  return { count, live };
}
