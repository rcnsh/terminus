// A stop's board, a row per service: where it's going, its next bus and the
// ones after, how full it is, or why it isn't running. Shared by the Buses
// tab (buses.js) and the map's stop sheet (map.js), so a stop reads the same
// in both.

import { Fill, Icon, MARK, html } from '/assets/ui.js';
import { clock, inkOn, serverNow, t } from '/account/dom.js';
import { campus } from '/account/profile.js';

export const colorOf = (svc) => campus.get()?.routes[svc]?.color ?? '#8a939c';
export const svcVars = (color) => `--svc:${color};--svc-ink:${inkOn(color)}`;

const SEAT = '<path d="M6 20v-5.5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2V20M8 12.5V6a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v6.5"/>';
const PEOPLE = '<circle cx="8.5" cy="7.5" r="2.8"/><circle cx="16" cy="7.5" r="2.8"/><path d="M3.5 20v-1.5a4 4 0 0 1 4-4h2a4 4 0 0 1 4 4V20M14 14.5h3a4 4 0 0 1 4 4V20"/>';

const mins = (s) => Math.max(1, Math.round(s / 60));

/** Whether a time is a guess, a timetable's or counted down from an old reading: marked "~", as the server marks it. */
const approx = (quality) => quality === 'scheduled' || quality === 'stale';

/** "~6 min", "7 min": a time worded here, from a row aged on this page (buses.js aged) or an older server, as the server words it. */
export const etaText = (etaS, quality) => (approx(quality) ? t('~{0}', t('{0} min', mins(etaS))) : t('{0} min', mins(etaS)));

/** How full the first bus is, as the feed says; nothing when it doesn't. */
export function Crowd({ crowd }) {
  if (!crowd) return null;
  const word = { low: t('Seats'), medium: t('Busy'), high: t('Packed') }[crowd];
  if (!word) return null;
  return html`<span class=${`bt-crowd ${crowd}`}><${Icon} paths=${crowd === 'low' ? SEAT : PEOPLE} />${word}</span>`;
}

/** Live, Scheduled, or a live time that has stopped updating. Nothing without a time. */
export function Quality({ r }) {
  if (r.etaS == null) return null;
  if (r.quality === 'live') return html`<span class="bt-live"><span class="dot"></span>${t('Live')}</span>`;
  if (r.quality === 'scheduled') return html`<span class="bt-sched">${t('Scheduled')}</span>`;
  if (r.quality === 'stale') return html`<span class="bt-stale">${t('Last known')}</span>`;
  return null;
}

/**
 * The big time, in the server's words (`eta`: "7 min", "~7 min", "now"),
 * its numbers large and the rest small; or why there's none. An answer
 * without `eta` (an older server) is worded here as it was.
 */
export function Big({ r }) {
  if (r.etaS == null) return html`<span class="bt-big none">${r.quality === 'unknown' ? t('No live times') : t('No time yet')}</span>`;
  if (r.eta == null && r.etaS < 60) return html`<span class="bt-big now">${t('Arriving')}</span>`;
  const parts = (r.eta ?? etaText(r.etaS, r.quality)).split(/(\d+)/).filter(Boolean);
  if (!parts.some((x) => /^\d+$/.test(x))) return html`<span class="bt-big now">${r.eta}</span>`;
  return html`<span class="bt-big">${parts.map((x) => (/^\d+$/.test(x) ? x : html`<small>${x}</small>`))}</span>`;
}

/** "then 12, ~20 min": the later buses the feed gave, a timetabled one marked, as the server words it. */
export const thenText = (r) =>
  r.laterText ?? (r.later?.length ? t('then {0} min', r.later.map((x) => (approx(x.quality) ? t('~{0}', mins(x.etaS)) : mins(x.etaS))).join(t(', '))) : '');

/** "to Central Library, Kent Vale" (the server's `toText`), the next stop in bold. */
export function Towards({ r }) {
  const to = r.towards;
  if (r.toText != null) {
    const at = to?.length ? r.toText.indexOf(to[0]) : -1;
    if (at < 0) return r.toText;
    return html`${r.toText.slice(0, at)}<b>${to[0]}</b>${r.toText.slice(at + to[0].length)}`;
  }
  // From an older server: worded here. The end of its line: nowhere further to say.
  if (!to?.length) return t('Ends here');
  const text = to.length > 1 ? t('to {0}, {1}', MARK, to[1]) : t('to {0}', MARK);
  return html`<${Fill} text=${text} parts=${[html`<b>${to[0]}</b>`]} />`;
}

