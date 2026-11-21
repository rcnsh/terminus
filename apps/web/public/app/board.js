import { Bar, Icon, html, widthOf } from '/assets/ui.js';
import { clock, inkOn, serverNow, t } from '/account/dom.js';
import { campus } from '/account/profile.js';

export const colorOf = (svc) => campus.get()?.routes[svc]?.color ?? '#8a939c';
export const svcVars = (color) => `--svc:${color};--svc-ink:${inkOn(color)}`;

const SEAT = '<path d="M6 20v-5.5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2V20M8 12.5V6a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v6.5"/>';
const PEOPLE =
  '<circle cx="8.5" cy="7.5" r="2.8"/><circle cx="16" cy="7.5" r="2.8"/><path d="M3.5 20v-1.5a4 4 0 0 1 4-4h2a4 4 0 0 1 4 4V20M14 14.5h3a4 4 0 0 1 4 4V20"/>';

const mins = (s) => Math.max(1, Math.round(s / 60));

const approx = (quality) => quality === 'scheduled' || quality === 'stale';

export const etaText = (etaS, quality) => (approx(quality) ? t('~{0}', t('{0} min', mins(etaS))) : t('{0} min', mins(etaS)));

export function Crowd({ crowd }) {
  if (!crowd) return null;
  const word = { low: t('Seats'), medium: t('Busy'), high: t('Packed') }[crowd];
  if (!word) return null;
  return html`<span class=${`bt-crowd ${crowd}`}><${Icon} paths=${crowd === 'low' ? SEAT : PEOPLE} />${word}</span>`;
}

export function Quality({ r }) {
  if (r.etaS == null) return null;
  if (r.quality === 'live') return html`<span class="bt-live"><span class="dot"></span>${t('Live')}</span>`;
  if (r.quality === 'scheduled') return html`<span class="bt-sched">${t('Estimate')}</span>`;
  if (r.quality === 'stale') return html`<span class="bt-stale">${t('Last known')}</span>`;
  return null;
}

export function Big({ r }) {
  if (r.etaS == null) return html`<span class="bt-big none">${r.quality === 'unknown' ? t('No live times') : t('No time yet')}</span>`;
  const parts = (r.eta ?? etaText(r.etaS, r.quality)).split(/(\d+)/).filter(Boolean);
  if (!parts.some((x) => /^\d+$/.test(x))) return html`<span class="bt-big now">${r.eta}</span>`;
  return html`<span class="bt-big">${parts.map((x) => (/^\d+$/.test(x) ? x : html`<small>${x}</small>`))}</span>`;
}

const minutesSaid = (s) => (Math.round(s / 60) === 1 ? t('1 minute') : t('{0} minutes', Math.round(s / 60)));

export function saidRow(b) {
  const end = b.towards?.at(-1);
  const where = b.dest ? b.dest.replaceAll('\u00a0', ' ') : end ? t('to {0}', end) : b.toText;
  const buses = [b, b.later?.[0], b.later?.[1]].map((bus, i) => {
    if (bus?.etaS == null) return null;
    if (bus.quality === 'live' && bus.etaS < 45) return i ? t('then {0}', t('Arriving')) : t('Arriving');
    const m = minutesSaid(Math.max(bus.etaS, bus.quality === 'live' ? 0 : 60));
    const w = approx(bus.quality)
      ? i === 0 && bus.quality === 'scheduled'
        ? t('about {0}, estimated', m)
        : t('about {0}', m)
      : i === 0
        ? t('{0}, live', m)
        : m;
    return i ? t('then {0}', w) : w;
  });
  return [b.paid ? t('Public bus {0}, fare applies', b.svc) : t('Bus {0}', b.svc), where, ...buses.filter(Boolean)].join(t(', '));
}

export const THEN_MAX = 2;

export const thenText = (r) =>
  r.laterText ??
  (r.later?.length
    ? t(
        'then {0} min',
        r.later
          .slice(0, THEN_MAX)
          .map((x) => (approx(x.quality) ? t('~{0}', mins(x.etaS)) : mins(x.etaS)))
          .join(t(', ')),
      )
    : '');

export function Dest({ r }) {
  return r.towards.at(-1) ?? t('Ends here');
}

const NextStop = ({ r }) => (r.towards?.length === 2 ? html`<span class="bt-next">${t('Next stop {0}', r.towards[0])}</span>` : null);

export const LiveDot = () => html`<span class="dot bt-dot" role="img" aria-label=${t('Live')}></span>`;

export function Chip({ svc, color, paid, cls = '' }) {
  return html`<span class=${`svc-tag ${cls}`} style=${svcVars(color ?? colorOf(svc))}>${svc}${paid && html`<span class="fare" role="img" aria-label=${t('Public bus, fare applies')}>$</span>`}</span>`;
}

