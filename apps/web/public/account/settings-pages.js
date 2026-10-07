// Settings' pages: what each group in the list opens (settings.js lays them
// out and moves between them). Each saves as it changes, through the shared
// profile (profile.js).

import { Rich, html, noteRow, refocusAfterRemove, store, useEffect, useMemo, useRef, useState, useStore } from '../assets/ui.js';
import { api, clock, clockOpts, locale, spaced, t } from './dom.js';
import { Journey, STYLES, cardStyle, setCardStyle, styleHint, styleName } from './journey.js';
import {
  campus,
  edit,
  lists,
  profile,
  ResidenceOptions,
  residenceFor,
  limit,
  residenceWalkMin,
  residencesByName,
  saveNow,
  stopName,
  stopsByName,
  stopsNear,
  toast,
  withPlace,
} from './profile.js';
import { SearchBox } from './search-box.js';
import { Celestial, Horizon } from './sky.js';
import { pickedStop } from './search.js';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => t(d));
const FULL_DAYS = [t('Sunday'), t('Monday'), t('Tuesday'), t('Wednesday'), t('Thursday'), t('Friday'), t('Saturday')];
/** The week as a timetable lists it: Monday first. */
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

/** Devices paired, for Devices' line in the list; null until loaded. */
export const deviceCount = store(null);
/** A NUSMods link shared to the app, waiting in the import box for the person to import. */
export const importOffer = store(null);

/* ---------- helpers ---------- */

const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
/** A time of day in the account's clock style ("9:00 AM" or "09:00"), for showing; hhmm is for time inputs. */
const clockMin = (min) => spaced(new Date(Date.UTC(2000, 0, 1, Math.floor(min / 60), min % 60)).toLocaleTimeString(locale(), { ...clockOpts(), timeZone: 'UTC' }));
/** "9:00–11:00 AM": the start's AM or PM left off when the end has the same. */
function clockSpan(from, to) {
  const a = clockMin(from);
  const b = clockMin(to);
  const suffix = (x) => x.match(/\s?[^\d\s:]+$/)?.[0] ?? '';
  return suffix(a) && suffix(a) === suffix(b) ? `${a.slice(0, -suffix(a).length)}–${b}` : `${a}–${b}`;
}
const toMin = (v) => (v ? Number(v.slice(0, 2)) * 60 + Number(v.slice(3, 5)) : null);
const shortDate = (ms) => new Date(ms).toLocaleDateString(locale(), { day: 'numeric', month: 'short' });

/** A page of Settings: its heading with Back, then what's on it. */
export function Page({ id, title, children, nodes, onBack, shown, leaving, sky = false }) {
  const head = html`
    <header class="page-head">
      <button type="button" class="page-back" aria-label=${t('Back')} onClick=${onBack}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 6-6 6 6 6" /></svg>
      </button>
      <h2 id=${`page-${id}`} tabindex="-1">${title}</h2>
    </header>
  `;
  return html`
    <section
      class=${leaving ? 'settings-page leaving' : 'settings-page'}
      style=${leaving ? { top: `${leaving.shift}px` } : undefined}
      data-page=${id}
      aria-labelledby=${`page-${id}`}
      hidden=${!shown && !leaving}
      ref=${(n) => (nodes[id] = n)}
    >
      ${sky ? html`<div class="page-band"><div class="sky-head"><${Celestial} band />${head}</div><${Horizon} on=${null} low /></div>` : head}
      ${children}
    </section>
  `;
}

/** A menu of every stop, with a blank first when `blank` is given. */
export function StopSelect({ value, onChange, blank, ...props }) {
  const c = useStore(campus);
  const stops = useMemo(() => stopsByName(c), [c]);
  // Keep a food court the class already goes to, rather than showing blank.
  const place = value && !stops.some((s) => s.code === value) ? c?.destinations?.find((d) => d.code === value) : null;
  return html`
    <select ...${props} value=${value ?? ''} onChange=${(e) => onChange(e.currentTarget.value)}>
      ${blank != null && html`<option value="">${blank}</option>`}
      ${place && html`<option value=${place.code}>${place.label}</option>`}
      ${stops.map((s) => html`<option value=${s.code} key=${s.code}>${s.name}</option>`)}
    </select>
  `;
}

/** A picked search result, or text that names one exactly (a code, a stop). */
function resolveWhere(picked, text) {
  if (picked) return picked;
  const c = campus.get();
  const typed = text.trim();
  const lower = typed.toLowerCase();
  const hit = c?.destinations?.find((d) => d.code.toLowerCase() === lower || d.label.toLowerCase() === lower);
  // A food court or other landmark goes to itself (its stops are the router's to pick).
  if (hit) return hit.kind === 'landmark' ? hit.code : hit.stopCode;
  const code = typed.toUpperCase();
  return c?.stops.some((s) => s.code === code) ? code : null;
}

/** Says why a form can't be sent, on the field, as the browser does. */
function refuse(input, message) {
  input.setCustomValidity(message);
  input.reportValidity();
}

/* ---------- Your trips ---------- */

/** One setting on a row of a group: its name, then its control. */
function Field({ id, label, sub, children }) {
  return html`
    <div class="field">
      <label for=${id}>${label}${sub && html`<span class="field-sub">${sub}</span>`}</label>
      <div class="field-control">${children}</div>
    </div>
  `;
}

/**
 * A group's heading and its rows, with at most one line of explanation under
 * them: every page of Settings is made of these, as on Android. `id` names the
 * heading, for a control in the group to be labelled by it.
 */
function Group({ title, hint, id, children }) {
  return html`
    <section class="trips-group">
      <h3 class="eyebrow" id=${id} tabindex="-1">${title}</h3>
      <div class="card settings-list">${children}</div>
      ${hint && html`<p class="hint group-hint">${hint}</p>`}
    </section>
  `;
}

/**
 * Two or three choices as pills on one track (radios underneath); `full`
 * spreads them across the row. An option is [value, label], or [value,
 * label, lang] for a label in another language than the page's.
 */
export function Pills({ name, value, options, onChange, labelledBy, full = false }) {
  return html`
    <div class=${full ? 'segmented full' : 'segmented'} role="radiogroup" aria-labelledby=${labelledBy}>
      ${options.map(
        ([v, label, lang]) => html`<label key=${v}>
          <input type="radio" name=${name} value=${v} checked=${value === v} onChange=${() => onChange(v)} />
          <span lang=${lang}>${label}</span>
        </label>`,
      )}
    </div>
  `;
}

