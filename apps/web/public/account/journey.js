// A trip by bus, drawn from the server's card.journey (apps/api/src/card.ts)
// in the card style chosen in Settings › Appearance: Route (the default),
// Ticket or Steps, as the Android app draws them. Every word and time is the
// server's; only the countdowns tick here.

import { html, store, useEffect, useState } from '../assets/ui.js';
import { clock, inkOn, t } from './dom.js';

const KEY = 'terminus-card-style';
export const STYLES = ['route', 'ticket', 'steps'];

const saved = () => {
  try {
    const v = localStorage.getItem(KEY);
    return STYLES.includes(v) ? v : 'route';
  } catch {
    return 'route';
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
    steps: t('Walk, bus and arrive, one under the other.'),
  })[s];

/**
 * "Leave in 4 min", "Leave in 1 min 5 s", "Leave in 45 s", then "Leave now".
 * At the stop it's the bus to wait for ("D2 at 4:05 PM"), as the server says
 * it. Minutes are rounded until the last two, then exact.
 */
export function leaveIn(a, j, now) {
  if (a.card.phase === 'waiting') return a.card.leaveBy ?? t('Leave now');
  const at = a.leave ? Date.parse(a.leave.at) : null;
  if (at == null || j.leave == null || now >= at) return t('Leave now');
  const left = Math.floor((at - now) / 1000);
  if (left >= 120) return t('Leave in {0} min', Math.round(left / 60));
  if (left >= 60) return t('Leave in {0} min {1} s', Math.floor(left / 60), left % 60);
  return t('Leave in {0} s', Math.max(1, left));
}

/** "by 4:01 PM" under the countdown, until it's time to go. */
const by = (a, j, now) => (a.card.phase !== 'waiting' && a.leave && j.leave && now < Date.parse(a.leave.at) ? t('by {0}', j.leave) : null);

/** "To GEA1000 @ UTown · starts 10:00": a class's start is what the arrival and slack are about. */
const to = (a, j) => [t('To {0}', j.to), a.card.kind === 'class' && a.timing ? t('starts {0}', clock(a.timing.classAt)) : null].filter(Boolean).join(' · ');

/** "Arrive 4:08 PM", with a class's "9 min early". */
const arrive = (j) => (j.arrive ? [t('Arrive {0}', j.arrive), j.slack].filter(Boolean).join(' · ') : null);

/** "Or A1 at 4:05 PM from PGP"; for a class, the sooner bus to go now on. */
const backup = (a, j) =>
  j.backup ? (a.card.kind === 'class' ? t('Or go now: {0} at {1} from {2}', j.backup.svc, j.backup.board, j.backup.stop) : t('Or {0} at {1} from {2}', j.backup.svc, j.backup.board, j.backup.stop)) : null;

/** "in 4 min" to the bus leaving, or null once it has. */
function busIn(j, now) {
  const left = Math.floor((Date.parse(j.boardAt) - now) / 1000);
  if (left <= 0) return null;
  return left >= 120 ? t('in {0} min', Math.round(left / 60)) : t('in {0} min {1} s', Math.floor(left / 60), left % 60);
}

/** A service as it's painted on the bus. */
const Badge = ({ bus, big = false }) => html`<span class=${big ? 'bus-badge big' : 'bus-badge'} style=${{ background: bus.color, color: inkOn(bus.color) }}>${bus.svc}</span>`;

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

/** The card's trip, in `style` (by default this browser's). */
export function Journey({ a, style }) {
  const j = a.card.journey;
  const now = useNow(a, j);
  const late = a.card.late ? ' late' : '';
  const body = style === 'ticket' ? Ticket : style === 'steps' ? Steps : Route;
  const small = [a.leave?.note, a.card.estimate].filter(Boolean).join(' ');
  return html`
    <div class=${`journey ${style}`}>
      <${body} a=${a} j=${j} now=${now} late=${late} />
      ${small && html`<div class="small-print">${small}</div>`}
      ${!j.live && a.card.quality && html`<div class="note">${a.card.quality}</div>`}
    </div>
  `;
}

