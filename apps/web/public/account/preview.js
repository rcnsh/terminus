// "Your widget right now": /me/next rendered the way the widget shows it.
// Every line comes from the server's card (apps/api/src/card.ts).

import { $, api, clock, el } from './dom.js';

const MOON = '<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';
/** This browser shows 12-hour times: ask for the card in that style. */
const HOUR12 = new Intl.DateTimeFormat([], { hour: 'numeric' }).resolvedOptions().hour12 === true;

/** Dim once the server's staleAt passes: the bus has left, the plan moved on, or it's 15 minutes old. */
const isOld = (a) => Boolean(a.card?.staleAt) && Date.now() >= Date.parse(a.card.staleAt);

/** The only part that ticks: "Leave now" once leave.at passes. The words are the server's (card.ts). */
const leaveHead = (a) => (Date.now() >= Date.parse(a.leave.at) ? 'Leave now' : a.card.leaveBy);

/** Other trips: "Leave by 09:38 · catch the 09:41 D2 at PGP". */
const leaveText = (a) => [leaveHead(a), a.card.leaveVia].filter(Boolean).join(' · ');

/**
 * A class: when to leave is the headline, the bus that goes with it and when
 * it gets you there underneath, and the next bus as "or go now". Same lines
 * as the apps, because they all come from the server's card.
 */
function classPlan(a) {
  const c = a.card;
  const late = c.late ? ' late' : '';
  return [
    el('div', { class: 'where', textContent: `${a.dest.label} · starts ${clock(a.timing.classAt)}` }),
    el('div', { class: `big${late}`, textContent: leaveHead(a) }),
    el('div', { class: `catch${late}`, textContent: c.catch }),
    c.arrive ? el('div', { class: `arrive${late}`, textContent: c.arrive }) : null,
    c.note ? el('div', { class: 'crowd-note', textContent: c.note }) : null,
    c.estimate ? el('div', { class: 'note', textContent: c.estimate }) : null,
    c.goNow ? el('div', { class: 'go-now', textContent: c.goNow }) : null,
  ].filter(Boolean);
}

/** The answer on screen, sent with an "Is this wrong?" report. */
let shown = null;

/**
 * Where the trip is (the same phase the phone and the Mac show), a last-bus
 * warning, and the server's buttons. A click sends the signal and redraws
 * with the answer that comes back.
 */
function phaseParts(a) {
  const c = a.card ?? {};
  const parts = [];
  if (c.phaseText) parts.push(el('div', { class: 'phase', textContent: c.phaseText }));
  if (c.warning) parts.push(el('div', { class: 'warning', textContent: c.warning }));
  return parts;
}

function actions(a) {
  // From the bus's departure: the question, in place of the usual buttons.
  const ask = a.card?.ask ?? null;
  const list = ask ? ask.actions : (a.card?.actions ?? []);
  if (!list.length) return suggestion(a);
  const buttons = el(
    'div',
    { class: 'actions' },
    ...list.map((x, i) =>
      el('button', {
        type: 'button',
        class: `btn small ${i === 0 && x.id !== 'skipped' && x.id !== 'reset' ? 'accent' : 'ghost'}`,
        textContent: x.label,
        onclick: async (e) => {
          e.target.disabled = true;
          try {
            show(await api(`/me/signal${HOUR12 ? '?h12=1' : ''}`, { method: 'POST', body: { kind: x.id, trip: x.trip } }));
          } catch {
            e.target.disabled = false;
          }
        },
      }),
    ),
  );
  return el('div', {}, ask ? el('div', { class: 'ask', textContent: ask.question }) : '', buttons, suggestion(a) ?? '');
}

/** "Leave one bus earlier for CS2030?": what terminus has learned, offered, never applied by itself. */
function suggestion(a) {
  const s = a.card?.suggestion ?? null;
  if (!s) return null;
  const choose = (choice) => async (e) => {
    e.target.disabled = true;
    try {
      await api('/me/choice', { method: 'POST', body: { id: s.id, choice } });
      document.dispatchEvent(new CustomEvent('trip-choices'));
      renderPreview();
    } catch {
      e.target.disabled = false;
    }
  };
  return el(
    'div',
    { class: 'suggestion' },
    el('div', { textContent: s.text }),
    el(
      'div',
      { class: 'actions' },
      el('button', { type: 'button', class: 'btn small accent', textContent: s.accept, onclick: choose('accept') }),
      el('button', { type: 'button', class: 'btn small ghost', textContent: s.dismiss, onclick: choose('dismiss') }),
    ),
  );
}

