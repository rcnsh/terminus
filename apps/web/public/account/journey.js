import { Fill, MARK, html, store, useEffect, useState } from '../assets/ui.js';
import { clock, inkOn, sentences, serverNow, t } from './dom.js';
import { Celestial, Horizon } from './sky.js';

const KEY = 'terminus-card-style';
export const STYLES = ['steps', 'route'];
const DEFAULT = 'steps';

const saved = () => {
  try {
    const v = localStorage.getItem(KEY);
    return STYLES.includes(v) ? v : DEFAULT;
  } catch {
    return DEFAULT;
  }
};

export const cardStyle = store(saved());

export function setCardStyle(style) {
  try {
    localStorage.setItem(KEY, style);
  } catch {}
  cardStyle.set(style);
}

export const styleName = (s) => ({ route: t('Route'), steps: t('Steps') })[s];
export const styleHint = (s) =>
  ({
    route: t('The whole trip as a line, with the times under it.'),
    steps: t('The trip as a line down the card, as on a route map.'),
  })[s];

export function secondsToLeave(a, j, now) {
  if (a.card.phase === 'waiting') return null;
  const at = a.leave ? Date.parse(a.leave.at) : null;
  if (at == null || j.leave == null || now >= at) return null;
  return Math.floor((at - now) / 1000);
}

export function leaveIn(a, j, now) {
  if (a.card.phase === 'waiting') return a.card.leaveBy ?? t('Leave now');
  const left = secondsToLeave(a, j, now);
  if (left === null) return t('Leave now');
  if (left >= 120) return t('Leave in {0} min', Math.round(left / 60));
  if (left >= 60) return t('Leave in {0} min {1} s', Math.floor(left / 60), left % 60);
  return t('Leave in {0} s', Math.max(1, left));
}

export function leaveTime(a, j, now) {
  if (a.card.phase === 'waiting') return null;
  const left = secondsToLeave(a, j, now);
  if (left === null) return null;
  if (left >= 120) return t('{0} min', Math.round(left / 60));
  if (left >= 60) return t('{0} min {1} s', Math.floor(left / 60), left % 60);
  return t('{0} s', Math.max(1, left));
}

function LeaveHead({ a, j, now, late }) {
  const text = leaveIn(a, j, now);
  const time = leaveTime(a, j, now);
  const at = time ? text.indexOf(time) : -1;
  if (late || at < 0) return html`<h2 class=${`lead${late || (time ? '' : ' go')}`}>${text}</h2>`;
  return html`<h2 class="lead">${text.slice(0, at)}<span class="go">${time}</span>${text.slice(at + time.length)}</h2>`;
}

export function spokenJourney(a, now) {
  const j = a.card.journey;
  const left = secondsToLeave(a, j, now);
  const head =
    a.card.phase === 'waiting' || left === null
      ? leaveIn(a, j, now)
      : left < 600
        ? t('Leave in {0} min', Math.max(1, Math.round(left / 60)))
        : (a.card.leaveBy ?? t('Leave in {0} min', Math.round(left / 300) * 5));
  const bus = j.bus ? `${named(j.bus)} ${t('from {0}', j.bus.stop)} ${j.bus.board}` : walkText(j);
  return sentences([to(a, j), head, bus, j.change?.changeText, j.change && secondBus(j.change), a.card.late ? arrive(j) : null]);
}

export const said = (j, key, old) => (j[key] !== undefined ? j[key] : old());

export const by = (a, j, now) =>
  a.card.phase !== 'waiting' && a.leave && j.leave && now < Date.parse(a.leave.at) ? said(j, 'byText', () => t('by {0}', j.leave)) : null;

export const to = (a, j) =>
  said(j, 'title', () => [t('To {0}', j.to), a.card.kind === 'class' && a.timing ? startsAt(a) : null].filter(Boolean).join(' · '));

export const startsAt = (a) => t(a.dest?.place ? 'arrive by {0}' : 'starts {0}', clock(a.timing.classAt));

