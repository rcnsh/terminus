// The answer card: /me/next drawn the way the widget shows it, on the account
// page ("Your widget right now") and on the web app's Now. Every line comes
// from the server's card (apps/api/src/card.ts); this only lays them out.

import { html, useEffect, useRef, useState, useStore } from '../assets/ui.js';
import { api, clock, hour12, t } from './dom.js';
import { lists } from './profile.js';
import { Journey, cardStyle } from './journey.js';
import { Celestial, Horizon, NightSky } from './sky.js';

/** Past the card's staleAt: its bus has gone, the plan has moved on, or it's 15 minutes old. */
export const isStale = (a) => Boolean(a?.card?.staleAt) && Date.now() >= Date.parse(a.card.staleAt);

/** The only part that ticks: "Leave now" once leave.at passes. The words are the server's (card.ts);
 *  at the stop, the bus to wait for ("D2 at 9:41"), as it is. */
const leaveHead = (a) => (a.card.phase !== 'waiting' && Date.now() >= Date.parse(a.leave.at) ? t('Leave now') : a.card.leaveBy);

/** Other trips: "Leave by 09:38 · catch the 09:41 D2 at PGP". */
const leaveText = (a) => [leaveHead(a), a.card.leaveVia].filter(Boolean).join(' · ');

/** The time now, ticking every second; started afresh when `from` changes. */
function useEverySecond(from) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [from]);
  return now;
}

/**
 * "Leaves in 3 min 12 s", ticking every second from `departsAt`, as the
 * Android and Mac apps do, so the card never shows an old "4 min". Only this
 * line re-renders each second.
 */
function Countdown({ at }) {
  const now = useEverySecond(at);
  const left = Math.floor((Date.parse(at) - now) / 1000);
  const text =
    left > 60 ? t('Leaves in {0} min {1} s', Math.floor(left / 60), left % 60)
    : left > 0 ? t('Leaves in {0} s', left)
    : t('Left {0} min ago · updating', Math.floor((-left + 59) / 60));
  return html`<div class=${left > 0 ? 'countdown' : 'countdown gone'}>${text}</div>`;
}

/** Sends a card's button (Not going, Undo, …) and returns the answer that comes back. */
export const signal = (body) => api(`/me/signal${hour12() ? '?h12=1' : ''}`, { method: 'POST', body });

/**
 * "Leave by 6:36" and, under it, the one countdown on the card ("in 8 min"),
 * ticking every second so the headline turns into "Leave now" on time.
 */
function LeaveBy({ a, late }) {
  const now = useEverySecond(a.leave.at);
  // At the stop the headline is the bus and its time: nothing to count down to.
  const left = a.card.phase === 'waiting' ? 0 : Math.floor((Date.parse(a.leave.at) - now) / 1000);
  return html`
    <div class=${`big${late}`}>${leaveHead(a)}</div>
    ${left > 0 && html`<div class="countdown">${left >= 120 ? t('in {0} min', Math.round(left / 60)) : t('in {0} min {1} s', Math.floor(left / 60), left % 60)}</div>`}
  `;
}

/**
 * A class: when to leave is the headline with one countdown under it, then
 * the bus that goes with it and when it gets you there, and everything else
 * (a busy bus, an estimate, "or go now") quietly underneath. Same lines as
 * the apps, because they all come from the server's card.
 */
function ClassPlan({ a }) {
  const c = a.card;
  const late = c.late ? ' late' : '';
  return html`
    <div class="where">${`${a.dest.label} · ${t('starts {0}', clock(a.timing.classAt))}`}</div>
    <${LeaveBy} a=${a} late=${late} />
    <div class=${`catch${late}`}>${c.catch}</div>
    ${c.arrive && html`<div class=${`arrive${late}`}>${c.arrive}</div>`}
    ${(c.note || c.estimate) && html`<div class="small-print">${[c.note, c.estimate].filter(Boolean).join(' ')}</div>`}
    ${c.goNow && html`<div class="go-now">${c.goNow}</div>`}
  `;
}

/** Where the trip is (the same phase the phone and the Mac show), a last-bus
 *  warning, and the notice while NUS's live times are down. */
function Phase({ a }) {
  const c = a.card ?? {};
  return html`
    ${c.notice && html`<div class="notice">${c.notice}</div>`}
    ${c.phaseText && html`<div class="phase">${c.phaseText}</div>`}
    ${c.ride && html`<${Ride} ride=${c.ride} />`}
    ${c.warning && html`<div class="warning">${c.warning}</div>`}
  `;
}

