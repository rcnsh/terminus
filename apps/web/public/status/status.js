// The status page: /status.json, in Singapore time, checked every minute.
// The feed's state is drawn on the sky's road (sky-page.js): a live shuttle
// when NUS's feed answers, the same bus in outline when the apps are
// showing timetable estimates, as the apps draw a guess.

import { html, render, useEffect, useState } from '/assets/ui.js';
import { t, timeout } from '/account/dom.js';
import { drawHorizon } from '/assets/sky-page.js';

const TZ = { timeZone: 'Asia/Singapore' };
const LOCALE = window.i18n?.lang === 'zh' ? 'zh-CN' : 'en-SG';
const dateTime = (iso) => new Date(iso).toLocaleString(LOCALE, { ...TZ, day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
const time = (iso) => new Date(iso).toLocaleTimeString(LOCALE, { ...TZ, hour: 'numeric', minute: '2-digit' });

/** The shuttle on the road: A1's red. */
const RED = '#e53935';
/** The server keeps this many outages (monitor.ts INCIDENTS_KEPT). */
const KEPT = 20;
const MONTH_MS = 30 * 86_400_000;

function duration(ms) {
  const m = Math.max(1, Math.round(ms / 60_000));
  if (m < 60) return t('{0} min', m);
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? t('{0} h {1} min', h, m % 60) : t('{0} h', h);
  return t('{0} days', Math.round(h / 24));
}

const CAUSE = {
  version: t('NUS released a new version of uNivUS and stopped accepting the old one'),
  feed: t("NUS's live bus times weren't available"),
};

/** The headline, the line under it, the chip and the bus on the road, from /status.json. */
function now(s) {
  let state = { kind: 'off', headline: t('No checks yet'), detail: '', chip: '', bus: null };
  if (s.feed === 'up') {
    state = { kind: 'up', headline: t('Live bus times are working'), detail: s.since ? t('Up since {0}.', dateTime(s.since)) : '', chip: t('Live'), bus: { color: RED, far: 0.4, live: true } };
  } else if (s.feed === 'down') {
    state = { kind: 'down', headline: t("NUS's live feed is down"), detail: t("Since {0}. The apps show estimated times until it's restored.", dateTime(s.since)), chip: t('Estimates only'), bus: { color: RED, far: 0.7, live: false } };
  }
  if (s.checkedAt) {
    const note = s.checking ? t('Last checked {0}.', time(s.checkedAt)) : t('Status checks have paused. Last check: {0}.', dateTime(s.checkedAt));
    state.detail = `${state.detail} ${note}`.trim();
    if (!s.checking) state.kind = 'paused';
  }
  return state;
}

/**
 * The last 30 days, from the outages kept: how many, and the share of the
 * time the feed answered. Only when the list reaches back that far (it keeps
 * the latest KEPT), so it never undercounts; otherwise null.
 */
function month(incidents, nowMs) {
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

function Head({ s, failed }) {
  const head = failed ? { kind: 'off', headline: t("Couldn't load the status"), detail: t('Try again in a minute.'), chip: '' } : s ? now(s) : { kind: 'off', headline: t('Checking…'), detail: '', chip: '' };
  return html`
    <p class="eyebrow">${t('Status')}</p>
    <h1>${head.headline}</h1>
    ${head.detail && html`<p>${head.detail}</p>`}
    ${head.chip && html`<span class=${`sky-chip ${head.kind}`}><span class="dot"></span>${head.chip}</span>`}
  `;
}

function History({ s, failed }) {
  const m = s && month(s.incidents, Date.now());
  return html`
    ${m &&
    html`<div class="facts">
      <div><strong>${m.live}%</strong><small>${t('live in the last 30 days')}</small></div>
      <div><strong>${m.count}</strong><small>${m.count === 1 ? t('outage in the last 30 days') : t('outages in the last 30 days')}</small></div>
      <div><strong>${t('{0} min', 15)}</strong><small>${t('between checks')}</small></div>
    </div>`}
    <h2>${t('Recent outages')}</h2>
    ${!s && html`<p class="hint">${failed ? '' : t('Loading…')}</p>`}
    ${s && !s.incidents.length && html`<p class="hint">${t('None recorded.')}</p>`}
    ${s?.incidents.length > 0 &&
    html`<ol class="outages">
      ${s.incidents.map(
        (i) => html`
          <li key=${i.start} class=${i.end ? '' : 'ongoing-now'}>
            <div><div class="when">${dateTime(i.start)}</div><div class="what">${CAUSE[i.cause] ?? CAUSE.feed}</div></div>
            ${i.end ? html`<div class="how-long">${duration(Date.parse(i.end) - Date.parse(i.start))}</div>` : html`<div class="ongoing">${t('Ongoing')}</div>`}
          </li>
        `,
      )}
    </ol>`}
  `;
}

function Status() {
  const [s, setS] = useState(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const load = async () => {
      try {
        // Given up on after a while, so a hung call says it failed rather than loading for ever.
        const res = await fetch('/status.json', { cache: 'no-store', signal: timeout(15_000) });
        if (!res.ok) throw new Error(String(res.status));
        setS(await res.json());
        setFailed(false);
      } catch {
        setFailed(true);
      }
    };
    load();
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, []);
  // The road under the headline: your stop's sign, and the feed's bus coming to it.
  const bus = !failed && s ? now(s).bus : null;
  useEffect(() => drawHorizon(document.getElementById('road'), { stop: true, bus, shuttle: !bus }), [bus?.live, Boolean(bus)]);
  useEffect(() => render(html`<${Head} s=${s} failed=${failed} />`, document.getElementById('state')), [s, failed]);
  return html`<${History} s=${s} failed=${failed} />`;
}

render(html`<${Status} />`, document.getElementById('history'));