/** Route: you, the stop and where you're going on a line, the times under each point. */
function Route({ a, j, now, late }) {
  const under = [by(a, j, now), arrive(j)].filter(Boolean).join(' · ');
  return html`
    <div class="where">${to(a, j)}</div>
    <div class=${`big${late}`}>${leaveIn(a, j, now)}</div>
    ${under && html`<div class=${`under${late}`}>${under}</div>`}
    <div class="route-line" role="img" aria-label=${routeLabel(a, j)}>
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
      <${Point} name=${j.toStop} time=${j.arrive ?? ''} />
    </div>
    <${Tags} a=${a} j=${j} />
  `;
}

/** The line read out: the same as Steps says it. */
const routeLabel = (a, j) =>
  [j.walk && `${t('Walk to {0}', j.bus.stop)} (${j.walk})`, `${j.bus.svc} ${t('from {0}', j.bus.stop)} ${j.bus.board}`, arrive(j)].filter(Boolean).join(', ');

const Point = ({ name, time, you = false }) => html`
  <div class=${you ? 'point you' : 'point'} aria-hidden="true">
    <span class="above"></span><span class="dot"></span><span class="name">${name}</span><span class="time">${time}</span>
  </div>
`;

/** Ticket: the bus first, as you'd look for it on the road, then when to leave and when you get there. */
function Ticket({ a, j, now, late }) {
  const soon = busIn(j, now);
  return html`
    <div class="where">${to(a, j)}</div>
    <div class="ticket-bus">
      <${Badge} bus=${j.bus} big />
      <div>
        <div class="ticket-time">${j.bus.board}${soon && html` <span>${soon}</span>`}</div>
        <div>${[t('from {0}', j.bus.stop), j.walk && t('{0} walk', j.walk)].filter(Boolean).join(' · ')}</div>
      </div>
    </div>
    <div class=${`ticket-go${late}`}>
      <div>
        <div class="go">${leaveIn(a, j, now)}</div>
        ${by(a, j, now) && html`<div class="by">${by(a, j, now)}</div>`}
      </div>
      ${j.arrive &&
      html`<div class="arrives">
        <div>${t('Arrive {0}', j.arrive)}</div>
        <div class=${`by${late}`}>${j.slack ?? t('at {0}', j.toStop)}</div>
      </div>`}
    </div>
    <${Tags} a=${a} j=${j} />
  `;
}

/** Steps: walk, bus, arrive, one under the other, each with its time. */
function Steps({ a, j, now, late }) {
  const head = [to(a, j), a.card.kind !== 'class' && j.arrive ? t('Arrive {0}', j.arrive) : null].filter(Boolean).join(' · ');
  const b = backup(a, j);
  return html`
    <div class="where">${head}</div>
    <div class=${`big${late}`}>${leaveIn(a, j, now)}</div>
    ${by(a, j, now) && html`<div class="countdown">${by(a, j, now)}</div>`}
    <ol class="steps">
      ${j.walk && html`<li class="first"><span class="time">${j.leave ?? t('now')}</span><span class="what">${t('Walk to {0}', j.bus.stop)}<small>${j.walk}</small></span></li>`}
      <li class=${j.walk ? '' : 'first'}>
        <span class="time">${j.bus.board}</span>
        <span class="what"
          ><span class="bus-line"><${Badge} bus=${j.bus} /> ${t('from {0}', j.bus.stop)}${j.live && html` <span class="live"><span class="dot"></span>${t('Live')}</span>`}</span
          ><small>${[t('{0} ride', j.ride), j.off && t('off at {0}', j.off)].filter(Boolean).join(' · ')}</small></span
        >
      </li>
      <li class="last">
        <span class="time">${j.arrive ?? ''}</span>
        <span class="what"><strong>${t('Arrive at {0}', j.to)}</strong>${j.slack && html`<small class=${late.trim()}>${j.slack}</small>`}</span>
      </li>
    </ol>
    ${b && html`<div class="go-now">${b}</div>`}
  `;
}

/** Live, the crowd, and the backup bus, under the trip. */
function Tags({ a, j }) {
  const b = backup(a, j);
  // The crowd is the headline bus's: a class's leave-by bus can be another.
  const crowd = a.card.kind !== 'class' ? a.card.crowd : null;
  return html`
    ${(j.live || crowd) &&
    html`<div class="tags">
      ${j.live && html`<span class="tag live"><span class="dot"></span>${t('Live')}</span>`}${crowd && html`<span class="tag">${crowd}</span>`}
    </div>`}
    ${b && html`<div class="backup">${b}</div>`}
  `;
}
