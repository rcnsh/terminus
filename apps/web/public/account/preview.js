// The answer card: /me/next drawn the way the widget shows it, on the account
// page ("Your widget right now") and on the web app's Now. Every line comes
// from the server's card (apps/api/src/card.ts); this only lays them out.

import { Rich, html, useEffect, useLayoutEffect, useRef, useState, useStore } from '../assets/ui.js';
import { api, clock, hour12, t } from './dom.js';
import { lists } from './profile.js';
import { Journey, cardStyle } from './journey.js';


/** Past the card's staleAt: its bus has gone, the plan has moved on, or it's 15 minutes old. */
export const isStale = (a) => Boolean(a?.card?.staleAt) && Date.now() >= Date.parse(a.card.staleAt);

/** The only part that ticks: "Leave now" once leave.at passes. The words are the server's (card.ts);
 *  at the stop, the bus to wait for ("D2 at 9:41"), as it is. */
const leaveHead = (a) => (a.card.phase !== 'waiting' && Date.now() >= Date.parse(a.leave.at) ? t('Leave now') : a.card.leaveBy);

/** Other trips: "Leave by 09:38 · catch the 09:41 D2 at PGP". */
const leaveText = (a) => [leaveHead(a), a.card.leaveVia].filter(Boolean).join(' · ');

/**
 * "Leaves in 3 min 12 s", ticking every second from `departsAt`, as the
 * Android and Mac apps do, so the card never shows an old "4 min". Only this
 * line re-renders each second.
 */
function Countdown({ at }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [at]);
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
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [a.leave.at]);
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

/** Where the stars sit over the night: across (0–1), down (0–1 of the room above the headline), and how bright. */
const STARS = [
  [0.06, 0.3, 0.7], [0.17, 0.62, 0.5], [0.29, 0.18, 0.8], [0.38, 0.8, 0.4], [0.47, 0.42, 0.6], [0.55, 0.1, 0.5], [0.63, 0.68, 0.45],
  [0.72, 0.28, 0.7], [0.84, 0.88, 0.4], [0.92, 0.5, 0.55], [0.11, 0.95, 0.35], [0.33, 1, 0.4], [0.58, 0.98, 0.3],
];

/** A few stars and a crescent moon. Fixed, so they never twinkle into a distraction. */
const NightSky = () => html`
  <span class="night-sky" aria-hidden="true">
    ${STARS.map(([x, y, a], i) => html`<span class="star" key=${i} style=${{ left: `${x * 100}%`, top: `${4 + y * 88}px`, opacity: a }}></span>`)}
    <span class="moon"></span>
  </span>
`;

/**
 * The page's night sky, on the web app's Now: from the top of the page down
 * to the end of `node` (the horizon under the headline and the next class;
 * app.css, body.night). The header and the chips take night colours over
 * it, and so does the browser's own bar where it has one.
 */
function useSky(node, on) {
  useLayoutEffect(() => {
    const el = node.current;
    if (!on || !el) return;
    const body = document.body;
    const place = () => body.style.setProperty('--sky-end', `${Math.round(el.getBoundingClientRect().bottom + window.scrollY)}px`);
    place();
    body.classList.add('night');
    // The browser's bar too, while Now is the tab on screen (app.js sets on-map and on-settings).
    const bar = Object.assign(document.createElement('meta'), { name: 'theme-color', content: '#121a33' });
    const tab = () => (body.classList.contains('on-map') || body.classList.contains('on-settings') ? bar.remove() : document.head.prepend(bar));
    tab();
    const tabs = new MutationObserver(tab);
    tabs.observe(body, { attributes: true, attributeFilter: ['class'] });
    const seen = new ResizeObserver(place);
    seen.observe(el);
    seen.observe(body);
    return () => {
      seen.disconnect();
      tabs.disconnect();
      bar.remove();
      body.classList.remove('night');
      body.style.removeProperty('--sky-end');
    };
  }, [on]);
}

/**
 * The hills along the horizon, more or less Kent Ridge: how far down the
 * strip (92 px) each is, `x` px across. Fixed waves in pixels, so a wider
 * page shows more hills rather than stretched ones. Android draws the same
 * (NightSky.kt).
 */
const farY = (x) => 30 + 6 * Math.sin(x / 47 + 0.6) + 4 * Math.sin(x / 19 + 2.1);
const nearY = (x) => 52 + 3 * Math.sin(x / 61 + 1.3) + 1.5 * Math.sin(x / 27);
/** The lowest point of the far hills within 40 px of `x`, where the city shows above them. */
const dip = (x) => {
  let best = x;
  for (let d = -40; d <= 40; d += 2) if (farY(x + d) > farY(best)) best = x + d;
  return best;
};
const ridge = (w, y) => {
  let d = `M0 92L0 ${y(0).toFixed(1)}`;
  for (let x = 4; x < w + 4; x += 4) d += `L${x} ${y(x).toFixed(1)}`;
  return `${d}L${w} 92Z`;
};

