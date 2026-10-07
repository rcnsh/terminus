// A trip by bus, or on foot the whole way, drawn from the server's
// card.journey (apps/api/src/card.ts) in the card style chosen in Settings ›
// Appearance: Steps (the default), Route or Ticket, as the Android app draws
// them. Every word and time is the server's; only the countdowns tick here.

import { Fill, Icon, MARK, html, store, useEffect, useState } from '../assets/ui.js';
import { clock, inkOn, t } from './dom.js';
import { Celestial, Horizon } from './sky.js';

const KEY = 'terminus-card-style';
export const STYLES = ['steps', 'route', 'ticket'];
const DEFAULT = 'steps';

const saved = () => {
  try {
    const v = localStorage.getItem(KEY);
    return STYLES.includes(v) ? v : DEFAULT;
  } catch {
    return DEFAULT;
  }
};

/** This browser's card style; the card redraws when Settings changes it. */
export const cardStyle = store(saved());

export function setCardStyle(style) {
  try {
    localStorage.setItem(KEY, style);
  } catch {
    // Private mode: it holds until the page is closed.
  }
  cardStyle.set(style);
}

/** Each style's name and what it is, for Settings. */
export const styleName = (s) => ({ route: t('Route'), ticket: t('Ticket'), steps: t('Steps') })[s];
export const styleHint = (s) =>
  ({
    route: t('The whole trip as a line, with the times under it.'),
    ticket: t('The bus first, in its colour, then when to leave.'),
    steps: t('The trip as a line down the card, as on a route map.'),
  })[s];

/** Whole seconds until it's time to leave, or null once it is (or with no time to leave by). */
function secondsToLeave(a, j, now) {
  const at = a.leave ? Date.parse(a.leave.at) : null;
  if (at == null || j.leave == null || now >= at) return null;
  return Math.floor((at - now) / 1000);
}

/**
 * "Leave in 4 min", "Leave in 1 min 5 s", "Leave in 45 s", then "Leave now".
 * At the stop it's the bus to wait for ("D2 at 4:05 PM"), as the server says
 * it. Minutes are rounded until the last two, then exact.
 */
export function leaveIn(a, j, now) {
  if (a.card.phase === 'waiting') return a.card.leaveBy ?? t('Leave now');
  const left = secondsToLeave(a, j, now);
  if (left === null) return t('Leave now');
  if (left >= 120) return t('Leave in {0} min', Math.round(left / 60));
  if (left >= 60) return t('Leave in {0} min {1} s', Math.floor(left / 60), left % 60);
  return t('Leave in {0} s', Math.max(1, left));
}

/**
 * The time in "Leave in 4 min" alone ("4 min"), drawn in the accent, or null
 * for "Leave now" and at the stop. web-i18n.test.js checks each is inside its
 * headline in Chinese too.
 */
function leaveTime(a, j, now) {
  if (a.card.phase === 'waiting') return null;
  const left = secondsToLeave(a, j, now);
  if (left === null) return null;
  if (left >= 120) return t('{0} min', Math.round(left / 60));
  if (left >= 60) return t('{0} min {1} s', Math.floor(left / 60), left % 60);
  return t('{0} s', Math.max(1, left));
}

/**
 * "Leave in 4 min" on one line, the time in the accent and the rest in ink,
 * so the number reads first without being a size of its own. "Leave now" is
 * all accent; late, all red.
 */
function LeaveHead({ a, j, now, late }) {
  const text = leaveIn(a, j, now);
  const time = leaveTime(a, j, now);
  const at = time ? text.indexOf(time) : -1;
  if (late || at < 0) return html`<div class=${`lead${late || (time ? '' : ' go')}`}>${text}</div>`;
  return html`<div class="lead">${text.slice(0, at)}<span class="go">${time}</span>${text.slice(at + time.length)}</div>`;
}

/** "by 4:01 PM" under the countdown, until it's time to go. */
const by = (a, j, now) => (a.card.phase !== 'waiting' && a.leave && j.leave && now < Date.parse(a.leave.at) ? t('by {0}', j.leave) : null);

/** "To GEA1000 @ UTown · starts 10:00": a class's start is what the arrival and slack are about. */
const to = (a, j) => [t('To {0}', j.to), a.card.kind === 'class' && a.timing ? t('starts {0}', clock(a.timing.classAt)) : null].filter(Boolean).join(' · ');

