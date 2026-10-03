// Settings' pages: what each group in the list opens (settings.js lays them
// out and moves between them). Each saves as it changes, through the shared
// profile (profile.js).

import { Rich, html, store, useEffect, useMemo, useRef, useState, useStore } from '../assets/ui.js';
import { api, locale, t } from './dom.js';
import {
  campus,
  edit,
  lists,
  profile,
  residenceFor,
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
import { pickedStop } from './search.js';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => t(d));
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
/** Home stops further than this from where you are aren't picked for you. */
const WALK_RADIUS_M = 450;

/** Devices paired, for Devices' line in the list; null until loaded. */
export const deviceCount = store(null);
/** A NUSMods link shared to the app, waiting in the import box for the person to import. */
export const importOffer = store(null);

/* ---------- helpers ---------- */

const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
/** A time of day in this device's clock style ("9:00 AM" or "09:00"), for showing; hhmm is for time inputs. */
const clockMin = (min) => new Date(Date.UTC(2000, 0, 1, Math.floor(min / 60), min % 60)).toLocaleTimeString(locale(), { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' });
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
export function Page({ id, title, children, nodes, onBack, shown, leaving }) {
  return html`
    <section
      class=${leaving ? 'settings-page leaving' : 'settings-page'}
      style=${leaving ? { top: `${leaving.shift}px` } : undefined}
      data-page=${id}
      aria-labelledby=${`page-${id}`}
      hidden=${!shown && !leaving}
      ref=${(n) => (nodes[id] = n)}
    >
      <header class="page-head">
        <button type="button" class="page-back" aria-label=${t('Back')} onClick=${onBack}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 6-6 6 6 6" /></svg>
        </button>
        <h2 id=${`page-${id}`} tabindex="-1">${title}</h2>
      </header>
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

export function Trips() {
  const p = useStore(profile);
  const c = useStore(campus);
  const now = p.home?.stops ?? [];
  const residences = useMemo(() => residencesByName(c), [c]);
  // "Off campus" can be chosen while the stops are a residence's: it stays
  // chosen (to pick stops below) until the stops change.
  const [offCampus, setOffCampus] = useState(false);
  useEffect(() => setOffCampus(false), [now.join()]);
  const [msg, setMsg] = useState('');

  const pick = (idx) => (v) =>
    edit((x) => {
      const next = [...(x.home?.stops ?? [])];
      next[idx] = v;
      const clean = next.filter(Boolean).filter((code, i, a) => a.indexOf(code) === i);
      x.home = clean.length ? { stops: clean } : null;
    });

  // Finds the nearest stops in the browser. The location itself is never sent.
  const locate = () => {
    if (!navigator.geolocation) return setMsg(t('This browser cannot share its location.'));
    setMsg(t('Finding the nearest stops…'));
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        const near = stopsNear(coords.latitude, coords.longitude);
        const within = near.filter((n) => n.d <= WALK_RADIUS_M).slice(0, 2);
        const picked = (within.length ? within : near.slice(0, 1)).map((n) => n.s.code);
        edit((x) => (x.home = { stops: picked }));
        setMsg(
          within.length
            ? t('Picked {0}. Change them if you use a different stop.', picked.map(stopName).join(t(' and ')))
            : t('No stop within {0} m, so we picked the nearest: {1}.', WALK_RADIUS_M, stopName(picked[0])),
        );
      },
      (err) => setMsg(t("Couldn't get your location ({0}). Pick your stops instead.", err.message)),
      { enableHighAccuracy: true, timeout: 10_000 },
    );
  };

  const number = (field, ok, bad, fallback) => (e) => {
    const v = Number(e.currentTarget.value);
    if (ok(v)) edit((x) => (x[field] = v));
    else {
      if (bad) toast(bad);
      e.currentTarget.value = String(p[field] ?? fallback);
    }
  };

  const dayTime = (field) => (e) => {
    const v = toMin(e.currentTarget.value);
    if (v == null) return;
    const next = { ...p, [field]: v };
    if (next.dayStartMin >= next.dayEndMin) {
      toast(t('The start time must be before the end time'));
      e.currentTarget.value = hhmm(p[field]);
      return;
    }
    edit((x) => (x[field] = v));
  };

  return html`
    <div class="card">
      <label for="residence">${t('Where do you live?')}</label>
      <select
        id="residence"
        value=${offCampus ? '' : (residenceFor(now)?.code ?? '')}
        onChange=${(e) => {
          const r = residences.find((x) => x.code === e.currentTarget.value);
          // "Off campus": keep the stops, pick them below.
          if (!r) return setOffCampus(true);
          edit((x) => {
            x.home = { stops: [...r.stops] };
            x.homeWalkMin = residenceWalkMin(r);
          });
        }}
      >
        <option value="">${t("Off campus, or I'll pick stops")}</option>
        ${residences.map((r) => html`<option value=${r.code} key=${r.code}>${r.name}</option>`)}
      </select>
      <p class="hint">${t("If you live on campus, this fills in your stops so the app doesn't direct you home when you're already there.")}</p>
      <label for="home-1">${t('Home stops')}</label>
      <p class="hint">${t('Where your day starts and ends. Only the stops are saved, never where you live.')}</p>
      <div class="row">
        <${StopSelect} id="home-1" aria-label=${t('Main home stop')} value=${now[0]} onChange=${pick(0)} blank=${t('Main stop')} />
        <${StopSelect} id="home-2" aria-label=${t('Second home stop')} value=${now[1]} onChange=${pick(1)} blank=${t('Second stop (optional)')} />
      </div>
      <button type="button" class="link-btn locate" onClick=${locate}>${t('Pick the stops nearest me')}</button>
      <p class="hint" role="status">${msg}</p>
      <label for="home-walk">${t('Walk from home to your stop')}</label>
      <div class="row tight">
        <input id="home-walk" type="number" min="0" max="30" step="1" value=${p.homeWalkMin ?? 5} onChange=${number('homeWalkMin', (v) => Number.isInteger(v) && v >= 0 && v <= 30, t('Between 0 and 30 minutes'), 5)} />
        <span>${t('minutes')}</span>
      </div>
      <p class="hint">${t("Included in your departure time when your location isn't available.")}</p>

      <div class="split">
        <div>
          <label for="day-start">${t('Show buses between')}</label>
          <div class="row tight">
            <input id="day-start" type="time" aria-label=${t('Day starts')} value=${hhmm(p.dayStartMin ?? 360)} onChange=${dayTime('dayStartMin')} />
            <span>${t('and')}</span>
            <input id="day-end" type="time" aria-label=${t('Day ends')} value=${hhmm(p.dayEndMin ?? 1080)} onChange=${dayTime('dayEndMin')} />
          </div>
        </div>
        <div>
          <label for="gap">${t('Go home in gaps longer than')}</label>
          <div class="row tight">
            <input id="gap" type="number" min="0.5" max="12" step="0.5" value=${p.gapHours} onChange=${number('gapHours', (v) => v >= 0.5 && v <= 12, null, 2)} />
            <span>${t('hours')}</span>
          </div>
        </div>
      </div>
      <p class="hint">${t('Outside these hours, the widget shows your next class instead of a bus. Classes that start earlier or end later extend these hours automatically.')}</p>

      <div class="split">
        <div>
          <label for="pace">${t('Walking pace')}</label>
          <select id="pace" value=${p.walkPace ?? 'normal'} onChange=${(e) => edit((x) => (x.walkPace = e.currentTarget.value))}>
            <option value="slow">${t('Slow, about 4 km/h')}</option>
            <option value="normal">${t('Normal, about 4.7 km/h')}</option>
            <option value="fast">${t('Fast, about 5.4 km/h')}</option>
          </select>
        </div>
        <div>
          <label class="check">
            <input id="full-bus" type="checkbox" checked=${p.fullBusMargin !== false} onChange=${(e) => edit((x) => (x.fullBusMargin = e.currentTarget.checked))} />
            ${' '}${t('Aim one bus earlier when the bus is often busy')}
          </label>
        </div>
      </div>
      <p class="hint">${t('Walking times follow campus paths. Your pace applies to every walk except the one from home, which you set above.')}</p>
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
    html`<div id="trip-choices">
      <h3>${t('Your classes')}</h3>
      <ul class="list">
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
    </div>`}
    ${r.history > 0 &&
    html`<div id="trip-history">
      <h3>${t('Trip history')}</h3>
      <p class="hint">${r.history === 1 ? t('1 trip recorded.') : t('{0} trips recorded.', r.history)} ${t('Kept for 35 days and used only to spot classes you often miss or skip.')}</p>
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
    </div>`}
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
  const classes = p.trips.length + p.manual.length;
  // Needed once a semester: folded away while there are classes, unless it's needed now.
  const wanted = classes === 0 || reimport || Boolean(share && msg);
  const [open, setOpen] = useState(wanted);
  useEffect(() => {
    if (wanted) setOpen(true);
  }, [wanted]);
  const shareBox = useRef(null);

  // A NUSMods link shared to the app: in the box, for the person to import.
  // Never imported straight from the URL: any page could link here and
  // replace a signed-in person's timetable. They press Import themselves.
  useEffect(() => {
    if (!offer) return;
    setShare(offer);
    setOpen(true);
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

  return html`
    ${reimport &&
    html`<div class="banner">
      <strong>${t('Re-import your timetable.')}</strong>${' '}
      <span>${t("This link is for {0}, which has ended. Copy this semester's link from NUSMods and import it below.", me.term)}</span>
    </div>`}
    <div class="card">
      <p class="hint">${all.length ? `${all.length === 1 ? t('1 class') : t('{0} classes', all.length)}${term && p.trips.length ? ` · ${term}` : ''}` : ''}</p>
      <p class="hint" role="status">${msg}</p>
      <${Unresolved} list=${unresolved} onDone=${(u) => setUnresolved((l) => l.filter((x) => x !== u))} />
      <div class="classes">
        ${!all.length && !usual.length && html`<p class="hint">${t('No classes yet. Import from NUSMods or add them by hand.')}</p>`}
        ${DAY_ORDER.map((day) => {
          const rows = [...all.filter((r) => r.c.day === day), ...usual.filter((r) => r.u.day === day)].sort((a, b) => (a.c?.arriveByMin ?? a.u.atMin) - (b.c?.arriveByMin ?? b.u.atMin));
          if (!rows.length) return null;
          return html`<div class="day" key=${`d${day}`}>${DAYS[day]}</div>${rows.map((r) => (r.u ? html`<${UsualRow} key=${r.key} u=${r.u} />` : html`<${ClassRow} key=${r.key} c=${r.c} list=${r.list} />`))}`;
        })}
      </div>
      <${AddClass} />
    </div>
    <details class="card import-box" open=${open} onToggle=${(e) => setOpen(e.currentTarget.open)}>
      <summary>${t('Import from NUSMods')}</summary>
      <form onSubmit=${runImport}>
        <label for="share">${t('NUSMods share link')}</label>
        <div class="row">
          <input id="share" ref=${shareBox} type="url" placeholder="https://nusmods.com/timetable/sem-1/share?…" value=${share} onInput=${(e) => setShare(e.currentTarget.value)} />
          <button type="submit" class="btn">${t('Import')}</button>
        </div>
        <p class="hint">${t('In NUSMods: Timetable → Share/Sync → Copy. Re-import each semester.')}</p>
      </form>
    </details>
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
          onClick=${() => edit((x) => (x[list] = x[list].filter((y) => !same(y, c))))}
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
          onClick=${() => edit((x) => (x.usual = (x.usual ?? []).filter((y) => !(y.place === u.place && y.day === u.day && y.atMin === u.atMin))))}
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

/** "Add a class or commitment by hand". */
function AddClass() {
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
    <details class="add">
      <summary>${t('Add a class or commitment by hand')}</summary>
      <form class="grid" onSubmit=${submit}>
        <label>${t('Day')}
          <select name="day" required value=${day} onChange=${(e) => setDay(e.currentTarget.value)}>
            ${[1, 2, 3, 4, 5, 6, 0].map((d) => html`<option value=${String(d)} key=${d}>${[t('Sunday'), t('Monday'), t('Tuesday'), t('Wednesday'), t('Thursday'), t('Friday'), t('Saturday')][d]}</option>`)}
          </select>
        </label>
        <label>${t('Starts')} <input name="start" type="time" required value=${start} onInput=${(e) => setStart(e.currentTarget.value)} /></label>
        <label>${t('Ends')} <input name="end" type="time" ref=${endBox} value=${end} onInput=${(e) => {
          e.currentTarget.setCustomValidity('');
          setEnd(e.currentTarget.value);
        }} /></label>
        <label class="wide">${t('Name')} <input name="label" maxlength="60" required placeholder=${t('e.g. Gym')} value=${label} onInput=${(e) => setLabel(e.currentTarget.value)} /></label>
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
    </details>
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
    <div class="card">
      <p class="hint">${t('Available in one tap from the app, the widget and the menu bar. To go somewhere every week, add it to your timetable.')}</p>
      <ul class="list">
        ${p.places.map((place) => html`<${Place} key=${place.key} place=${place} />`)}
      </ul>
      <form
        id="place-form"
        class="row"
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
          onClick=${() =>
            edit((x) => {
              x.places = x.places.filter((y) => y.key !== place.key);
              x.usual = (x.usual ?? []).filter((u) => u.place !== place.key);
            })}
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
  return html`
    <div class="card">
      ${anonymous
        ? html`<p class="hint">${t('Add an email to use terminus on your other devices too.')}</p>`
        : html`<${Rich} as="p" class="hint" text=${t('Get the <a href="/download/android">Android app</a> or <a href="/download/mac">Mac app</a> and sign in with this email, or pair it here with a code.')} />`}
      ${!anonymous && html`<button type="button" class="btn wide" onClick=${() => setPairing((n) => (n ?? 0) + 1)}>${t('Pair a device')}</button>`}
      ${pairing && html`<${Pairing} key=${pairing} count=${devices?.length ?? 0} reload=${load} />`}
      <ul class="list">
        ${(devices ?? []).map(
          (d) => html`<li key=${d.id}>
            <span><strong>${d.name ?? t('Device')}</strong><div class="meta">${t('Added {0} · used {1}', shortDate(d.created), shortDate(d.lastSeen))}</div></span>
            <button
              type="button"
              class="remove"
              aria-label=${t('Remove {0}', d.name ?? t('Device'))}
              onClick=${async () => {
                await api(`/me/devices/${d.id}`, { method: 'DELETE' });
                load();
              }}
            >${t('Remove')}</button>
          </li>`,
        )}
      </ul>
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
      <div class="qr" ref=${qr} aria-label=${t('QR code to pair a phone')}></div>
      <p class="code">${state.text}</p>
      <p class="hint">${state.hint || t("Scan with your phone's camera, or type the code in the app.")}</p>
    </div>
  `;
}

/* ---------- Language, Appearance ---------- */

export function Language() {
  return html`
    <div class="card">
      <label for="lang">${t('Language')}</label>
      <select
        id="lang"
        value=${window.i18n?.pref() ?? 'auto'}
        onChange=${async (e) => {
          // This browser and the account, so emails and the other devices follow.
          const v = e.currentTarget.value;
          window.i18n?.noteAccount(v);
          await saveNow((x) => (x.lang = v)).catch(() => {});
          window.i18n?.setLang(v);
        }}
      >
        <option value="auto">${t('Follow this browser')}</option>
        <option value="en">English</option>
        <option value="zh">中文</option>
      </select>
      <p class="hint">${t('Also used for emails and on your other devices. Place and bus names stay in English, as on the signs.')}</p>
    </div>
  `;
}

/** This browser's theme: applied at once, with nothing to save. */
export const theme = store(window.theme?.pref() ?? 'auto');

export function Appearance() {
  const now = useStore(theme);
  const choice = (value, label) => html`
    <label class="check">
      <input
        type="radio"
        name="theme"
        value=${value}
        checked=${now === value}
        onChange=${() => {
          window.theme?.set(value);
          theme.set(value);
        }}
      />
      ${' '}${label}
    </label>
  `;
  return html`
    <div class="card">
      <fieldset class="theme-choice">
        <legend>${t('Theme')}</legend>
        ${choice('auto', t('Follow this device'))}${choice('light', t('Light'))}${choice('dark', t('Dark'))}
      </fieldset>
      <p class="hint">${t('Only in this browser.')}</p>
    </div>
  `;
}

/* ---------- Account ---------- */

export function Account({ me, inApp, onAddEmail, onSignOut }) {
  const [msg, setMsg] = useState('');
  return html`
    <div class="card">
      <div class=${inApp ? 'who-row' : 'who-row narrow-only'}>
        <span class="hint">${me.email ?? t('No email')}</span>
        ${me.anonymous === true
          ? html`<button type="button" class="btn small ghost" onClick=${onAddEmail}>${t('Add an email')}</button>`
          : html`<button type="button" class="btn small ghost" onClick=${onSignOut}>${t('Sign out')}</button>`}
      </div>
      <div class="actions">
        <a class="btn ghost small" href="/me/export" download>${t('Download my data')}</a>
        <button
          type="button"
          class="btn ghost small"
          onClick=${async () => {
            if (!confirm(t('Sign out of every browser and device, including this one?'))) return;
            await api('/me/sessions', { method: 'DELETE' });
            location.reload();
          }}
        >${t('Sign out everywhere')}</button>
        <button
          type="button"
          class="btn danger small"
          onClick=${async () => {
            const typed = prompt(t('This deletes your account, timetable, favourites and paired devices immediately. Type DELETE to confirm.'));
            if (typed !== 'DELETE') return;
            try {
              await api('/me', { method: 'DELETE' });
              location.href = '/';
            } catch (err) {
              setMsg(err.message);
            }
          }}
        >${t('Delete account')}</button>
      </div>
      <p class="hint" role="status">${msg}</p>
    </div>
    <${Keys} />
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
    <div class="card">
      <h3>${t('API keys')}</h3>
      <${Rich} as="p" class="hint" text=${t('For your own scripts and projects. See the <a href="/docs">API docs</a>; send the key in the <code>x-api-key</code> header.')} />
      <ul class="list">
        ${keys.map(
          (k) => html`<li key=${k.id}>
            <span><strong>${k.name}</strong><div class="meta">${`…${k.hint} · ${t('made {0}', shortDate(k.created))} · ${k.lastUsed ? t('used {0}', shortDate(k.lastUsed)) : t('never used')}`}</div></span>
            <button
              type="button"
              class="remove"
              aria-label=${t('Revoke {0}', k.name)}
              onClick=${async () => {
                if (!confirm(t('Revoke "{0}"? Anything using it stops working straight away.', k.name))) return;
                await api(`/me/keys/${k.id}`, { method: 'DELETE' });
                setMade(null);
                load();
              }}
            >${t('Revoke')}</button>
          </li>`,
        )}
      </ul>
      <form
        class="row"
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
        <input name="name" maxlength="40" required placeholder=${t("What it's for, e.g. My script")} aria-label=${t('Key name')} value=${name} onInput=${(e) => setName(e.currentTarget.value)} />
        <button type="submit" class="btn">${t('Create')}</button>
      </form>
      ${made &&
      html`<div class="new-key">
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
                toast(t('Select the key and copy it'));
              }
            }}
          >${t('Copy')}</button>
        </div>
        <p class="hint">${t('Try it:')} <code>${`curl -H "x-api-key: ${made}" "${location.origin}/arrivals?stop=COM3"`}</code></p>
      </div>`}
      <p class="hint" role="status">${msg}</p>
    </div>
  `;
}