/**
 * Where the night sky ends: the hills, a building or two with a light still
 * on, rain trees, a flag by the road, a shuttle on it, and Marina Bay Sands
 * far off in the city. The near hill is the page's own colour, so the sky
 * meets the ground instead of fading into the page.
 */
function Horizon({ ground }) {
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ground.current;
    const seen = new ResizeObserver(() => setW(Math.round(el.clientWidth)));
    seen.observe(el);
    return () => seen.disconnect();
  }, []);
  const at = (f) => Math.round(w * f);
  const [b1, b2, bus, mbs, flag] = [at(0.18), at(0.62), at(0.58) - 19, dip(at(0.8)), at(0.3)];
  const city = farY(mbs) + 3;
  const pole = nearY(flag);
  return html`
    <div class="horizon" ref=${ground} aria-hidden="true">
      ${w > 0 &&
      html`<svg width=${w} height="92" viewBox=${`0 0 ${w} 92`}>
        <g class="city">
          ${[-13, -2, 9].map((x) => html`<path d=${`M${mbs + x} ${city}L${mbs + x + 1} ${city - 26}H${mbs + x + 5}L${mbs + x + 6} ${city}Z`} />`)}
          <path d=${`M${mbs - 15} ${city - 28}L${mbs + 25} ${city - 29.2}L${mbs + 23} ${city - 26}H${mbs - 14}Z`} />
        </g>
        <path class="far" d=${ridge(w, farY)} />
        <rect class="far" x=${b1 - 8} y=${farY(b1) - 14} width="16" height="20" />
        <rect class="lit dim" x=${b1 - 3} y=${farY(b1) - 9} width="3" height="3" />
        <rect class="far" x=${b2 - 13} y=${farY(b2) - 22} width="26" height="28" />
        <rect class="lit" x=${b2 - 5} y=${farY(b2) - 16} width="3" height="3" />
        <rect class="lit dim" x=${b2 + 3} y=${farY(b2) - 8} width="3" height="3" />
        ${[0.06, 0.45, 0.9].map((f) => {
          // A rain tree: a trunk forking low under a wide, flat crown.
          const c = at(f);
          const g = nearY(c);
          return html`<g class="tree">
            <path d=${`M${c - 1.5} ${g + 2}V${g - 7}L${c - 7} ${g - 13}H${c - 4.5}L${c} ${g - 9}L${c + 4.5} ${g - 13}H${c + 7}L${c + 1.5} ${g - 7}V${g + 2}Z`} />
            <ellipse cx=${c} cy=${g - 18} rx="21" ry="5.5" />
            <ellipse cx=${c - 8} cy=${g - 21.5} rx="11" ry="4.5" />
            <ellipse cx=${c + 8} cy=${g - 22} rx="12" ry="4.5" />
          </g>`;
        })}
        <line class="pole" x1=${flag} y1=${pole + 2} x2=${flag} y2=${pole - 24} />
        <rect class="flag-red" x=${flag + 0.6} y=${pole - 24} width="9" height="3" />
        <rect class="flag-white" x=${flag + 0.6} y=${pole - 21} width="9" height="3" />
        <path class="near" d=${ridge(w, nearY)} />
        <line class="road" x1="0" y1="70" x2=${w} y2="70" />
        <g transform=${`translate(${bus} 57)`}>
          <path class="lit beam" d="M38 6L60 3L60 11Z" />
          <rect class="bus" width="38" height="12" rx="3" />
          <rect class="stripe" y="9.5" width="38" height="2.5" rx="1" />
          ${[3, 10, 17, 24].map((x) => html`<rect class=${x === 24 ? 'lit dim' : 'lit'} x=${x} y="2.5" width="5" height="4" rx="1" />`)}
          <rect class="lit" x="32" y="2.5" width="4" height="6" rx="1" />
          <circle class="near" cx="8" cy="12" r="2" />
          <circle class="near" cx="30" cy="12" r="2" />
        </g>
      </svg>`}
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
 * where there's somewhere to show one (`onPlace`, the web app's Now). After
 * your day it's night: on Now, the page's sky; on the account page's
 * preview, a panel.
 */
function DayDone({ a, night, onPlace, children }) {
  const places = onPlace ? (a.places ?? []) : [];
  const u = a.card?.upcoming ?? null;
  // The line under the label: why today's empty on a break, or what's next when there's no card for it.
  const sub = u ? u.off : a.detail || null;
  const open = night && Boolean(onPlace);
  const ground = useRef(null);
  useSky(ground, open);
  return html`
    <div class=${open ? 'widget day-done open' : 'widget day-done'} aria-live="polite">
      <div class=${night ? 'done-panel night' : 'done-panel'}>
        ${night && html`<${NightSky} />`}
        <div class="done-label">${a.label}</div>
        ${sub && html`<div class="done-detail">${sub}</div>`}
        ${open && u && html`<${UpcomingCard} u=${u} />`}
      </div>
      ${open && html`<${Horizon} ground=${ground} />`}
      ${!open && u && html`<${UpcomingCard} u=${u} />`}
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