export function Chip({ svc, color, paid, cls = '' }) {
  return html`<span class=${`svc-tag ${cls}`} style=${svcVars(color ?? colorOf(svc))}>${svc}${paid && html`<span class="fare" role="img" aria-label=${t('Public bus, fare applies')}>$</span>`}</span>`;
}

/** The date on campus (YYYY-MM-DD) of a moment, for "tomorrow". */
const campusDate = (ms) => new Date(ms + 8 * 3600_000).toISOString().slice(0, 10);
const WEEKDAYS = () => [t('Sunday'), t('Monday'), t('Tuesday'), t('Wednesday'), t('Thursday'), t('Friday'), t('Saturday')];

/**
 * Why a service isn't running and when it's back, from the API's `stopped`
 * and `resumesAt`: ["Stopped for today", "Back tomorrow at 7:40 am"]. The
 * second is null when the API knows no next start.
 */
export function stoppedWords(stopped, resumesAt, now = serverNow()) {
  const first = stopped === 'notYet' ? t('Not running yet') : stopped === 'noService' ? t('No service today') : t('Stopped for today');
  if (!resumesAt) return [first, null];
  const at = Date.parse(resumesAt);
  const time = clock(resumesAt);
  const day = campusDate(at);
  if (day === campusDate(now)) return [first, t('Starts at {0}', time)];
  if (day === campusDate(now + 86_400_000)) return [first, t('Back tomorrow at {0}', time)];
  return [first, t('Back {0} at {1}', WEEKDAYS()[new Date(at + 8 * 3600_000).getUTCDay()], time)];
}

/** The "opens a page" mark at a row's end (mirrored right to left, app.css). */
const NEXT = '<path d="m9 6 6 6-6 6"/>';

/**
 * How a row looks for what a tap on it does: `chevron`, it opens a page (the
 * Buses tab); `picked` set, it picks its line on the map, and true when that
 * line is the one picked there (washed in its colour, and pressed).
 */
function look(r, cls, chevron, picked) {
  const on = picked === true;
  return {
    cls: `${cls}${chevron ? ' go' : ''}${on ? ' picked' : ''}`,
    style: on ? svcVars(r.color ?? colorOf(r.svc)) : undefined,
    pressed: picked == null ? undefined : String(on),
    chev: chevron ? html`<${Icon} paths=${NEXT} class="bt-go" />` : null,
  };
}

/** A service that isn't running: greyed, saying so where the minutes go, still opening its line. */
function StoppedRow({ r, now, onPick, chevron, picked }) {
  const [first, second] = stoppedWords(r.stopped, r.resumesAt, now);
  const l = look(r, 'bt-row stopped', chevron, picked);
  // "Ends here" says nothing about a bus that isn't coming: no line then.
  return html`
    <button type="button" class=${l.cls} style=${l.style} aria-pressed=${l.pressed} onClick=${() => onPick(r.svc)}>
      <${Chip} svc=${r.svc} color=${r.color} cls="bt-chip muted" />
      <span class="bt-dir">${r.towards?.length ? html`<${Towards} r=${r} />` : ''}</span>
      <span class="bt-big none">${first}</span>
      <span class="bt-meta">${second}</span>
      ${l.chev}
    </button>
  `;
}

/**
 * A service's row on a board. Tapped, `onPick(svc)`: the Buses tab opens its
 * line (`chevron`, which says so), the map picks it (`picked`: whether it's
 * the line picked there). A public bus has no line here. `now`, on the
 * server's clock, says "tomorrow" for a service that isn't running.
 */
export function Row({ r, now = serverNow(), onPick, chevron = false, picked }) {
  if (r.running === false) return html`<${StoppedRow} r=${r} now=${now} onPick=${onPick} chevron=${chevron} picked=${picked} />`;
  // Due within the minute: tinted on the Buses tab. Not on the map, where a
  // tinted row is the line picked there; the big minutes say it's soon.
  const soon = picked == null && r.etaS != null && r.etaS < 60 && r.quality === 'live';
  const cls = `bt-row${soon ? ' soon' : ''}${r.old ? ' old' : ''}`;
  const body = html`
    <${Chip} svc=${r.svc} color=${r.color} paid=${r.paid} cls="bt-chip" />
    <span class="bt-dir"><${Towards} r=${r} /></span>
    <${Big} r=${r} />
    <span class="bt-meta"><${Quality} r=${r} /><${Crowd} crowd=${r.crowd} /></span>
    <span class="bt-then">${thenText(r)}</span>
  `;
  if (r.paid) return html`<div class=${cls}>${body}</div>`;
  const l = look(r, cls, chevron, picked);
  return html`<button type="button" class=${l.cls} style=${l.style} aria-pressed=${l.pressed} onClick=${() => onPick(r.svc)}>${body}${l.chev}</button>`;
}
