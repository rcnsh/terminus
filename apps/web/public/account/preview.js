// The answer card: /me/next drawn the way the widget shows it, on the account
// page ("Your widget right now") and on the web app's Now. Every line comes
// from the server's card (apps/api/src/card.ts); this only lays them out.

import { Icon, Rich, html, useEffect, useRef, useState } from '../assets/ui.js';
import { api, clock, t } from './dom.js';
import { lists } from './profile.js';

const MOON = '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" fill="currentColor"/>';
/** This browser shows 12-hour times: ask for the card in that style. */
export const HOUR12 = new Intl.DateTimeFormat([], { hour: 'numeric' }).resolvedOptions().hour12 === true;

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
export const signal = (body) => api(`/me/signal${HOUR12 ? '?h12=1' : ''}`, { method: 'POST', body });

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
 * (a packed bus, an estimate, "or go now") quietly underneath. Same lines as
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
    ${c.warning && html`<div class="warning">${c.warning}</div>`}
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

/** The large Android widget's row: Timetable and Nearby, then the usual places, as many as fit. */
const Chips = ({ a }) => html`
  <div class="chips">${[t('Timetable'), t('Nearby'), ...(a.places ?? []).slice(0, 2).map((p) => p.label)].map((x) => html`<span>${x}</span>`)}</div>
`;

/**
 * The card for answer `a` (from /me/next or a signal). `onAnswer` gets the
 * answer after a button; `onChoice` runs after a suggestion is answered.
 * `chips`: the widget's row of buttons under it (the account page's preview).
 */
export function Card({ a, onAnswer, onChoice, chips = false }) {
  const actions = html`<${Actions} a=${a} onAnswer=${onAnswer} onChoice=${onChoice} />`;
  const row = chips && html`<${Chips} a=${a} />`;
  if (a.mode === 'rest') {
    return html`
      <div class="widget" aria-live="polite">
        <div class="rest"><${Icon} paths=${MOON} size="22" /><div class="big">${a.label}</div></div>
        <div class="detail">${a.detail}</div>
        ${actions}${row}
      </div>
    `;
  }
  if (a.mode === 'free') {
    // No classes today: said plainly, with no bus to mistake for advice. "Undo"
    // when the class just taken off was the day's last, and "Back on campus".
    return html`
      <div class="widget" aria-live="polite">
        <div class="big">${a.label}</div>
        <div class="detail">${a.detail}</div>
        ${actions}${row}
      </div>
    `;
  }
  const old = isStale(a);
  if (a.card?.kind === 'class' && !old) {
    return html`<div class="widget" aria-live="polite"><${Phase} a=${a} /><${ClassPlan} a=${a} />${actions}${row}</div>`;
  }
  const where =
    a.mode === 'nearby' ? t('Nearby') : a.dest?.why === 'class' ? t('Next class · {0}', a.dest.label) : a.dest?.why === 'gap-home' ? t('Long gap · {0}', a.dest.label) : (a.dest?.label ?? t('Next bus'));
  // A departure as a clock time, the way the widget shows it, so it can't go stale.
  const svc = a.label.split(' · ')[0];
  const timed = a.departsAt && a.quality !== 'unknown' && a.quality !== 'ended';
  const big = timed ? `${svc} · ${a.quality === 'scheduled' ? t('~{0}', clock(a.departsAt)) : clock(a.departsAt)}` : a.label;
  // The crowd only when the detail line doesn't already say it ("· packed ·").
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