/** − value +, for a number in small steps between `min` and `max`. */
function Stepper({ label, value, text, min, max, step, less, more, onChange }) {
  return html`
    <span class="stepper" role="group" aria-label=${label}>
      <button type="button" aria-label=${less} disabled=${value <= min} onClick=${() => onChange(value - step)}>−</button>
      <output aria-live="polite">${text}</output>
      <button type="button" aria-label=${more} disabled=${value >= max} onClick=${() => onChange(value + step)}>+</button>
    </span>
  `;
}

const PACES = () => [
  { value: 'slow', label: t('Slow'), hint: t('400 m in about 6 min. A relaxed pace, or if you often carry a bag.') },
  { value: 'normal', label: t('Normal'), hint: t('400 m in about 5 min. An average pace.') },
  { value: 'fast', label: t('Fast'), hint: t('400 m in about 4 min. A brisk pace.') },
];

/**
 * Where you live, your day's hours and how you walk: three short groups of
 * one-line rows, each group with one line of explanation. The first-time
 * setup (onboarding.js) asks the same things with more words.
 */
export function Trips() {
  const p = useStore(profile);
  const c = useStore(campus);
  const now = p.home?.stops ?? [];
  const residences = useMemo(() => residencesByName(c), [c]);
  const residence = residenceFor(now);
  // "Off campus" can be chosen while the stops are a residence's: it stays
  // chosen (to pick a stop below) until the stops change.
  const [offCampus, setOffCampus] = useState(false);
  useEffect(() => setOffCampus(false), [now.join()]);
  const [msg, setMsg] = useState('');
  const picking = offCampus || !residence;

  // The first stop is the one picked here; any others (from before) stay after it.
  const pickStop = (code) =>
    edit((x) => {
      const rest = (x.home?.stops ?? []).slice(1).filter((s) => s !== code);
      const next = code ? [code, ...rest] : rest;
      x.home = next.length ? { stops: next } : null;
    });

  // Finds the nearest stop in the browser. The location itself is never sent.
  const locate = () => {
    if (!navigator.geolocation) return setMsg(t('This browser cannot share its location.'));
    setMsg(t('Finding the nearest stop…'));
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        const near = stopsNear(coords.latitude, coords.longitude)[0];
        if (!near) return setMsg('');
        pickStop(near.s.code);
        setMsg(t('Picked {0}. Change it if you use a different stop.', stopName(near.s.code)));
      },
      (err) => setMsg(t("Couldn't get your location ({0}). Pick your stop instead.", err.message)),
      { enableHighAccuracy: true, timeout: 10_000 },
    );
  };

  const dayTime = (field) => (e) => {
    const v = toMin(e.currentTarget.value);
    if (v == null) return;
    const next = { ...p, [field]: v };
    if (next.dayStartMin >= next.dayEndMin) {
      toast(t('The start time must be before the end time'), { error: true });
      e.currentTarget.value = hhmm(p[field]);
      return;
    }
    edit((x) => (x[field] = v));
  };

  const pace = PACES().find((x) => x.value === (p.walkPace ?? 'normal')) ?? PACES()[1];
  const walk = p.homeWalkMin ?? 5;
  const gap = p.gapHours ?? 2;

  return html`
    <div class="trips">
      <${Group} title=${t('Where you live')} hint=${t('Only your stops are saved.')}>
        <${Field} id="residence" label=${t('Residence')} sub=${picking ? '' : t('Your stops: {0}.', now.map(stopName).join(', '))}>
          <select
            id="residence"
            class="plain"
            value=${picking ? '' : residence.code}
            onChange=${(e) => {
              const r = residences.find((x) => x.code === e.currentTarget.value);
              // "Off campus": keep the stops, pick one below.
              if (!r) return setOffCampus(true);
              edit((x) => {
                x.home = { stops: [...r.stops] };
                x.homeWalkMin = residenceWalkMin(r);
              });
            }}
          >
            <option value="">${t('Off campus')}</option>
            <${ResidenceOptions} residences=${residences} />
          </select>
        <//>
        ${picking
          ? html`
              <${Field} id="home-1" label=${t('Your stop')}>
                <${StopSelect} id="home-1" value=${now[0]} onChange=${pickStop} blank=${t('Choose a stop')} />
              <//>
              <div class="field field-note">
                <button type="button" class="link-btn" onClick=${locate}>${t('Pick the stop nearest me')}</button>
                <span class="hint" role="status">${msg}</span>
              </div>
            `
          : null}
        <div class="field">
          <span class="field-label">${t('Walk to your stop')}</span>
          <${Stepper}
            label=${t('Walk to your stop')}
            value=${walk}
            text=${t('{0} min', walk)}
            min=${0}
            max=${30}
            step=${1}
            less=${t('One minute less')}
            more=${t('One minute more')}
            onChange=${(v) => edit((x) => (x.homeWalkMin = v))}
          />
        </div>
      <//>

      <${Group} title=${t('Your day')} hint=${t('Outside these hours, you see your next class instead of a bus.')}>
        <${Field} id="day-start" label=${t('Show buses between')}>
          <span class="unit">
            <input id="day-start" type="time" value=${hhmm(p.dayStartMin ?? 360)} onChange=${dayTime('dayStartMin')} />
            <label class="unit-and" for="day-end">${t('and')}<span class="sr-only"> (${t('Day ends')})</span></label>
            <input id="day-end" type="time" value=${hhmm(p.dayEndMin ?? 1080)} onChange=${dayTime('dayEndMin')} />
          </span>
        <//>
        <div class="field">
          <span class="field-label">${t('Go home in gaps longer than')}</span>
          <${Stepper}
            label=${t('Go home in gaps longer than')}
            value=${gap}
            text=${gap === 1 ? t('1 hour') : t('{0} hours', gap)}
            min=${0.5}
            max=${12}
            step=${0.5}
            less=${t('Half an hour shorter')}
            more=${t('Half an hour longer')}
            onChange=${(v) => edit((x) => (x.gapHours = v))}
          />
        </div>
      <//>

      <${Group} title=${t('Walking')} hint=${t('Walks follow the paths on campus.')}>
        <div class="field stack">
          <span class="field-label" id="pace-label">${t('Walking pace')}<span class="field-sub">${pace.hint}</span></span>
          <${Pills} name="pace" value=${pace.value} options=${PACES().map((x) => [x.value, x.label])} onChange=${(v) => edit((y) => (y.walkPace = v))} labelledBy="pace-label" full />
        </div>
        <${Field} id="full-bus" label=${t('Allow for busy buses')} sub=${t('Aim one bus earlier when yours is often full.')}>
          <input id="full-bus" class="switch" type="checkbox" role="switch" checked=${p.fullBusMargin !== false} onChange=${(e) => edit((x) => (x.fullBusMargin = e.currentTarget.checked))} />
        <//>
        <${Field} id="public-buses" label=${t('Public buses')} sub=${t('Count the 95, 151 and other public buses at your stops too. They have a fare, so one is the answer only when it clearly saves time.')}>
          <input id="public-buses" class="switch" type="checkbox" role="switch" checked=${p.publicBuses === true} onChange=${(e) => edit((x) => (x.publicBuses = e.currentTarget.checked))} />
        <//>
      <//>
      <${Choices} />
    </div>
  `;
}