/** "Arrive 4:08 PM", with a class's "9 min early". */
const arrive = (j) => (j.arrive ? [t('Arrive {0}', j.arrive), j.slack].filter(Boolean).join(' · ') : null);

/** "Or A1 at 4:05 PM from PGP"; for a class, the sooner bus to go now on. On foot, the bus it beats: "D1 would be 16 min". */
const backup = (a, j) =>
  !j.bus ? j.why : j.backup ? (a.card.kind === 'class' ? t('Or go now: {0} at {1} from {2}', named(j.backup), j.backup.board, j.backup.stop) : t('Or {0} at {1} from {2}', named(j.backup), j.backup.board, j.backup.stop)) : null;

/** "in 4 min" to the bus leaving, or null once it has (or on foot, with no bus). */
function busIn(j, now) {
  if (!j.boardAt) return null;
  const left = Math.floor((Date.parse(j.boardAt) - now) / 1000);
  if (left <= 0) return null;
  return left >= 120 ? t('in {0} min', Math.round(left / 60)) : t('in {0} min {1} s', Math.floor(left / 60), left % 60);
}

/** The crowd is the headline bus's: a class's leave-by bus can be another. */
const crowdOf = (a) => (a.card.kind !== 'class' ? a.card.crowd : null);

/** "Live" with its dot, then how busy the bus is, as tags. */
const LiveTags = ({ live, crowd }) => html`${live && html`<span class="tag live"><span class="dot"></span>${t('Live')}</span>`}${crowd && html`<span class="tag">${crowd}</span>`}`;

/** The service as painted on the bus; a public bus (with a fare) carries a $ so the fare is never a surprise. */
const Badge = ({ bus, big = false }) => html`<span class=${big ? 'bus-badge big' : 'bus-badge'} style=${{ background: bus.color, color: inkOn(bus.color) }}>${bus.svc}${bus.paid ? html`<span class="fare" role="img" aria-label=${t('Public bus, fare applies')}>$</span>` : ''}</span>`;
/** The service in running text: "95 ($)" for a public bus. */
const named = (bus) => (bus.paid ? `${bus.svc} ($)` : bus.svc);

/** Someone walking, for a trip on foot where a bus would have its badge. */
const WALKER =
  '<circle cx="13" cy="4" r="2" fill="currentColor"/><path d="M12 8l-2 6-3 7M10 14l3 3v4M7 12l2-4h3l2 3 3 1" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>';
const WalkBadge = () => html`<span class="bus-badge big walk"><${Icon} paths=${WALKER} size="34" /></span>`;

/** Now, every second near the end (so "Leave in 45 s" is never a stale 45), else every 15. */
function useNow(a, j) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const soon = [a.leave?.at, j.boardAt].filter(Boolean).map(Date.parse).filter((x) => x > now);
    const next = soon.length ? Math.min(...soon) : null;
    const id = setTimeout(() => setNow(Date.now()), next != null && next - now < 150_000 ? 1_000 : 15_000);
    return () => clearTimeout(id);
  }, [now, a.leave?.at, j.boardAt]);
  return now;
}

/** Seconds until your bus reaches your stop, or 0 with no time. */
const dueIn = (j, now) => (j.boardAt ? Math.floor((Date.parse(j.boardAt) - now) / 1000) : 0);

/**
 * Your bus on the horizon's road (sky.js): coming up to your stop's sign,
 * nearer the sooner it's due. Nothing on foot.
 */
function onTheRoad(j, now) {
  if (!j.bus) return {};
  return { stop: true, bus: { color: j.bus.color, live: j.live, far: Math.max(0, dueIn(j, now)) / 900 } };
}

/**
 * The horizon's road in words, on the ground under it at the page's size:
 * your bus and when it reaches your stop ("about" for a timetable guess),
 * the stop's name in bold.
 */
function RoadLine({ j, now }) {
  const left = dueIn(j, now);
  const n = Math.round(left / 60);
  const text =
    left <= 0 ? t('from {0}', MARK) : left < 60 ? t('arriving at {0}', MARK) : j.live ? t('reaches {0} in {1} min', MARK, n) : t('reaches {0} in about {1} min', MARK, n);
  return html`<div class="road-line"><${Badge} bus=${j.bus} /><span><${Fill} text=${text} parts=${[html`<strong>${j.bus.stop}</strong>`]} /></span></div>`;
}