export const arrive = (j) =>
  said(j, 'arriveText', () => (j.arrive ? [t('Arrive {0}', j.arrive), j.slack].filter(Boolean).join(' · ') : null));

export const arriveWhere = (j) =>
  said(j, 'arriveWhere', () => (j.walkEnd ? t('{0} walk from {1}', j.walkEnd, j.toStop) : t('at {0}', j.toStop)));

export const walkText = (j) => said(j, 'walkText', () => (j.walk ? t('{0} walk', j.walk) : null));
export const walkEndText = (j) => said(j, 'walkEndText', () => (j.walkEnd ? t('{0} walk', j.walkEnd) : null));

export const rideText = (j) =>
  said(j, 'rideText', () => [j.ride && t('{0} ride', j.ride), j.off && t('off at {0}', j.off)].filter(Boolean).join(' · ') || null);

export const backup = (a, j) =>
  said(j, 'backupText', () =>
    !j.bus
      ? j.why
      : j.backup
        ? a.card.kind === 'class'
          ? t('Or go now: {0} at {1} from {2}', named(j.backup), j.backup.board, j.backup.stop)
          : t('Or {0} at {1} from {2}', named(j.backup), j.backup.board, j.backup.stop)
        : null,
  );

export function busIn(j, now) {
  if (!j.boardAt) return null;
  const left = Math.floor((Date.parse(j.boardAt) - now) / 1000);
  if (left <= 0) return null;
  if (left >= 120) return t('in {0} min', Math.round(left / 60));
  return left >= 60 ? t('in {0} min {1} s', Math.floor(left / 60), left % 60) : t('in {0} s', left);
}

const crowdOf = (a) => (a.card.kind !== 'class' ? a.card.crowd : null);

const LiveTags = ({ live, crowd }) =>
  html`${live && html`<span class="tag live"><span class="dot"></span>${t('Live')}</span>`}${crowd && html`<span class="tag">${crowd}</span>`}`;

const Badge = ({ bus }) =>
  html`<span class="bus-badge" style=${{ background: bus.color, color: inkOn(bus.color) }}>${bus.svc}${bus.paid ? html`<span class="fare" role="img" aria-label=${t('Public bus, fare applies')}>$</span>` : ''}</span>`;
const named = (bus) => (bus.paid ? `${bus.svc} ($)` : bus.svc);
const secondBus = (c) => `${named(c.bus)} ${t('from {0}', c.stop)} ${c.bus.board}`;

function useNow(a, j) {
  const [now, setNow] = useState(serverNow());
  useEffect(() => {
    const soon = [a.leave?.at, j.boardAt]
      .filter(Boolean)
      .map(Date.parse)
      .filter((x) => x > now);
    const next = soon.length ? Math.min(...soon) : null;
    const id = setTimeout(() => setNow(serverNow()), next != null && next - now < 150_000 ? 1_000 : 15_000);
    return () => clearTimeout(id);
  }, [now, a.leave?.at, j.boardAt]);
  return now;
}

const dueIn = (j, now) => (j.boardAt ? Math.floor((Date.parse(j.boardAt) - now) / 1000) : 0);

function onTheRoad(j, now) {
  if (!j.bus) return {};
  return { stop: true, bus: { color: j.bus.color, live: j.live, far: Math.max(0, dueIn(j, now)) / 900 } };
}

export function roadWords(j, left, stop) {
  const n = Math.max(1, Math.round(left / 60));
  if (left <= 0) return t('from {0}', stop);
  if (!j.live) return t('reaches {0} in about {1} min', stop, n);
  return left < 60 ? t('arriving at {0}', stop) : t('reaches {0} in {1} min', stop, n);
}

function RoadLine({ j, now }) {
  const text = roadWords(j, dueIn(j, now), MARK);
  return html`<div class="road-line"><${Badge} bus=${j.bus} /><span><${Fill} text=${text} parts=${[html`<strong>${j.bus.stop}</strong>`]} /></span></div>`;
}