/** The large Android widget's row: Timetable and Nearby, then the usual places, as many as fit. */
const Chips = ({ a }) => html`
  <div class="chips">${[t('Timetable'), t('Nearby'), ...(a.places ?? []).slice(0, 2).map((p) => p.label)].map((x) => html`<span>${x}</span>`)}</div>
`;

/**
 * The card for answer `a` (from /me/next or a signal). `onAnswer` gets the
 * answer after a button; `onChoice` runs after a suggestion is answered.
 * `chips`: the widget's row of buttons under it (the account page's preview).
 * `onPlace`: a favourite tapped on Done for today (its key), in the web app.
 */
export function Card({ a, onAnswer, onChoice, onPlace = null, chips = false }) {
  const style = useStore(cardStyle);
  const actions = html`<${Actions} a=${a} onAnswer=${onAnswer} onChoice=${onChoice} />`;
  const row = chips && html`<${Chips} a=${a} />`;
  // After your day, or no classes today: said plainly, with no bus to mistake
  // for advice. "Undo" when the class just taken off was the day's last, and
  // "Back on campus".
  if (a.mode === 'rest' || a.mode === 'free') return html`<${DayDone} a=${a} night=${a.mode === 'rest'} onPlace=${onPlace}>${actions}${row}<//>`;
  // There: the same panel, plain, with where else to go.
  if (a.arrived) return html`<${DayDone} a=${a} night=${false} onPlace=${onPlace}>${actions}${row}<//>`;
  const old = isStale(a);
  // A trip by bus or on foot, in the style chosen in Settings › Appearance. Old
  // times fall through to the cards below, which say they're updating.
  if (a.card?.journey && !old && !a.arrived) {
    return html`<div class="widget" aria-live="polite"><${Phase} a=${a} /><${Journey} a=${a} style=${style} />${actions}${row}</div>`;
  }
  if (a.card?.kind === 'class' && !old) {
    return html`<div class="widget" aria-live="polite"><${Phase} a=${a} /><${ClassPlan} a=${a} />${actions}${row}</div>`;
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
      <${Phase} a=${a} />
      <div class="where">${where}</div>
      <div class="big">${big}</div>
      ${timed && !old && html`<${Countdown} at=${a.departsAt} />`}
      <div class="detail">${old ? t('Updating times…') : a.detail}</div>
      ${a.leave && a.card && !old && html`<div class="leave">${leaveText(a)}</div>`}
      ${a.timing && !old && !a.detail?.includes(a.timing.text) && html`<span class=${`ontime ${a.timing.status}`}>${a.timing.text}</span>`}
      ${notes && html`<div class="note">${notes}</div>`}
      ${actions}${row}
    </div>
  `;
}

/** A card with just a line in it: "Checking…", or why there's no answer. */
export const Message = ({ text, children, cls = 'widget' }) => html`
  <div class=${cls} aria-live="polite"><div class="detail">${text}</div>${children}</div>
`;

/**
 * "Is this wrong?": sends the answer on screen (`answer`, as it was when the
 * form was opened: the card refreshes meanwhile) with an optional note.
 */
export function Report({ answer, anonymous = false }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [msg, setMsg] = useState('');
  const [sending, setSending] = useState(false);
  const [reported, setReported] = useState(null);
  const box = useRef(null);
  useEffect(() => {
    if (open) box.current?.focus();
  }, [open]);
  const hint = anonymous
    ? t('This sends the answer above and your note. Add an email if you want a reply.')
    : t('This sends the answer above and your note, with your email address so you can get a reply.');
  const send = async (e) => {
    e.preventDefault();
    if (!reported && !note.trim()) {
      setMsg(t('Please describe the problem. The preview has no answer to attach.'));
      return;
    }
    setSending(true);
    try {
      await api('/me/feedback', { method: 'POST', body: { kind: 'wrong', note: note.trim(), platform: 'web', context: reported ?? undefined } });
      setOpen(false);
      setNote('');
      setMsg(t('Thanks for the report. It helps us improve terminus.'));
    } catch (err) {
      setMsg(err.message);
    } finally {
      setSending(false);
    }
  };
  return html`
    ${!open &&
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
    html`<form class="report" onSubmit=${send}>
      <label for="report-note"><${Rich} text=${t('What was wrong? <span class="hint">(optional)</span>')} /></label>
      <textarea
        id="report-note"
        rows="3"
        maxlength="1000"
        placeholder=${t('The D2 never came, the walk is longer than that…')}
        value=${note}
        onInput=${(e) => setNote(e.currentTarget.value)}
        ref=${box}
      ></textarea>
      <p class="hint">${hint}</p>
      <div class="actions">
        <button type="submit" class="btn small accent" disabled=${sending}>${t('Send')}</button>
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