const PREF_TEXT = { earlier: t('One bus earlier'), quiet: t('No reminders') };

/** Classes you leave a bus earlier for or get no reminders for, and the trip history. */
function Choices() {
  const version = useStore(lists);
  const [r, setR] = useState(null);
  const load = () =>
    api('/me/choices')
      .then(setR)
      .catch(() => {});
  useEffect(() => {
    load();
  }, [version]);
  if (!r) return null;
  const name = (c) => c.label ?? t('A class no longer in your timetable');
  return html`
    ${r.choices.length > 0 &&
    html`<section id="trip-choices" class="trips-group">
      <h3 class="eyebrow">${t('Your classes')}</h3>
      <ul class="list card settings-list">
        ${r.choices.map(
          (c) => html`<li key=${`${c.trip}-${c.pref}`}>
            <span><span>${name(c)}</span><div class="meta">${PREF_TEXT[c.pref]}</div></span>
            <button
              type="button"
              class="btn small ghost"
              aria-label=${t('Undo for {0}', name(c))}
              onClick=${async () => {
                await api('/me/choice', { method: 'POST', body: { trip: c.trip, pref: c.pref, choice: 'undo' } });
                lists.set((n) => n + 1);
              }}
            >${t('Undo')}</button>
          </li>`,
        )}
      </ul>
    </section>`}
    ${r.history > 0 &&
    html`<section id="trip-history" class="trips-group">
      <h3 class="eyebrow">${t('Trip history')}</h3>
      <div class="card settings-list">
        <div class="field">
          <span class="field-label">${r.history === 1 ? t('1 trip recorded.') : t('{0} trips recorded.', r.history)}</span>
          <div class="field-control">
            <button
              class="btn small ghost"
              type="button"
              onClick=${async () => {
                if (!confirm(t("Clear your trip history? Your settings won't change."))) return;
                await api('/me/history', { method: 'DELETE' });
                toast(t('Trip history cleared'));
                lists.set((n) => n + 1);
              }}
            >${t('Clear trip history')}</button>
          </div>
        </div>
      </div>
      <p class="hint group-hint">${t('Kept for 35 days and used only to spot classes you often miss or skip.')}</p>
    </section>`}
  `;
}

/* ---------- Timetable ---------- */

/**
 * Where a class shown on the page is in the profile now. Every save replaces
 * the profile with the server's copy, sorted its own way, so a row finds its
 * class again by what it is, never by where it was.
 */
const same = (a, b) => a.day === b.day && a.arriveByMin === b.arriveByMin && a.label === b.label && a.to === b.to;

export function Timetable({ me }) {
  const p = useStore(profile);
  const offer = useStore(importOffer);
  const [term, setTerm] = useState(me.term);
  const [reimport, setReimport] = useState(Boolean(me.needsReimport));
  const [share, setShare] = useState(p.share ?? '');
  const [msg, setMsg] = useState('');
  const [unresolved, setUnresolved] = useState([]);
  const shareBox = useRef(null);

  // A NUSMods link shared to the app: in the box, for the person to import.
  // Never imported straight from the URL: any page could link here and
  // replace a signed-in person's timetable. They press Import themselves.
  useEffect(() => {
    if (!offer) return;
    setShare(offer);
    setMsg(t('Press Import to replace your timetable with this one.'));
    importOffer.set(null);
    requestAnimationFrame(() => shareBox.current?.scrollIntoView({ block: 'center' }));
  }, [offer]);

  const runImport = async (e) => {
    e.preventDefault();
    setMsg(t('Importing…'));
    try {
      const r = await api('/me/import', { method: 'POST', body: { share } });
      profile.set(r.profile);
      setTerm(r.term);
      const n = r.profile.trips.length;
      const notes = [n === 1 ? t('Imported 1 class for {0}.', r.term) : t('Imported {0} classes for {1}.', n, r.term)];
      if (r.missing?.length) notes.push(r.missing.length === 1 ? t('{0} has no classes that semester.', r.missing[0]) : t('{0} have no classes that semester.', r.missing.join(', ')));
      if (r.online) notes.push(r.online === 1 ? t('1 online lesson skipped.') : t('{0} online lessons skipped.', r.online));
      setMsg(notes.join(' '));
      setReimport(false);
      setUnresolved(r.unresolved ?? []);
      importDone.set((x) => x + 1);
    } catch (err) {
      setMsg(err.status === 500 ? t('Something went wrong on our side. Your timetable was not changed.') : err.message);
    }
  };

  // Keyed by what doesn't change when it's edited (not its stop), so a row stays open while its stop is changed.
  const seenKeys = new Map();
  const all = [...p.trips.map((c) => ({ c, list: 'trips' })), ...p.manual.map((c) => ({ c, list: 'manual' }))].map((r) => {
    const base = `${r.list}-${r.c.day}-${r.c.arriveByMin}-${r.c.label}`;
    const n = seenKeys.get(base) ?? 0;
    seenKeys.set(base, n + 1);
    return { ...r, key: `${base}-${n}` };
  });
  // A favourite at its usual time each week: listed with the classes that day.
  const usual = (p.usual ?? []).filter((u) => p.places.some((x) => x.key === u.place)).map((u) => ({ u, key: `usual-${u.place}-${u.day}-${u.atMin}` }));

  const count = all.length ? `${all.length === 1 ? t('1 class') : t('{0} classes', all.length)}${term && p.trips.length ? ` · ${term}` : ''}` : t('No classes yet');

  return html`
    <div class="trips">
      ${reimport &&
      html`<div class="banner">
        <strong>${t('Re-import your timetable.')}</strong>${' '}
        <span>${t("This link is for {0}, which has ended. Copy this semester's link from NUSMods and import it below.", me.term)}</span>
      </div>`}
      <${Group} title=${t('From NUSMods')} hint=${t('In NUSMods: Timetable → Share/Sync → Copy. Re-import each semester.')}>
        <form class="field stack" onSubmit=${runImport}>
          <label for="share">${t('NUSMods share link')}</label>
          <div class="row">
            <input id="share" ref=${shareBox} type="url" placeholder="https://nusmods.com/timetable/sem-1/share?…" value=${share} onInput=${(e) => setShare(e.currentTarget.value)} />
            <button type="submit" class="btn small">${t('Import')}</button>
          </div>
          <p class="hint" role="status">${msg}</p>
        </form>
      <//>
      <${Group} title=${count} hint=${all.length || usual.length ? '' : t('No classes yet. Import from NUSMods or add them by hand.')}>
        ${unresolved.length > 0 && html`<div class="group-body"><${Unresolved} list=${unresolved} onDone=${(u) => setUnresolved((l) => l.filter((x) => x !== u))} /></div>`}
        ${(all.length > 0 || usual.length > 0) &&
        html`<div class="classes group-body">
          ${DAY_ORDER.map((day) => {
            const rows = [...all.filter((r) => r.c.day === day), ...usual.filter((r) => r.u.day === day)].sort((a, b) => (a.c?.arriveByMin ?? a.u.atMin) - (b.c?.arriveByMin ?? b.u.atMin));
            if (!rows.length) return null;
            return html`<div class="day" key=${`d${day}`}>${DAYS[day]}</div>${rows.map((r) => (r.u ? html`<${UsualRow} key=${r.key} u=${r.u} />` : html`<${ClassRow} key=${r.key} c=${r.c} list=${r.list} />`))}`;
          })}
        </div>`}
        <${AddClass} />
      <//>
    </div>
  `;
}