export function Journey({ a, style, sky = false, lead = null, steps = null }) {
  const j = a.card.journey;
  const now = useNow(a, j);
  const late = a.card.late ? ' late' : '';
  const body = style === 'route' ? Route : Steps;
  const small = [a.leave?.note, a.card.estimate].filter(Boolean).join(' ');
  const top = (head) =>
    sky
      ? html`<div class="sky-head"><${Celestial} />${lead}${head}</div><${Horizon} ...${onTheRoad(j, now)} shuttle=${false} />${j.bus && html`<${RoadLine} j=${j} now=${now} />`}`
      : html`${lead}${head}`;
  return html`
    <div class=${`journey ${style}`}>
      <${body} a=${a} j=${j} now=${now} late=${late} top=${top} />
      ${small && html`<div class="small-print">${small}</div>`}
      ${j.bus && !j.live && a.card.quality && html`<div class="note">${a.card.quality}</div>`}
      ${steps}
    </div>
  `;
}

const place = (j) => j.place ?? j.to.split(' @ ')[0];

function Route({ a, j, now, late, top }) {
  const under = [by(a, j, now), j.change && walkText(j), arrive(j)].filter(Boolean).join(' · ');
  return html`
    ${top(html`
      <div class="where">${to(a, j)}</div>
      <${LeaveHead} a=${a} j=${j} now=${now} late=${late} />
      ${under && html`<div class=${`under${late}`}>${under}</div>`}
    `)}
    ${j.bus ? html`<${BusLine} a=${a} j=${j} />` : html`<${WalkLine} j=${j} />`}
    <${Tags} a=${a} j=${j} />
  `;
}

const WalkLine = ({ j }) => html`
  <div class="route-line" role="img" aria-label=${routeLabel(null, j)}>
    <${Point} name=${t('You')} time=${j.leave ?? t('now')} you />
    <div class="stretch walk"><span class="above"></span><span class="bar"></span><span class="takes">${j.walk}</span></div>
    <${Point} name=${place(j)} time=${j.arrive ?? ''} />
  </div>
`;

function BusLine({ a, j }) {
  return html`
    <div class=${j.walkEnd ? 'route-line walk-on' : 'route-line'} role="img" aria-label=${routeLabel(a, j)}>
      ${
        j.walk &&
        !j.change &&
        html`
        <${Point} name=${t('You')} time=${j.leave ?? t('now')} you />
        <div class="stretch walk"><span class="above"></span><span class="bar"></span><span class="takes">${j.walk}</span></div>
      `
      }
      <${Point} name=${j.bus.stop} time=${j.bus.board} />
      <${RideStretch} bus=${j.bus} takes=${j.change ? j.change.firstRide : j.ride} />
      ${j.change && html`<${ChangeStretch} c=${j.change} />`}
      <${Point} name=${j.toStop} time=${(j.walkEnd ? j.arriveStop : j.arrive) ?? ''} />
      ${
        j.walkEnd &&
        html`
        <div class="stretch walk"><span class="above"></span><span class="bar"></span><span class="takes">${j.walkEnd}</span></div>
        <${Point} name=${place(j)} time=${j.arrive ?? ''} />
      `
      }
    </div>
  `;
}

const RideStretch = ({ bus, takes }) => html`
  <div class="stretch ride">
    <span class="above"><${Badge} bus=${bus} /></span>
    <span class="bar" style=${{ background: bus.color }}></span>
    <span class="takes">${takes}</span>
  </div>
`;

const ChangeStretch = ({ c }) => html`
  <${Point} name=${c.from} time=${c.walk ? c.reach : c.bus.board} />
  ${
    c.walk &&
    html`
    <div class="stretch walk"><span class="above"></span><span class="bar"></span><span class="takes">${c.walk}</span></div>
    <${Point} name=${c.stop} time=${c.bus.board} />
  `
  }
  <${RideStretch} bus=${c.bus} takes=${c.ride} />
`;