/** Renders /me/next the way the widget does, so settings changes show up. */
export async function renderPreview() {
  const box = $('#preview');
  let a;
  try {
    a = await api(`/me/next${HOUR12 ? '?h12=1' : ''}`);
  } catch {
    shown = null;
    box.replaceChildren(
      el('div', { class: 'detail', textContent: 'Preview unavailable right now.' }),
      el('button', { type: 'button', class: 'link-btn', textContent: 'Try again', onclick: renderPreview }),
    );
    return;
  }
  show(a);
}

/** Draws an answer (from /me/next, a signal, or the web app's cache) into #preview. */
export function show(a) {
  const box = $('#preview');
  shown = a;
  const chips = a.places?.length ? el('div', { class: 'chips' }, ...a.places.slice(0, 3).map((p) => el('span', { textContent: p.label })), el('span', { textContent: 'Nearby' })) : null;
  if (a.mode === 'rest') {
    const head = el('div', { class: 'rest' });
    head.innerHTML = MOON; // a constant, never data
    head.append(el('div', { class: 'big', textContent: a.label }));
    box.className = 'widget';
    // replaceChildren prints a null as the text "null": no places, no chips.
    box.replaceChildren(head, el('div', { class: 'detail', textContent: a.detail }), chips ?? '');
    return;
  }
  if (a.mode === 'free') {
    // No classes today: said plainly, with no bus to mistake for advice.
    box.className = 'widget';
    box.replaceChildren(el('div', { class: 'big', textContent: a.label }), el('div', { class: 'detail', textContent: a.detail }), chips ?? '');
    return;
  }
  if (a.card?.kind === 'class' && !isOld(a)) {
    box.className = 'widget';
    box.replaceChildren(...phaseParts(a), ...classPlan(a), actions(a) ?? '', chips ?? '');
    return;
  }
  const where =
    a.mode === 'nearby' ? 'Nearby' : a.dest?.why === 'class' ? `Next class · ${a.dest.label}` : a.dest?.why === 'gap-home' ? `Long gap · ${a.dest.label}` : a.dest?.label ?? 'Next bus';
  // Show a departure as a clock time, the way the widget does, so it can't go stale.
  const svc = a.label.split(' · ')[0];
  const timed = a.departsAt && a.quality !== 'unknown' && a.quality !== 'ended';
  const big = timed ? `${svc} · ${a.quality === 'scheduled' ? '~' : ''}${clock(a.departsAt)}` : a.label;
  const old = isOld(a);
  const notes = [a.card?.quality, a.card?.crowd].filter(Boolean).join(' · ');
  box.className = old ? 'widget old' : 'widget';
  box.replaceChildren(
    ...[
      ...phaseParts(a),
      el('div', { class: 'where', textContent: where }),
      el('div', { class: 'big', textContent: big }),
      el('div', { class: 'detail', textContent: old ? 'Old times · refreshing' : a.detail }),
      a.leave && a.card && !old ? el('div', { class: 'leave', textContent: leaveText(a) }) : null,
      a.timing && !old ? el('span', { class: `ontime ${a.timing.status}`, textContent: a.timing.text }) : null,
      notes ? el('div', { class: 'note', textContent: notes }) : null,
      actions(a),
      chips,
    ].filter(Boolean),
  );
}


/** "Is this wrong?": sends the answer on screen, with an optional note. */
export function wireReport() {
  const form = $('#report');
  const open = $('#report-open');
  const msg = $('#report-msg');
  // The preview refreshes every minute; report the answer the user saw when they opened the form.
  let reported = null;
  const close = () => {
    form.hidden = true;
    open.hidden = false;
    $('#report-note').value = '';
  };
  open.addEventListener('click', () => {
    reported = shown;
    msg.textContent = '';
    form.hidden = false;
    open.hidden = true;
    $('#report-note').focus();
  });
  $('#report-cancel').addEventListener('click', close);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const note = $('#report-note').value.trim();
    if (!reported && !note) {
      msg.textContent = 'Say what was wrong: the preview has no answer to send.';
      return;
    }
    const send = $('#report-send');
    send.disabled = true;
    try {
      await api('/me/feedback', { method: 'POST', body: { kind: 'wrong', note, platform: 'web', context: reported ?? undefined } });
      close();
      msg.textContent = 'Thanks, sent. It helps make the answers better.';
    } catch (err) {
      msg.textContent = err.message;
    } finally {
      send.disabled = false;
    }
  });
}
