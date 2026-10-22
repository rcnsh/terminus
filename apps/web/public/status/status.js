// The status page: /api/status.json, in Singapore time, checked every minute.
// The feed's state is drawn on the sky's road (sky-page.js): a live shuttle
// when NUS's feed answers, the same bus in outline when the apps are
// showing timetable estimates, as the apps draw a guess, and an empty road
// overnight, when no shuttle runs.

import { html, render, useEffect, useState } from '/assets/ui.js';
import { t, timeout } from '/account/dom.js';
import { drawHorizon } from '/assets/sky-page.js';
import { duration, month } from '/status/outages.js';

const TZ = { timeZone: 'Asia/Singapore' };
const LOCALE = window.i18n?.lang === 'zh' ? 'zh-CN' : 'en-SG';
const dateTime = (iso) =>
  new Date(iso).toLocaleString(LOCALE, { ...TZ, day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
const time = (iso) => new Date(iso).toLocaleTimeString(LOCALE, { ...TZ, hour: 'numeric', minute: '2-digit' });

/** The shuttle on the road: A1's red. */
const RED = '#d32f2f';

const CAUSE = {
  version: t('NUS released a new version of uNivUS and stopped accepting the old one'),
  feed: t("NUS's live bus times weren't available"),
};

/**
 * The headline, the line under it, the chip and the bus on the road, from
 * /api/status.json. `checked`: when it was last checked, kept apart from the
 * rest, which is read out as it changes; that changes every check.
 */
function now(s) {
  let state = { kind: 'off', headline: t('No checks yet'), detail: '', checked: '', chip: '', bus: null };
  if (s.feed === 'up') {
    state = {
      kind: 'up',
      headline: t('Live bus times are working'),
      detail: s.since ? t('Up since {0}.', dateTime(s.since)) : '',
      chip: t('Live'),
      bus: { color: RED, far: 0.4, live: true },
    };
  } else if (s.feed === 'down' && s.cause === 'version') {
    state = {
      kind: 'down',
      headline: t('uNivUS version update'),
      detail: t(
        'Since {0}. NUS released a new version of uNivUS and stopped accepting the old one. The apps show estimated times until terminus switches to the new one.',
        dateTime(s.since),
      ),
      chip: t('Estimates only'),
      bus: { color: RED, far: 0.7, live: false },
    };
  } else if (s.feed === 'maintenance') {
    state = {
      kind: 'maintenance',
      headline: t('Night-time maintenance'),
      detail: t(
        "Since {0}. NUS's live feed isn't answering, outside the hours shuttles run (7am to 11:30pm). Not counted as an outage.",
        dateTime(s.since),
      ),
      chip: t('Maintenance'),
      bus: null,
      empty: true,
    };
  } else if (s.feed === 'down') {
    state = {
      kind: 'down',
      headline: t("NUS's live feed is down"),
      detail: t("Since {0}. The apps show estimated times until it's restored.", dateTime(s.since)),
      chip: t('Estimates only'),
      bus: { color: RED, far: 0.7, live: false },
    };
  }
  if (s.checkedAt && s.checking) state.checked = t('Last checked {0}.', time(s.checkedAt));
  else if (s.checkedAt) {
    state.detail = `${state.detail} ${t('Status checks have paused. Last check: {0}.', dateTime(s.checkedAt))}`.trim();
    state.kind = 'paused';
  }
  return state;
}

function Head({ s, failed }) {
  const head = failed
    ? { kind: 'off', headline: t("Couldn't load the status"), detail: t('Try again in a minute.'), chip: '' }
    : s
      ? now(s)
      : { kind: 'off', headline: t('Checking…'), detail: '', chip: '' };
  return html`
    <div aria-live="polite">
      <p class="eyebrow">${t('Status')}</p>
      <h1>${head.headline}</h1>
      ${head.detail && html`<p>${head.detail}</p>`}
    </div>
    ${head.checked && html`<p class="checked">${head.checked}</p>`}
    ${head.chip && html`<span class=${`sky-chip ${head.kind}`}><span class="dot"></span>${head.chip}</span>`}
  `;
}

function History({ s, failed }) {
  const m = s && month(s.incidents, Date.now());
  return html`
    ${
      m &&
      html`<div class="facts">
      <div><strong>${m.live}%</strong><small>${t('live in the last 30 days')}</small></div>
      <div><strong>${m.count}</strong><small>${m.count === 1 ? t('outage in the last 30 days') : t('outages in the last 30 days')}</small></div>
      <div><strong>${t('{0} min', 15)}</strong><small>${t('between checks')}</small></div>
    </div>`
    }
    <h2>${t('Recent outages')}</h2>
    ${!s && html`<p class="hint">${failed ? '' : t('Loading…')}</p>`}
    ${s && !s.incidents.length && html`<p class="hint">${t('None recorded.')}</p>`}
    ${
      s?.incidents.length > 0 &&
      html`<ol class="outages">
      ${s.incidents.map(
        (i) => html`
          <li key=${i.start} class=${i.end ? '' : 'ongoing-now'}>
            <div><div class="when">${dateTime(i.start)}</div><div class="what">${CAUSE[i.cause] ?? CAUSE.feed}</div></div>
            ${i.end ? html`<div class="how-long">${duration(Date.parse(i.end) - Date.parse(i.start))}</div>` : html`<div class="ongoing">${t('Ongoing')}</div>`}
          </li>
        `,
      )}
    </ol>`
    }
  `;
}

function Status() {
  const [s, setS] = useState(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const load = async () => {
      try {
        // Given up on after a while, so a hung call says it failed rather than loading for ever.
        const res = await fetch('/api/status.json', { cache: 'no-store', signal: timeout(15_000) });
        if (!res.ok) throw new Error(String(res.status));
        setS(await res.json());
        setFailed(false);
      } catch {
        setFailed(true);
      }
    };
    load();
    // Not while the page is hidden; at once when it's shown again.
    const id = setInterval(() => document.hidden || load(), 60_000);
    const shown = () => document.hidden || load();
    document.addEventListener('visibilitychange', shown);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', shown);
    };
  }, []);
  // The road under the headline: your stop's sign, and the feed's bus coming to it.
  const head = !failed && s ? now(s) : null;
  const bus = head?.bus ?? null;
  const empty = Boolean(head?.empty);
  useEffect(
    () => drawHorizon(document.getElementById('road'), { stop: true, bus, shuttle: !bus && !empty }),
    [bus?.live, Boolean(bus), empty],
  );
  useEffect(() => render(html`<${Head} s=${s} failed=${failed} />`, document.getElementById('state')), [s, failed]);
  return html`<${History} s=${s} failed=${failed} />`;
}

render(html`<${Status} />`, document.getElementById('history'));