/**
 * On the bus: how far along the ride, and the next stop, as the phone's live
 * notification shows. Stops are taken as evenly spaced between boarding and
 * getting off; redrawn every few seconds.
 */
function Ride({ ride }) {
  const [now, setNow] = useState(Date.now());
  const board = Date.parse(ride.board);
  const arrive = Date.parse(ride.arrive);
  useEffect(() => {
    if (now >= arrive) return;
    const timer = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(timer);
  }, [ride.board, ride.arrive]);
  const hops = ride.stops.length - 1;
  const done = Math.min(1, Math.max(0, (now - board) / Math.max(1, arrive - board)));
  const passed = Math.floor(done * hops);
  const next = ride.stops[passed + 1]?.name;
  const left = Math.max(0, hops - passed);
  const off = ride.stops[hops].name;
  const text = !next || left === 0 ? t('Getting off at {0}', off) : left === 1 ? t('Next: {0}, where you get off', off) : t('Next: {0} · {1} stops to go', next, left);
  return html`
    <div class="ride">
      <progress max="100" value=${Math.round(done * 100)} aria-label=${t('Ride progress')}></progress>
      <div class="detail">${text}</div>
    </div>
  `;
}

/** A button that's disabled while what it started is under way, and again if that fails. */
function Busy({ onClick, class: cls, children, ...props }) {
  const [busy, setBusy] = useState(false);
  return html`
    <button
      type="button"
      class=${cls}
      disabled=${busy}
      onClick=${async () => {
        setBusy(true);
        try {
          await onClick();
        } catch {
          // Left for another try.
        } finally {
          setBusy(false);
        }
      }}
      ...${props}
    >${children}</button>
  `;
}

/**
 * The server's buttons, plans only (Not going, Not on campus today, Undo):
 * nothing asks what happened. A tap sends the signal; `onAnswer` gets the
 * answer that comes back.
 */
function Actions({ a, onAnswer, onChoice }) {
  const list = a.card?.actions ?? [];
  return html`
    ${list.length > 0 &&
    html`<div class="actions">
      ${list.map(
        (x, i) => html`<${Busy}
          key=${x.id}
          class=${`btn small ${i === 0 && x.id !== 'skipped' && x.id !== 'reset' ? 'accent' : 'ghost'}`}
          onClick=${async () => onAnswer(await signal({ kind: x.id, trip: x.trip }))}
        >${x.label}<//>`,
      )}
    </div>`}
    <${Suggestion} a=${a} onChoice=${onChoice} />
  `;
}

/** "Leave one bus earlier for CS2030?": what terminus has learned, offered, never applied by itself. */
function Suggestion({ a, onChoice }) {
  const s = a.card?.suggestion ?? null;
  if (!s) return null;
  const choose = (choice) => async () => {
    await api('/me/choice', { method: 'POST', body: { id: s.id, choice } });
    // Settings lists the choices made.
    lists.set((n) => n + 1);
    onChoice?.();
  };
  return html`
    <div class="suggestion">
      <div>${s.text}</div>
      <div class="actions">
        <${Busy} class="btn small accent" onClick=${choose('accept')}>${s.accept}<//>
        <${Busy} class="btn small ghost" onClick=${choose('dismiss')}>${s.dismiss}<//>
      </div>
    </div>
  `;
}

/** The next class on a card of its own: when in the accent, what, then where. */
const UpcomingCard = ({ u }) => html`
  <div class="upcoming">
    <p class="eyebrow">${u.when}</p>
    <strong>${u.title}</strong>
    <span>${u.where}</span>
  </div>
`;

/**
 * The day's done, or there's nothing to catch: the label large, what's next
 * on a card of its own, then your favourites to plan a trip to instead,
 * where there's somewhere to show one (`onPlace`, the web app's Now). On
 * Now (`sky`) the words are up in the page's sky, above the horizon, the
 * favourites on the ground, under the hour's sky. On the account page's
 * preview it's a panel, the night's after your day.
 */