/** Bumped after an import: the list's "Re-import needed" goes. */
export const importDone = store(0);

/** One class: its name, then when and from which stop; opened, the stop to change and Remove. */
function ClassRow({ c, list }) {
  const time = c.endMin ? clockSpan(c.arriveByMin, c.endMin) : clockMin(c.arriveByMin);
  const weeks = Array.isArray(c.weeks) && c.weeks.length < 13 ? ` · ${t('wk {0}–{1}', c.weeks[0], c.weeks.at(-1))}` : '';
  return html`
    <details class="cls">
      <summary>
        <span class="what">
          <span class="name" title=${c.label}>${c.label + weeks}</span>
          <span class="where">${`${time} · ${stopName(c.to)}`}</span>
        </span>
      </summary>
      <div class="cls-edit">
        <${StopSelect}
          value=${c.to}
          aria-label=${t('Stop for {0}', c.label)}
          onChange=${(v) =>
            edit((x) => {
              const at = x[list].find((y) => same(y, c));
              if (at) at.to = v;
            })}
        />
        <button
          type="button"
          class="remove"
          aria-label=${t('Remove {0}', c.label)}
          onClick=${(e) => {
            refocusAfterRemove(e.currentTarget, e.currentTarget.closest('.trips-group')?.querySelector('h3'));
            edit((x) => (x[list] = x[list].filter((y) => !same(y, c))));
          }}
        >${t('Remove')}</button>
      </div>
    </details>
  `;
}

/** A favourite at its usual time: its name, then when and where; opened, Remove. */
function UsualRow({ u }) {
  const place = profile.get().places.find((x) => x.key === u.place);
  return html`
    <details class="cls">
      <summary>
        <span class="what">
          <span class="name">${place.label}</span>
          <span class="where">${`${clockMin(u.atMin)} · ${stopName(place.to)}`}</span>
        </span>
      </summary>
      <div class="cls-edit">
        <button
          type="button"
          class="remove"
          aria-label=${t('Remove {0}', `${place.label} ${DAYS[u.day]} ${clockMin(u.atMin)}`)}
          onClick=${(e) => {
            refocusAfterRemove(e.currentTarget, e.currentTarget.closest('.trips-group')?.querySelector('h3'));
            edit((x) => (x.usual = (x.usual ?? []).filter((y) => !(y.place === u.place && y.day === u.day && y.atMin === u.atMin))));
          }}
        >${t('Remove')}</button>
      </div>
    </details>
  `;
}

/** Classes from an import whose room couldn't be placed: pick a stop for each, or skip it. */
function Unresolved({ list, onDone }) {
  if (!list.length) return null;
  return html`
    <div>
      <p class="warn-text">
        ${list.length === 1 ? t("1 class had a venue we couldn't place. Pick the nearest stop, or skip it:") : t("{0} classes had a venue we couldn't place. Pick the nearest stop, or skip it:", list.length)}
      </p>
      <ul class="list">
        ${list.map(
          (u) => html`<li key=${`${u.day}-${u.arriveByMin}-${u.module}`}>
            <span>${`${DAYS[u.day]} ${clockMin(u.arriveByMin)} · ${u.module} @ ${u.venue}${u.offCampus ? t(' (off campus)') : ''}`}</span>
            <button type="button" class="link-btn" onClick=${() => onDone(u)}>${t('Skip')}</button>
            <${StopSelect}
              value=""
              blank=${t('Choose stop')}
              aria-label=${t('Stop for {0}', u.module)}
              onChange=${(v) => {
                if (!v) return;
                edit((x) => x.manual.push({ day: u.day, arriveByMin: u.arriveByMin, ...(u.endMin ? { endMin: u.endMin } : {}), to: v, label: `${u.module} @ ${u.venue.split('-')[0]}`, venue: u.venue }));
                onDone(u);
              }}
            />
          </li>`,
        )}
      </ul>
    </div>
  `;
}

/** Before anything is typed: favourites, then where classes are. */
function mySuggestions() {
  const p = profile.get();
  const places = (p?.places ?? []).map((x) => ({ code: x.to, label: x.label, stopCode: x.to, kind: 'place' }));
  const seen = new Set();
  const classes = [...(p?.trips ?? []), ...(p?.manual ?? [])]
    .filter((c) => !seen.has(c.to) && seen.add(c.to))
    .slice(0, 4)
    .map((c) => ({ code: c.to, label: c.label, stopCode: c.to, kind: 'class' }));
  return [...places.slice(0, 4), ...classes];
}

const destinations = () => campus.get()?.destinations ?? [];

