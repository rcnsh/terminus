// The status page: /status.json, in Singapore time, checked every minute.

import { html, render, useEffect, useState } from '/assets/ui.js';
import { t } from '/account/dom.js';

const TZ = { timeZone: 'Asia/Singapore' };
const LOCALE = window.i18n?.lang === 'zh' ? 'zh-CN' : 'en-SG';
const dateTime = (iso) => new Date(iso).toLocaleString(LOCALE, { ...TZ, day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
const time = (iso) => new Date(iso).toLocaleTimeString(LOCALE, { ...TZ, hour: 'numeric', minute: '2-digit' });

function duration(ms) {
  const m = Math.max(1, Math.round(ms / 60_000));
  if (m < 60) return t('{0} min', m);
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? t('{0} h {1} min', h, m % 60) : t('{0} h', h);
  return t('{0} days', Math.round(h / 24));
}

const CAUSE = {
  version: t('NUS released a new version of uNivUS and stopped accepting the old one'),
  feed: t("NUS's feed didn't answer"),
};

/** The headline, the line under it and the dot's colour, from /status.json. */
function now(s) {
  let dot = 'off';
  let headline = t('No checks yet');
  let detail = '';
  if (s.feed === 'up') {
    dot = '';
    headline = t('Live bus times are working');
    detail = s.since ? t('Up since {0}.', dateTime(s.since)) : '';
  } else if (s.feed === 'down') {
    dot = 'bad';
    headline = t("NUS's live feed is down");
    detail = t("Since {0}. The apps show estimated times until it's restored.", dateTime(s.since));
  }
  if (s.checkedAt) {
    const note = s.checking ? t('Last checked {0}.', time(s.checkedAt)) : t('Status checks have paused. Last check: {0}.', dateTime(s.checkedAt));
    detail = `${detail} ${note}`.trim();
    if (!s.checking) dot = 'warn';
  }
  return { dot, headline, detail };
}

function Status() {
  const [s, setS] = useState(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch('/status.json', { cache: 'no-store' });
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
  const head = failed ? { dot: 'off', headline: t("Couldn't load the status"), detail: t('Try again in a minute.') } : s ? now(s) : { dot: 'off', headline: t('Checking…'), detail: '' };
  return html`
    <div class="card now" aria-live="polite">
      <span class=${`dot ${head.dot}`.trim()}></span>
      <div><strong>${head.headline}</strong><p class="hint">${head.detail}</p></div>
    </div>
    <h2>${t('Recent outages')}</h2>
    <div class="card">
      <ul class="incidents">
        ${!s && html`<li class="hint">${failed ? '' : t('Loading…')}</li>`}
        ${s && !s.incidents.length && html`<li class="hint">${t('None recorded.')}</li>`}
        ${s?.incidents.map(
          (i) => html`
            <li key=${i.start}>
              <div><div class="when">${dateTime(i.start)}</div><div class="what">${CAUSE[i.cause] ?? CAUSE.feed}</div></div>
              ${i.end ? html`<div class="how-long">${duration(Date.parse(i.end) - Date.parse(i.start))}</div>` : html`<div class="ongoing">${t('Ongoing')}</div>`}
            </li>
          `,
        )}
      </ul>
    </div>
  `;
}

render(html`<${Status} />`, document.getElementById('status'));