function DayDone({ a, night, sky, onPlace, children }) {
  const places = onPlace ? (a.places ?? []) : [];
  const u = a.card?.upcoming ?? null;
  // The line under the label: why today's empty on a break, or what's next when there's no card for it.
  const sub = u ? u.off : a.detail || null;
  return html`
    <div class=${sky ? 'widget day-done open' : 'widget day-done'} aria-live="polite">
      <div class=${sky ? 'done-panel sky-head' : night ? 'done-panel night' : 'done-panel'}>
        ${sky ? html`<${Celestial} />` : night && html`<${NightSky} />`}
        <div class="done-label">${a.label}</div>
        ${sub && html`<div class="done-detail">${sub}</div>`}
        ${sky && u && html`<${UpcomingCard} u=${u} />`}
      </div>
      ${sky && html`<${Horizon} />`}
      ${!sky && u && html`<${UpcomingCard} u=${u} />`}
      ${places.length > 0 && html`<p class="eyebrow going">${t('Going somewhere anyway?')}</p>`}
      ${places.length > 0 &&
      html`<div class="place-tiles">
        ${places.map(
          (x) => html`<button type="button" class="place-tile" key=${x.key} onClick=${() => onPlace(x.key)}><strong>${x.label}</strong><span>${t('Plan a trip')}</span></button>`,
        )}
      </div>`}
      ${onPlace && !places.length && html`<p class="hint done-hint">${night ? t('No buses are shown until your day starts. Tap Nearby to check anyway.') : t('Tap Nearby for buses around you.')}</p>`}
      ${children}
    </div>
  `;
}

/**
 * On Now (`sky`), `top` up in the page's sky with the sun or the stars over
 * it, then the horizon; elsewhere `top` as it is.
 */
export const InSky = ({ sky, children }) =>
  sky ? html`<div class="sky-head"><${Celestial} />${children}</div><${Horizon} />` : children;

/** The large Android widget's row: Timetable and Nearby, then the usual places, as many as fit. */
const Chips = ({ a }) => html`
  <div class="chips">${[t('Timetable'), t('Nearby'), ...(a.places ?? []).slice(0, 2).map((p) => p.label)].map((x) => html`<span>${x}</span>`)}</div>
`;

/**
 * The card for answer `a` (from /me/next or a signal). `onAnswer` gets the
 * answer after a button; `onChoice` runs after a suggestion is answered.
 * `chips`: the widget's row of buttons under it (the account page's preview).
 * `onPlace`: a favourite tapped on Done for today (its key), in the web app.
 * `sky`: on the web app's Now, where the card's top is in the page's sky
 * and the rest on the ground below the horizon (sky.js).
 */
export function Card({ a, onAnswer, onChoice, onPlace = null, chips = false, sky = false }) {
  const style = useStore(cardStyle);
  const actions = html`<${Actions} a=${a} onAnswer=${onAnswer} onChoice=${onChoice} />`;
  const row = chips && html`<${Chips} a=${a} />`;
  // After your day, or no classes today: said plainly, with no bus to mistake
  // for advice. "Undo" when the class just taken off was the day's last, and
  // "Back on campus".
  if (a.mode === 'rest' || a.mode === 'free') return html`<${DayDone} a=${a} night=${a.mode === 'rest'} sky=${sky} onPlace=${onPlace}>${actions}${row}<//>`;
  // There: the same panel, plain, with where else to go.
  if (a.arrived) return html`<${DayDone} a=${a} night=${false} sky=${sky} onPlace=${onPlace}>${actions}${row}<//>`;
  const old = isStale(a);
  // A trip by bus or on foot, in the style chosen in Settings › Appearance. Old
  // times fall through to the cards below, which say they're updating.
  if (a.card?.journey && !old && !a.arrived) {
    return html`<div class="widget" aria-live="polite"><${Journey} a=${a} style=${style} sky=${sky} lead=${html`<${Phase} a=${a} />`} />${actions}${row}</div>`;
  }
  if (a.card?.kind === 'class' && !old) {
    return html`<div class="widget" aria-live="polite"><${InSky} sky=${sky}><${Phase} a=${a} /><${ClassPlan} a=${a} /><//>${actions}${row}</div>`;
  }
  const where =
    a.mode === 'nearby' ? t('Nearby') : a.dest?.why === 'class' ? t('Next class · {0}', a.dest.label) : a.dest?.why === 'gap-home' ? t('Long gap · {0}', a.dest.label) : (a.dest?.label ?? t('Next bus'));
  // A departure as a clock time, the way the widget shows it, so it can't go stale.
  const svc = a.label.split(' · ')[0];
  const timed = a.departsAt && a.quality !== 'unknown' && a.quality !== 'ended';
  const big = timed ? `${svc} · ${a.quality === 'scheduled' ? t('~{0}', clock(a.departsAt)) : clock(a.departsAt)}` : a.label;
  // The crowd only when the detail line doesn't already say it ("· crowding: high ·").
  const crowd = a.card?.crowd && !a.detail?.toLowerCase().includes(a.card.crowd.toLowerCase()) ? a.card.crowd : null;
  const notes = [a.card?.quality, crowd].filter(Boolean).join(' · ');
  return html`
    <div class=${old ? 'widget old' : 'widget'} aria-live="polite">
      <${InSky} sky=${sky}>
        <${Phase} a=${a} />
        <div class="where">${where}</div>
        <div class="big">${big}</div>
        ${timed && !old && html`<${Countdown} at=${a.departsAt} />`}
        <div class="detail">${old ? t('Updating times…') : a.detail}</div>
        ${a.leave && a.card && !old && html`<div class="leave">${leaveText(a)}</div>`}
        ${a.timing && !old && !a.detail?.includes(a.timing.text) && html`<span class=${`ontime ${a.timing.status}`}>${a.timing.text}</span>`}
      <//>
      ${notes && html`<div class="note">${notes}</div>`}
      ${actions}${row}
    </div>
  `;
}