/** "+ Add a class or commitment by hand": the last row of the classes, opening the form under it. */
function AddClass() {
  const [open, setOpen] = useState(false);
  const where = useRef(null);
  const picked = useRef(null);
  const [day, setDay] = useState('1');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [label, setLabel] = useState('');
  const endBox = useRef(null);
  const submit = (e) => {
    e.preventDefault();
    const to = resolveWhere(picked.current, where.current.input.value);
    if (!to) return refuse(where.current.input, t('Pick a stop, building or room from the list'));
    const a = toMin(start);
    const b = toMin(end);
    // An end before the start was dropped without a word; say so instead.
    if (b != null && b <= a) return refuse(endBox.current, t('The end time must be after the start time'));
    edit((x) => x.manual.push({ day: Number(day), arriveByMin: a, ...(b && b > a ? { endMin: b } : {}), to, label: label.trim(), venue: '' }));
    setStart('');
    setEnd('');
    setLabel('');
    setDay('1');
    picked.current = null;
    where.current.clear();
  };
  return html`
    <button type="button" class="add-row" aria-expanded=${open} onClick=${() => setOpen(!open)}>${t('Add a class or commitment by hand')}</button>
    ${open &&
    html`<div class="group-body add-form">
      <form class="grid" onSubmit=${submit}>
        <label>${t('Day')}
          <select name="day" required value=${day} onChange=${(e) => setDay(e.currentTarget.value)}>
            ${DAY_ORDER.map((d) => html`<option value=${String(d)} key=${d}>${FULL_DAYS[d]}</option>`)}
          </select>
        </label>
        <label>${t('Starts')} <input name="start" type="time" required value=${start} onInput=${(e) => setStart(e.currentTarget.value)} /></label>
        <label>${t('Ends')} <input name="end" type="time" ref=${endBox} value=${end} onInput=${(e) => {
          e.currentTarget.setCustomValidity('');
          setEnd(e.currentTarget.value);
        }} /></label>
        <label class="wide">${t('Name')} <input name="label" maxlength=${limit('label', 60)} required placeholder=${t('e.g. Gym')} value=${label} onInput=${(e) => setLabel(e.currentTarget.value)} /></label>
        <label class="wide">${t('Where')}
          <${SearchBox}
            name="where"
            required
            placeholder=${t('Stop, building or room')}
            ctl=${where}
            source=${destinations}
            suggestions=${mySuggestions}
            stopName=${stopName}
            onPick=${(d) => (picked.current = pickedStop(d))}
            onText=${() => (picked.current = null)}
          />
        </label>
        <button type="submit" class="btn wide">${t('Add')}</button>
      </form>
    </div>`}
  `;
}

/* ---------- Favourites ---------- */

/**
 * The stops your classes go to, for the top of the favourites picker: one
 * entry per stop, saying which classes use it, leaving out favourites already.
 */