const routeLabel = (a, j) =>
  !j.bus
    ? [`${t('Walk to {0}', place(j))} (${walkText(j) ?? j.walk})`, arrive(j)].filter(Boolean).join(', ')
    : [
        j.walk && `${t('Walk to {0}', j.bus.stop)} (${j.walk})`,
        `${named(j.bus)} ${t('from {0}', j.bus.stop)} ${j.bus.board}`,
        j.change?.changeText,
        j.change && secondBus(j.change),
        j.walkEnd && `${t('Walk to {0}', place(j))} (${j.walkEnd})`,
        arrive(j),
      ]
        .filter(Boolean)
        .join(', ');

const Point = ({ name, time, you = false }) => html`
  <div class=${you ? 'point you' : 'point'} aria-hidden="true">
    <span class="above"></span><span class="dot"></span><span class="name">${name}</span><span class="time">${time}</span>
  </div>
`;

function Steps({ a, j, now, late, top }) {
  const b = backup(a, j);
  const under = [by(a, j, now), j.slack].filter(Boolean).join(' · ');
  const crowd = crowdOf(a);
  const soon = busIn(j, now);
  return html`
    ${top(html`
      <div class="where">${to(a, j)}</div>
      <${LeaveHead} a=${a} j=${j} now=${now} late=${late} />
      ${
        (under || j.live || crowd) &&
        html`<div class="steps-under">
        ${under && html`<span class=${`under${late}`}>${under}</span>`}
        <${LiveTags} live=${j.live} crowd=${crowd} />
      </div>`
      }
    `)}
    <ol class="line">
      ${
        j.walk &&
        html`<${LinePoint} time=${j.leave ?? t('now')} dot="start" line="walk" below=${walkText(j)}><strong>${t('Leave')}</strong><//>`
      }
      ${
        j.bus &&
        html`<${LinePoint}
        time=${j.bus.board}
        dot=${j.walk ? 'stop' : 'start'}
        line="ride"
        color=${j.bus.color}
        below=${j.change ? j.change.firstRideText : (rideText(j) ?? '')}
        ><span class="bus-line"><strong>${j.bus.stop}</strong><${Badge} bus=${j.bus} />${soon && html`<small>${soon}</small>`}</span><//
      >`
      }
      ${
        j.change &&
        html`<${LinePoint} time=${j.change.bus.board} dot="stop" line="ride" color=${j.change.bus.color} below=${[j.change.changeText, j.change.rideText].join(' · ')}
        ><span class="bus-line"><strong>${j.change.stop}</strong><${Badge} bus=${j.change.bus} /></span><//
      >`
      }
      ${j.bus && j.walkEnd && html`<${LinePoint} time=${j.arriveStop ?? ''} dot="stop" line="walk" below=${walkEndText(j)}><strong>${j.toStop}</strong><//>`}
      <${LinePoint} time=${j.arrive ?? ''} dot="end" late=${Boolean(late)}><strong>${!j.bus || j.walkEnd ? place(j) : j.toStop}</strong><//>
    </ol>
    ${
      b &&
      html`<p class="backup-line">
      <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4.5" y="3" width="15" height="15" rx="3"/><path d="M4.5 11h15M8 21v-3M16 21v-3"/><circle cx="8.5" cy="14.5" r="1" fill="currentColor"/><circle cx="15.5" cy="14.5" r="1" fill="currentColor"/></svg
      ><span>${b}</span>
    </p>`
    }
  `;
}

const LinePoint = ({ time, dot, line = null, color = null, below = '', late = false, children }) => html`
  <li class=${['pt', dot, line, late ? 'late' : ''].filter(Boolean).join(' ')} style=${color ? { '--ride': color } : undefined}>
    <span class="time">${time}</span>
    <span class="rail" aria-hidden="true"></span>
    <span class="what">${children}${below && html`<small>${below}</small>`}</span>
  </li>
`;

function Tags({ a, j }) {
  const b = backup(a, j);
  const crowd = crowdOf(a);
  return html`
    ${
      (j.live || crowd) &&
      html`<div class="tags">
      <${LiveTags} live=${j.live} crowd=${crowd} />
    </div>`
    }
    ${b && html`<div class="backup">${b}</div>`}
  `;
}