/** A card with just a line in it: "Checking…", or why there's no answer. */
export const Message = ({ text, children, cls = 'widget' }) => html`
  <div class=${cls} aria-live="polite"><div class="detail">${text}</div>${children}</div>
`;

/** How long "✓ Reported, thanks" stays before "Is this wrong?" comes back. */
const REPORTED_SHOWN_MS = 6_000;

/**
 * "Is this wrong?": sends the answer on screen (`answer`, as it was when the
 * form was opened: the card refreshes meanwhile) with a note, which it needs.
 * Once sent, the link says so in its place for a few seconds, or until the
 * card says something else; give it a new `key` for a new answer. Without an
 * email the server takes no reports, so the link asks for one instead
 * (`onAddEmail`, the web app's way there by default).
 */
export function Report({ answer, anonymous = false, onAddEmail = () => location.assign('/account/?add=1&next=/app/') }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [msg, setMsg] = useState('');
  const [sending, setSending] = useState(false);
  const [reported, setReported] = useState(null);
  // The card's line when the report went ("Leave by ~09:36 · R2 from PGP"); null when not just sent.
  const [done, setDone] = useState(null);
  const box = useRef(null);
  useEffect(() => {
    if (open) box.current?.focus();
  }, [open]);
  const line = answer?.card?.line ?? '';
  // The line now, for when the send returns: the card may have refreshed meanwhile.
  const lineNow = useRef(line);
  lineNow.current = line;
  // The tick is a moment's acknowledgement, then the link is back for the next answer.
  useEffect(() => {
    if (done === null) return;
    if (line !== done) {
      setDone(null);
      return;
    }
    const id = setTimeout(() => setDone(null), REPORTED_SHOWN_MS);
    return () => clearTimeout(id);
  }, [done, line]);
  const send = async (e) => {
    e.preventDefault();
    if (!note.trim()) return box.current?.focus();
    setSending(true);
    try {
      await api('/me/feedback', { method: 'POST', body: { kind: 'wrong', note: note.trim(), platform: 'web', context: reported ?? undefined } });
      setOpen(false);
      setNote('');
      setDone(lineNow.current);
    } catch (err) {
      setMsg(err.message);
    } finally {
      setSending(false);
    }
  };
  return html`
    ${done !== null && html`<span class="report-done">✓ ${t('Reported, thanks')}</span>`}
    ${!open &&
    done === null &&
    html`<button
      type="button"
      class="link-btn report-open"
      onClick=${() => {
        setReported(answer);
        setMsg('');
        setOpen(true);
      }}
    >${t('Is this wrong?')}</button>`}
    ${open &&
    anonymous &&
    html`<div class="report">
      <p class="hint">${t('Add an email to report a wrong answer, so we can reply to you.')}</p>
      <div class="actions">
        <button type="button" class="btn small accent" onClick=${onAddEmail}>${t('Add an email')}</button>
        <button type="button" class="btn small ghost" onClick=${() => setOpen(false)}>${t('Cancel')}</button>
      </div>
    </div>`}
    ${open &&
    !anonymous &&
    html`<form class="report" onSubmit=${send}>
      <label for="report-note">${t('What was wrong?')}</label>
      <textarea
        id="report-note"
        rows="3"
        maxlength="1000"
        placeholder=${t('The D2 never came, the walk is longer than that…')}
        value=${note}
        onInput=${(e) => setNote(e.currentTarget.value)}
        ref=${box}
        required
      ></textarea>
      <p class="hint">${t('This sends the answer above and your note, with your email address so you can get a reply.')}</p>
      <div class="actions">
        <button type="submit" class="btn small accent" disabled=${sending || !note.trim()}>${t('Send')}</button>
        <button
          type="button"
          class="btn small ghost"
          onClick=${() => {
            setOpen(false);
            setNote('');
          }}
        >${t('Cancel')}</button>
      </div>
    </form>`}
    <p class="hint" role="status">${msg}</p>
  `;
}