function timetableStops() {
  const p = profile.get();
  const byStop = new Map();
  for (const c of [...(p?.trips ?? []), ...(p?.manual ?? [])]) {
    const names = byStop.get(c.to) ?? [];
    const name = c.label.split(' @ ')[0];
    if (!names.includes(name)) names.push(name);
    byStop.set(c.to, names);
  }
  const fav = new Set((p?.places ?? []).map((x) => x.to));
  return [...byStop]
    .filter(([to]) => !fav.has(to))
    .map(([to, names]) => ({ code: to, label: stopName(to), stopCode: to, kind: 'timetable', detail: names.join(', ') }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

function addFavourite(to, label) {
  let already = null;
  edit((x) => {
    already = withPlace(x, to, label);
  });
  if (already) toast(t('Already a favourite: {0}', already.label));
}

export function Favourites() {
  const p = useStore(profile);
  const search = useRef(null);
  return html`
    <div class="trips">
      <${Group} title=${t('Your favourites')} hint=${t('Available in one tap from the app, the widget and the menu bar. To go somewhere every week, add it to your timetable.')}>
        ${p.places.length > 0 && html`<ul class="list group-body">${p.places.map((place) => html`<${Place} key=${place.key} place=${place} />`)}</ul>`}
        <form
          id="place-form"
          class="field"
          onSubmit=${(e) => {
            // Enter on a typed stop code or name adds it; picking from the list does too.
            e.preventDefault();
            const to = resolveWhere(null, search.current.input.value);
            if (!to) return refuse(search.current.input, t('Pick a stop, building or room from the list'));
            addFavourite(to, stopName(to));
            search.current.clear();
          }}
        >
          <${SearchBox}
            name="where"
            required
            placeholder=${t('Add a stop, building or room')}
            aria-label=${t('Add a favourite')}
            ctl=${search}
            source=${destinations}
            pinned=${timetableStops}
            suggestions=${timetableStops}
            stopName=${stopName}
            onPick=${(d) => {
              addFavourite(pickedStop(d), d.kind === 'building' || d.kind === 'room' ? d.code : d.label);
              search.current.clear();
            }}
          />
        </form>
      <//>
    </div>
  `;
}

/** A favourite: its name, where it goes, and Remove (which takes its usual times too). */
function Place({ place }) {
  return html`
    <li class="place">
      <div class="place-row">
        <span>
          <strong>${place.label}</strong>
          ${place.label === stopName(place.to) ? '' : html`<span class="meta">${` → ${stopName(place.to)}`}</span>`}
        </span>
        <button
          type="button"
          class="remove"
          aria-label=${t('Remove {0}', place.label)}
          onClick=${(e) => {
            // The list's last one gone, the search box to add another is next.
            refocusAfterRemove(e.currentTarget, document.querySelector('#place-form input'));
            edit((x) => {
              x.places = x.places.filter((y) => y.key !== place.key);
              x.usual = (x.usual ?? []).filter((u) => u.place !== place.key);
            });
          }}
        >${t('Remove')}</button>
      </div>
    </li>
  `;
}

/* ---------- Devices ---------- */

/** The QR code library, from cdnjs, the first time a code is shown. */
function loadQr() {
  if (window.qrcode) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js';
    s.integrity = 'sha384-mZT2gIty7ZDdOGkxfP6joZcYdMW1Jvj9dRlfpTmaJAKKXTqzygtB22k7FLe+KZC1';
    s.crossOrigin = 'anonymous';
    s.onload = resolve;
    s.onerror = reject;
    document.head.append(s);
  });
}

export function Devices({ me }) {
  const version = useStore(lists);
  const [devices, setDevices] = useState(null);
  const [pairing, setPairing] = useState(null);
  const load = async () => {
    const { devices: list } = await api('/me/devices');
    setDevices(list);
    deviceCount.set(list.length);
    return list.length;
  };
  useEffect(() => {
    load().catch(() => {});
  }, [version]);
  const anonymous = me.anonymous === true;
  if (anonymous) return html`<div class="card"><p class="hint">${t('Add an email to use terminus on your other devices too.')}</p></div>`;
  return html`
    <div class="trips">
      ${devices?.length > 0 &&
      html`<${Group} title=${t('Your devices')}>
        <ul class="list group-body">
          ${devices.map(
            (d) => html`<li key=${d.id}>
              <span><strong>${d.name ?? t('Device')}</strong><div class="meta">${t('Added {0} · used {1}', shortDate(d.created), shortDate(d.lastSeen))}</div></span>
              <button
                type="button"
                class="remove"
                aria-label=${t('Remove {0}', d.name ?? t('Device'))}
                onClick=${async (e) => {
                  // Noted before the wait: by the time the list is back, the row has gone.
                  const refocus = noteRow(e.currentTarget);
                  await api(`/me/devices/${d.id}`, { method: 'DELETE' });
                  await load();
                  refocus(() => document.querySelector('.add-device'));
                }}
              >${t('Remove')}</button>
            </li>`,
          )}
        </ul>
      <//>`}
      <section class="trips-group">
        <button type="button" class="btn wide add-device" onClick=${() => setPairing((n) => (n ?? 0) + 1)}>${t('Add a device')}</button>
        <${Rich} as="p" class="hint group-hint" text=${t('Get the <a href="/download/android">Android app</a> or <a href="/download/mac">Mac app</a> and sign in with this email, or pair it here with a code.')} />
        ${pairing && html`<div class="card"><${Pairing} key=${pairing} count=${devices?.length ?? 0} reload=${load} /></div>`}
      </section>
    </div>
  `;
}

/** A pairing code and its QR code, counting down, until a device uses it. */
function Pairing({ count, reload }) {
  const [state, setState] = useState({ text: '', hint: '' });
  const qr = useRef(null);
  useEffect(() => {
    let timer = null;
    let gone = false;
    (async () => {
      let made;
      try {
        made = await api('/me/pair-code', { method: 'POST' });
      } catch (err) {
        setState({ text: '', hint: err.message });
        return;
      }
      if (gone) return;
      const link = `${location.origin}/pair?code=${made.code}`;
      await loadQr().catch(() => {});
      if (gone) return;
      if (window.qrcode && qr.current) {
        const q = window.qrcode(0, 'M');
        q.addData(link);
        q.make();
        // The library's own SVG, of our link: not data from anywhere else.
        qr.current.innerHTML = q.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
      }
      const before = await reload().catch(() => count);
      const tick = async () => {
        const left = Math.max(0, Math.round((made.expires - Date.now()) / 1000));
        if (!left) {
          clearInterval(timer);
          if (qr.current) qr.current.replaceChildren();
          setState({ text: t('Expired'), hint: t('Get a new code to pair.') });
          return;
        }
        setState({
          code: made.code,
          text: `${made.code.slice(0, 3)} ${made.code.slice(3)}`,
          hint: t("Scan with your phone's camera, or type the code in the app. Expires in {0}.", `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`),
        });
        // The code goes once a device has used it.
        if (left % 4 === 0 && (await reload().catch(() => before)) > before) {
          clearInterval(timer);
          if (qr.current) qr.current.replaceChildren();
          setState({ text: t('Paired'), hint: t('That device is now signed in.') });
          lists.set((n) => n + 1);
        }
      };
      tick();
      timer = setInterval(tick, 1000);
    })();
    return () => {
      gone = true;
      clearInterval(timer);
    };
  }, []);
  return html`
    <div class="pairing">
      <div class="qr" ref=${qr} role="img" aria-label=${t('QR code to pair a phone')}></div>
      ${state.code
        ? html`<p class="flaps" role="img" aria-label=${state.text}>${[...state.code].map((c, i) => html`<span class="flap" key=${i}>${c}</span>`)}</p>`
        : html`<p class="code">${state.text}</p>`}
      <p class="hint">${state.hint || t("Scan with your phone's camera, or type the code in the app.")}</p>
    </div>
  `;
}

/* ---------- Language and time, the theme ---------- */

/** The clock choices, shared with setup: one example time each, so the choice shows itself. */
export const CLOCKS = () => [
  { value: '12', label: t('12-hour'), eg: t('6:36 PM') },
  { value: '24', label: t('24-hour'), eg: '18:36' },
];

/** Each as a row of pills: Auto follows this browser. The languages are named in themselves. */
export function Language() {
  const p = useStore(profile);
  return html`
    <div class="trips">
      <${Group} title=${t('Language')} id="lang-label" hint=${t('Also used for emails and on your other devices. Place and bus names stay in English, as on the signs.')}>
        <div class="field">
          <${Pills}
            name="lang"
            value=${window.i18n?.pref() ?? 'auto'}
            options=${[['auto', t('Auto')], ['en', 'English', 'en'], ['zh', '中文', 'zh-Hans']]}
            labelledBy="lang-label"
            full
            onChange=${async (v) => {
              // This browser and the account, so emails and the other devices follow.
              window.i18n?.noteAccount(v);
              await saveNow((x) => (x.lang = v)).catch(() => {});
              window.i18n?.setLang(v);
            }}
          />
        </div>
      <//>
      <${Group} title=${t('Time format')} id="clock-label" hint=${t('For every time terminus shows, here and on your other devices. Auto follows this browser.')}>
        <div class="field">
          <${Pills}
            name="clock"
            value=${p?.clock ?? 'auto'}
            options=${[['auto', t('Auto')], ...CLOCKS().map((c) => [c.value, c.label])]}
            labelledBy="clock-label"
            full
            onChange=${(v) => saveNow((x) => (x.clock = v)).catch((err) => toast(t('Not saved. {0}', err.message), { error: true }))}
          />
        </div>
      <//>
    </div>
  `;
}

/** This browser's theme: applied at once, with nothing to save. */
export const theme = store(window.theme?.pref() ?? 'auto');

/** Auto, Light or Dark, on its row in the list. */
export function ThemeSwitch({ labelledBy, full = false }) {
  const now = useStore(theme);
  return html`
    <${Pills}
      name="theme"
      value=${now}
      options=${[['auto', t('Auto')], ['light', t('Light')], ['dark', t('Dark')]]}
      labelledBy=${labelledBy}
      full=${full}
      onChange=${(v) => {
        window.theme?.set(v);
        theme.set(v);
      }}
    />
  `;
}

/**
 * Appearance: the theme, then the card styles, each drawn with a made-up
 * trip so the choice is made by looking. Both hold for this browser only.
 */
export function Appearance() {
  const chosen = useStore(cardStyle);
  // Made again each minute (and when the clock style changes), so the
  // sample always leaves in a few minutes, however long Settings was open.
  const p = useStore(profile);
  const [minute, setMinute] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setMinute(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  const sample = useMemo(() => sampleAnswer(minute), [minute, p?.clock]);
  return html`
    <div class="trips">
      <${Group} title=${t('Theme')} id="theme-label" hint=${t('Only in this browser.')}>
        <div class="field"><${ThemeSwitch} labelledBy="theme-label" full /></div>
      <//>
      <${Group} title=${t('Card style')} id="style-label" hint=${t('How the card shows a trip by bus. Only in this browser.')}>
        <div class="style-picker" role="radiogroup" aria-labelledby="style-label">
          ${STYLES.map(
            (s) => html`
              <label class=${chosen === s ? 'style-choice on' : 'style-choice'} key=${s}>
                <span class="style-head">
                  <input type="radio" name="card-style" value=${s} checked=${chosen === s} onChange=${() => setCardStyle(s)} />
                  <span><strong>${styleName(s)}</strong><span class="hint">${styleHint(s)}</span></span>
                </span>
                <div class="widget" aria-hidden="true"><${Journey} a=${sample} style=${s} /></div>
              </label>
            `,
          )}
        </div>
      <//>
    </div>
  `;
}

/** A D2 from PGP to UTown, leaving in a few minutes, in this browser's clock style. */
function sampleAnswer(now) {
  const iso = (ms) => new Date(ms).toISOString();
  const leave = now + 4 * 60_000;
  const board = leave + 4 * 60_000;
  const arrive = board + 8 * 60_000;
  return {
    leave: { at: iso(leave) },
    card: {
      kind: 'trip',
      phase: 'idle',
      journey: {
        leave: clock(iso(leave)),
        walk: t('{0} min', 3),
        bus: { svc: 'D2', color: '#8e44c9', stop: 'PGP', board: clock(iso(board)) },
        boardAt: iso(board),
        ride: t('{0} min', 8),
        off: null,
        to: 'UTown',
        toStop: 'UTown',
        arrive: clock(iso(arrive)),
        slack: null,
        live: true,
        backup: { svc: 'A1', color: '#d32f2f', stop: 'PGP', board: clock(iso(board + 3 * 60_000)) },
      },
    },
  };
}

/* ---------- Account ---------- */

/** An email that may wrap: after the @ first, so the name stays whole. */
const breakAfterAt = (email) => {
  const at = email.indexOf('@');
  return at < 0 ? email : html`${email.slice(0, at + 1)}<wbr />${email.slice(at + 1)}`;
};

/**
 * Who you're signed in as with Sign out, then the everyday buttons at one
 * width, then API keys, with Delete account on its own at the bottom, away
 * from the rest. On the account page's wide layout the header shows who's
 * signed in, so that row is only for narrow screens there.
 */
export function Account({ me, inApp, onAddEmail, onSignOut }) {
  const [msg, setMsg] = useState('');
  const everywhere = async () => {
    if (!confirm(t('Sign out of every browser and device, including this one?'))) return;
    await api('/me/sessions', { method: 'DELETE' });
    location.reload();
  };
  const remove = async () => {
    const typed = prompt(t('This deletes your account, timetable, favourites and paired devices immediately. Type DELETE to confirm.'));
    if (typed !== 'DELETE') return;
    try {
      await api('/me', { method: 'DELETE' });
      location.href = '/';
    } catch (err) {
      setMsg(err.message);
    }
  };
  const chev = html`<svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>`;
  return html`
    <div class="trips">
      ${me.anonymous === true &&
      html`<div class="card add-email">
        <h3>${t('Add an email')}</h3>
        <p class="hint">${t("Your setup stays in this browser. Add an email any time to use it on your other devices, or to keep it if this browser's data is cleared.")}</p>
        <button type="button" class="btn accent wide" onClick=${onAddEmail}>${t('Add an email')}</button>
      </div>`}
      ${me.anonymous !== true &&
      html`<div class=${inApp ? '' : 'narrow-only'}><${Group} title=${t('Signed in')}>
        <div class="field account-who">
          <span class="avatar" aria-hidden="true">${(me.email ?? '?').slice(0, 1).toUpperCase()}</span>
          <span class="field-email">${me.email ? breakAfterAt(me.email) : t('No email')}</span>
          <button type="button" class="btn small ghost" onClick=${onSignOut}>${t('Sign out')}</button>
        </div>
      <//></div>`}
      <${Group} title=${t('Your data')}>
        <a class="settings-row" href="/me/export" download><span class="row-text"><span class="row-title">${t('Download my data')}</span></span>${chev}</a>
        <button type="button" class="settings-row" onClick=${everywhere}><span class="row-text"><span class="row-title">${t('Sign out everywhere')}</span></span>${chev}</button>
      <//>
      <${Keys} />
      <section class="trips-group">
        <div class="card settings-list">
          <button type="button" class="settings-row danger-row" onClick=${remove}><span class="row-text"><span class="row-title">${t('Delete account')}</span></span>${chev}</button>
        </div>
        <p class="hint group-hint" role="status">${msg}</p>
      </section>
    </div>
  `;
}

function Keys() {
  const [keys, setKeys] = useState([]);
  const [made, setMade] = useState(null);
  const [name, setName] = useState('');
  const [msg, setMsg] = useState('');
  const load = () =>
    api('/me/keys')
      .then((r) => setKeys(r.keys))
      .catch(() => {});
  useEffect(() => {
    load();
  }, []);
  return html`
    <section class="trips-group">
      <h3 class="eyebrow">${t('API keys')}</h3>
      <div class="card settings-list">
        ${keys.length > 0 &&
        html`<ul class="list group-body">
          ${keys.map(
            (k) => html`<li key=${k.id}>
              <span><strong>${k.name}</strong><div class="meta">${`…${k.hint} · ${t('made {0}', shortDate(k.created))} · ${k.lastUsed ? t('used {0}', shortDate(k.lastUsed)) : t('never used')}`}</div></span>
              <button
                type="button"
                class="remove"
                aria-label=${t('Revoke {0}', k.name)}
                onClick=${async (e) => {
                  // Noted before the wait: by the time the list is back, the row has gone.
                  const refocus = noteRow(e.currentTarget);
                  if (!confirm(t('Revoke "{0}"? Anything using it stops working straight away.', k.name))) return;
                  await api(`/me/keys/${k.id}`, { method: 'DELETE' });
                  setMade(null);
                  await load();
                  refocus(() => document.querySelector('.keys-name'));
                }}
              >${t('Revoke')}</button>
            </li>`,
          )}
        </ul>`}
        <form
          class="field row"
          onSubmit=${async (e) => {
            e.preventDefault();
            setMsg('');
            try {
              const r = await api('/me/keys', { method: 'POST', body: { name: name.trim() } });
              setName('');
              setMade(r.key);
              load();
            } catch (err) {
              setMsg(err.message);
            }
          }}
        >
          <input name="name" class="keys-name" maxlength="40" required placeholder=${t("What it's for, e.g. My script")} aria-label=${t('Key name')} value=${name} onInput=${(e) => setName(e.currentTarget.value)} />
          <button type="submit" class="btn small">${t('Create')}</button>
        </form>
        ${made &&
        html`<div class="new-key group-body">
          <p class="warn-text">${t("Copy this key now. It won't be shown again.")}</p>
          <div class="row">
            <code>${made}</code>
            <button
              type="button"
              class="btn small"
              onClick=${async () => {
                try {
                  await navigator.clipboard.writeText(made);
                  toast(t('Copied'));
                } catch {
                  toast(t('Select the key and copy it'), { error: true });
                }
              }}
            >${t('Copy')}</button>
          </div>
          <p class="hint">${t('Try it:')} <code>${`curl -H "x-api-key: ${made}" "${location.origin}/arrivals?stop=COM3"`}</code></p>
        </div>`}
      </div>
      <p class="hint group-hint" role="status">${msg}</p>
      <${Rich} as="p" class="hint group-hint" text=${t('For your own scripts and projects. See the <a href="/docs">API docs</a>; send the key in the <code>x-api-key</code> header.')} />
    </section>
  `;
}

/* ---------- About, Feedback ---------- */

/** About's links, as rows like the Settings list: what each is, and where it goes. */
const ABOUT_LINKS = () => [
  { title: t('Get the apps'), href: '/' },
  { title: t('Status'), href: '/status' },
  { title: t('Privacy'), href: '/privacy' },
  { title: t('API docs'), href: '/docs' },
  { title: t('Source code'), href: 'https://github.com/rcnsh/terminus' },
  { title: t('Map data'), href: 'https://www.openstreetmap.org/copyright', where: 'openstreetmap.org' },
  { title: t('NUS Acceptable Use Policy'), href: 'https://nus.edu.sg/registrar/docs/info/registration-guides/aup-form.pdf', where: 'nus.edu.sg' },
];

/** The app's mark and name, what it does and where its data comes from, then its links, as on Android. */
export function About() {
  return html`
    <div class="trips">
      <div class="about-text">
        <div class="about-head"><img src="/assets/mark.svg" alt="" /><strong>terminus</strong></div>
        <p>${t('terminus tells you which NUS shuttle bus to catch, from which stop, and when to leave, from your NUSMods timetable.')}</p>
        <p class="hint">${t("terminus is an independent student project, not affiliated with NUS. Bus times come from NUS's shuttle feed. Walking routes and the map use data from OpenStreetMap contributors.")}</p>
      </div>
      <section class="trips-group">
        <h3 class="eyebrow" id="about-links">${t('More')}</h3>
        <nav class="settings-list card about-links" aria-labelledby="about-links">
          ${ABOUT_LINKS().map(({ title, href, where }) => {
            const away = href.startsWith('https:');
            const shown = where ?? (away ? href.replace('https://', '') : location.host + href.replace(/\/$/, ''));
            return html`<a class="settings-row" href=${href} key=${href} rel=${away ? 'noopener' : undefined}>
              <span class="row-text"><span class="row-title">${title}</span><span class="row-sum">${shown}</span></span>
              <svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d=${away ? 'M7 17 17 7M8 7h9v9' : 'm9 6 6 6-6 6'} /></svg>
            </a>`;
          })}
        </nav>
        <p class="hint group-hint">${t('Use terminus in line with the NUS Acceptable Use Policy for IT Resources.')}</p>
      </section>
    </div>
  `;
}

/** Longest note the API takes; the counter turns amber from `NOTE_WARN`. */
const NOTE_MAX = 1000;
const NOTE_WARN = 900;

/**
 * A note to the operator about anything, laid out like a message: who it's
 * from, the note, then a counter and Send. Only an account with an email can
 * send one (so there's someone to reply to); without one, the page asks for
 * an email instead. A wrong answer is better sent from under the card, with
 * the answer.
 */
export function Feedback({ me, onAddEmail }) {
  const [note, setNote] = useState('');
  const [msg, setMsg] = useState('');
  const [sending, setSending] = useState(false);
  const send = async (e) => {
    e.preventDefault();
    if (!note.trim()) return setMsg(t('Write something first.'));
    setSending(true);
    try {
      await api('/me/feedback', { method: 'POST', body: { kind: 'other', note: note.trim(), platform: 'web' } });
      setNote('');
      setMsg(t('Thanks. Your feedback was sent.'));
    } catch (err) {
      setMsg(err.message);
    } finally {
      setSending(false);
    }
  };
  if (!me.email) {
    return html`
      <div class="card add-email">
        <h3>${t('Add an email to send feedback')}</h3>
        <p class="hint">${t('So we can reply to you. Your setup stays as it is.')}</p>
        <button type="button" class="btn accent wide" onClick=${onAddEmail}>${t('Add an email')}</button>
      </div>
    `;
  }
  return html`
    <form class="feedback" onSubmit=${send}>
      <div class="card compose">
        <div class="compose-from">
          <span class="compose-key">${t('From')}</span>
          <span class="compose-who">${me.email}</span>
        </div>
        <textarea
          id="feedback-note"
          rows="6"
          maxlength=${NOTE_MAX}
          aria-label=${t('Ideas, problems, anything')}
          placeholder=${t('Ideas, problems, anything: a place you want to go, something that confused you…')}
          value=${note}
          onInput=${(e) => setNote(e.currentTarget.value)}
        ></textarea>
        <div class="compose-foot">
          <span class=${`compose-count${note.length >= NOTE_WARN ? ' near' : ''}`} aria-live=${note.length >= NOTE_WARN ? 'polite' : 'off'}>
            ${`${note.length} / ${NOTE_MAX}`}
          </span>
          <button type="submit" class="btn small" disabled=${sending || !note.trim()}>${t('Send')}</button>
        </div>
      </div>
      <p class="hint compose-msg" role="status">${msg}</p>
      <div class="card compose-wrong">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 5.5h15v10h-8l-4 3.5v-3.5h-3z" /><path d="M12 8.5v3M12 13.6v.1" /></svg>
        <p><span class="row-title">${t('A wrong answer?')}</span><span class="hint">${t('Press “Is this wrong?” under it, so we see what you saw.')}</span></p>
      </div>
    </form>
  `;
}