/**
 * The card's trip, in `style` (by default this browser's), with `lead` (where
 * the trip is, a notice) first. With `sky`, on the web app's Now, the top
 * of it is up in the page's sky and the horizon under it has your bus on
 * its way to your stop; the steps are on the ground.
 */
export function Journey({ a, style, sky = false, lead = null }) {
  const j = a.card.journey;
  const now = useNow(a, j);
  const late = a.card.late ? ' late' : '';
  const body = style === 'ticket' ? Ticket : style === 'steps' ? Steps : Route;
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
    </div>
  `;
}

/** Where you're going, short enough for the end of a line: "GEA1000", not "GEA1000 @ UTown". */
const place = (j) => j.to.split(' @ ')[0];

/** Route: you, the stop and where you're going on a line, the times under each point. */
function Route({ a, j, now, late, top }) {
  const under = [by(a, j, now), arrive(j)].filter(Boolean).join(' · ');
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

/** On foot: you and where you're going, the walk between. */
const WalkLine = ({ j }) => html`
  <div class="route-line" role="img" aria-label=${routeLabel(null, j)}>
    <${Point} name=${t('You')} time=${j.leave ?? t('now')} you />
    <div class="stretch walk"><span class="above"></span><span class="bar"></span><span class="takes">${j.walk}</span></div>
    <${Point} name=${place(j)} time=${j.arrive ?? ''} />
  </div>
`;

/** By bus: you, the stop, where you get off, and the walk on to the place. */
function BusLine({ a, j }) {
  return html`
    <div class=${j.walkEnd ? 'route-line walk-on' : 'route-line'} role="img" aria-label=${routeLabel(a, j)}>
      ${j.walk &&
      html`
        <${Point} name=${t('You')} time=${j.leave ?? t('now')} you />
        <div class="stretch walk"><span class="above"></span><span class="bar"></span><span class="takes">${j.walk}</span></div>
      `}
      <${Point} name=${j.bus.stop} time=${j.bus.board} />
      <div class="stretch ride">
        <span class="above"><${Badge} bus=${j.bus} /></span>
        <span class="bar" style=${{ background: j.bus.color }}></span>
        <span class="takes">${j.ride}</span>
      </div>
      <${Point} name=${j.toStop} time=${(j.walkEnd ? j.arriveStop : j.arrive) ?? ''} />
      ${j.walkEnd &&
      html`
        <div class="stretch walk"><span class="above"></span><span class="bar"></span><span class="takes">${j.walkEnd}</span></div>
        <${Point} name=${place(j)} time=${j.arrive ?? ''} />
      `}
    </div>
  `;
}

/** The line read out: the same as Steps says it. */
const routeLabel = (a, j) =>
  !j.bus
    ? [`${t('Walk to {0}', place(j))} (${j.walk})`, arrive(j)].filter(Boolean).join(', ')
    : [j.walk && `${t('Walk to {0}', j.bus.stop)} (${j.walk})`, `${named(j.bus)} ${t('from {0}', j.bus.stop)} ${j.bus.board}`, j.walkEnd && `${t('Walk to {0}', place(j))} (${j.walkEnd})`, arrive(j)]
    .filter(Boolean)
    .join(', ');

const Point = ({ name, time, you = false }) => html`
  <div class=${you ? 'point you' : 'point'} aria-hidden="true">
    <span class="above"></span><span class="dot"></span><span class="name">${name}</span><span class="time">${time}</span>
  </div>
`;

/** Ticket: the bus first, as you'd look for it on the road, then when to leave and when you get there. On foot, the walk in its place. */
function Ticket({ a, j, now, late, top }) {
  const soon = busIn(j, now);
  return html`
    ${top(html`
    <div class="where">${to(a, j)}</div>
    ${j.bus
      ? html`<div class="ticket-bus">
          <${Badge} bus=${j.bus} big />
          <div>
            <div class="ticket-time">${j.bus.board}${soon && html` <span>${soon}</span>`}</div>
            <div>${[t('from {0}', j.bus.stop), j.walk && t('{0} walk', j.walk)].filter(Boolean).join(' · ')}</div>
          </div>
        </div>`
      : html`<div class="ticket-bus">
          <${WalkBadge} />
          <div>
            <div class="ticket-time">${t('{0} walk', j.walk)}</div>
            <div>${j.why ?? t('Walk to {0}', place(j))}</div>
          </div>
        </div>`}
    <div class=${`ticket-go${late}`}>
      <div>
        <div class="go">${leaveIn(a, j, now)}</div>
        ${by(a, j, now) && html`<div class="by">${by(a, j, now)}</div>`}
      </div>
      ${j.arrive &&
      html`<div class="arrives">
        <div>${t('Arrive {0}', j.arrive)}</div>
        <div class=${`by${late}`}>${j.slack ?? (j.walkEnd ? t('{0} walk from {1}', j.walkEnd, j.toStop) : t('at {0}', j.toStop))}</div>
      </div>`}
    </div>
    `)}
    ${j.bus && html`<${Tags} a=${a} j=${j} />`}
  `;
}

/**
 * Steps: the trip as a line diagram, as on a bus's route map. Each point has
 * its time on the left and a dot on the line; between them the walk is
 * dotted and the ride is drawn in the bus's colour; the last point, where
 * you're going, is ringed in the accent. On foot the whole way, the walk runs
 * straight from leaving to the place.
 */
function Steps({ a, j, now, late, top }) {
  const b = backup(a, j);
  const under = [by(a, j, now), j.slack].filter(Boolean).join(' · ');
  const crowd = crowdOf(a);
  const soon = busIn(j, now);
  return html`
    ${top(html`
      <div class="where">${to(a, j)}</div>
      <${LeaveHead} a=${a} j=${j} now=${now} late=${late} />
      ${(under || j.live || crowd) &&
      html`<div class="steps-under">
        ${under && html`<span class=${`under${late}`}>${under}</span>`}
        <${LiveTags} live=${j.live} crowd=${crowd} />
      </div>`}
    `)}
    <ol class="line">
      ${j.walk &&
      html`<${LinePoint} time=${j.leave ?? t('now')} dot="start" line="walk" below=${t('{0} walk', j.walk)}><strong>${t('Leave')}</strong><//>`}
      ${j.bus &&
      html`<${LinePoint}
        time=${j.bus.board}
        dot=${j.walk ? 'stop' : 'start'}
        line="ride"
        color=${j.bus.color}
        below=${[j.ride && t('{0} ride', j.ride), j.off && t('off at {0}', j.off)].filter(Boolean).join(' · ')}
        ><span class="bus-line"><strong>${j.bus.stop}</strong><${Badge} bus=${j.bus} />${soon && html`<small>${soon}</small>`}</span><//
      >`}
      ${j.bus && j.walkEnd && html`<${LinePoint} time=${j.arriveStop ?? ''} dot="stop" line="walk" below=${t('{0} walk', j.walkEnd)}><strong>${j.toStop}</strong><//>`}
      <${LinePoint} time=${j.arrive ?? ''} dot="end" late=${Boolean(late)}><strong>${!j.bus || j.walkEnd ? place(j) : j.toStop}</strong><//>
    </ol>
    ${b && html`<div class="backup-box">${b}</div>`}
  `;
}

/**
 * One point on the line: its time, its dot (`start` filled, `stop` a ring,
 * `end` the accent's ring), what's there, and what's under it (the walk or
 * the ride on to the next point, drawn as the `line` below the dot).
 */
const LinePoint = ({ time, dot, line = null, color = null, below = '', late = false, children }) => html`
  <li class=${['pt', dot, line, late ? 'late' : ''].filter(Boolean).join(' ')} style=${color ? { '--ride': color } : undefined}>
    <span class="time">${time}</span>
    <span class="rail" aria-hidden="true"></span>
    <span class="what">${children}${below && html`<small>${below}</small>`}</span>
  </li>
`;

/** Live, the crowd, and the backup bus, under the trip. */
function Tags({ a, j }) {
  const b = backup(a, j);
  const crowd = crowdOf(a);
  return html`
    ${(j.live || crowd) &&
    html`<div class="tags">
      <${LiveTags} live=${j.live} crowd=${crowd} />
    </div>`}
    ${b && html`<div class="backup">${b}</div>`}
  `;
}