const campusDate = (ms) => new Date(ms + 8 * 3600_000).toISOString().slice(0, 10);
const WEEKDAYS = () => [t('Sunday'), t('Monday'), t('Tuesday'), t('Wednesday'), t('Thursday'), t('Friday'), t('Saturday')];

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

export const NEXT = '<path d="m9 6 6 6-6 6"/>';
export const STAR = '<path d="m12 3.5 2.6 5.4 5.9.8-4.3 4.1 1 5.9L12 16.9l-5.2 2.8 1-5.9-4.3-4.1 5.9-.8z"/>';

function look(r, cls, chevron, picked) {
  const on = picked === true;
  return {
    cls: `${cls}${chevron ? ' go' : ''}${on ? ' picked' : ''}`,
    style: on ? svcVars(r.color ?? colorOf(r.svc)) : undefined,
    pressed: picked == null ? undefined : String(on),
    chev: chevron ? html`<${Icon} paths=${NEXT} class="bt-go" />` : null,
  };
}

function StoppedRow({ r, now, onPick, chevron, picked }) {
  const [first, second] = stoppedWords(r.stopped, r.resumesAt, now);
  const body = html`
    <${Chip} svc=${r.svc} color=${r.color} paid=${r.paid} cls="bt-chip" />
    <span class="bt-dir">${r.towards?.length ? html`<${Dest} r=${r} />` : ''}</span>
    <span class="bt-big none">${first}</span>
    <span class="bt-meta">${second}</span>
  `;
  if (r.paid) return html`<div class="bt-row stopped">${body}</div>`;
  const l = look(r, 'bt-row stopped', chevron, picked);
  return html`<button type="button" class=${l.cls} style=${l.style} aria-pressed=${l.pressed} onClick=${() => onPick(r.svc)}>${body}${l.chev}</button>`;
}

export function Row({ r, now = serverNow(), onPick, chevron = false, picked }) {
  if (r.running === false) return html`<${StoppedRow} r=${r} now=${now} onPick=${onPick} chevron=${chevron} picked=${picked} />`;
  const cls = `bt-row run${r.old ? ' old' : ''}`;
  const live = r.quality === 'live' && r.etaS != null;
  const body = html`
    <${Chip} svc=${r.svc} color=${r.color} paid=${r.paid} cls="bt-chip" />
    <span class="bt-text">
      <span class="bt-dir"><${Dest} r=${r} /></span>
      <span class="bt-meta"><${NextStop} r=${r} />${!live && html`<${Quality} r=${r} />`}<${Crowd} crowd=${r.crowd} /></span>
    </span>
    <span class="bt-at">${live && html`<${LiveDot} />`}<${Big} r=${r} /></span>
    <span class="bt-then">${thenText(r)}</span>
  `;
  if (r.paid) return html`<div class=${cls}>${body}</div>`;
  const l = look(r, cls, chevron, picked);
  return html`<button type="button" class=${l.cls} style=${l.style} aria-pressed=${l.pressed} onClick=${() => onPick(r.svc)}>${body}${l.chev}</button>`;
}

export const WaitingRows = ({ services, n = 3, chevron = false }) =>
  (services?.length ? services : Array.from({ length: n }, () => null)).map(
    (svc, i) => html`
      <div class=${`bt-row run${chevron ? ' go' : ''}`} key=${svc ?? i}>
        ${svc ? html`<${Chip} svc=${svc} cls="bt-chip" />` : html`<span class="svc-tag bt-chip sk"></span>`}
        <span class="bt-text"><span class="bt-dir"><${Bar} w=${widthOf(['62%', '48%', '56%', '42%'], i)} /></span><span class="bt-meta"><${Bar} w="6.5rem" /><span class="sk round sk-pill"></span></span></span>
        <span class="bt-at"><span class="bt-big"><${Bar} w=${widthOf(['3.4rem', '3rem', '3.8rem'], i)} h="0.62em" /></span></span>
        <span class="bt-then"><${Bar} w="5.5rem" /></span>
        ${chevron && html`<${Icon} paths=${NEXT} class="bt-go sk-go" />`}
      </div>
    `,
  );

export const ServicesSkeleton = ({ n = 6 }) => html`
  <div class="card bt-services">
    ${Array.from(
      { length: n },
      (_, i) => html`<div class="bt-service" key=${i}>
        <span class="bt-service-chip"><span class="svc-tag bt-chip sk"></span></span>
        <span class="bt-service-text"
          ><span class="bt-service-name"><${Bar} w=${widthOf(['70%', '58%', '64%', '52%', '66%', '60%'], i)} /></span
          ><span class="bt-service-via"><${Bar} w=${widthOf(['50%', '62%', '44%', '56%', '48%', '40%'], i)} /></span
        ></span>
        <span class="bt-out"><${Bar} w="2.8rem" /></span>
        <${Icon} paths=${NEXT} class="bt-go sk-go" />
      </div>`,
    )}
  </div>
`;
