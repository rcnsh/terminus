// Settings: the signed-in part of the account page, as a component. It draws
// settings.html into a container and wires it up: the account page (/account/)
// draws it after sign-in and setup, and the web app (/app/) as its Settings
// view. Same origin as the API, so the session cookie just works.

import { api, el, locale, t } from './dom.js';
import { attachSearch } from './search.js';

const tr = t; // where `t` is a class

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => t(d));
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
const WALK_RADIUS_M = 450;

let profile = null;
let term = null; // "Sem 1 2026/27", the semester the imported classes are for
let stops = []; // [{code, name, lat, lon}]
let destinations = []; // the search list from /campus
let residences = []; // on-campus residences and their stops, from /campus

/** Where settings.html was drawn; every lookup stays inside it. */
let root = null;
const $ = (sel) => root.querySelector(sel);
/** Called after anything changes that the answer depends on (the account page redraws its preview). */
let changed = () => {};
/** /me: who's signed in, for Account's line in the list. */
let me = null;
/** Devices paired, for their line in the list; null until loaded. */
let deviceCount = null;


/* ---------- helpers ---------- */

const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const toMin = (v) => (v ? Number(v.slice(0, 2)) * 60 + Number(v.slice(3, 5)) : null);
// A stop's name, or a food court's (favourites and classes can go to one).
const stopName = (code) => stops.find((s) => s.code === code)?.name ?? destinations.find((d) => d.code === code)?.label ?? code;

function haversineM(aLat, aLon, bLat, bLon) {
  const r = (d) => (d * Math.PI) / 180;
  const s = Math.sin(r(bLat - aLat) / 2) ** 2 + Math.cos(r(aLat)) * Math.cos(r(bLat)) * Math.sin(r(bLon - aLon) / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(s)));
}

function stopSelect(value, onChange, { blank } = {}) {
  const sel = el('select', { onchange: () => onChange(sel.value) });
  if (blank) sel.append(el('option', { value: '', textContent: blank }));
  // Keep a food court the class already goes to, rather than showing blank.
  const place = value && !stops.some((s) => s.code === value) ? destinations.find((d) => d.code === value) : null;
  if (place) sel.append(el('option', { value: place.code, textContent: place.label }));
  for (const s of stops) sel.append(el('option', { value: s.code, textContent: s.name }));
  sel.value = value ?? '';
  return sel;
}

/** A picked search result, or text that names one exactly (a code, a stop). */
function resolveWhere(input) {
  if (input.dataset.stop) return input.dataset.stop;
  const t = input.value.trim();
  const lower = t.toLowerCase();
  const hit = destinations.find((d) => d.code.toLowerCase() === lower || d.label.toLowerCase() === lower);
  if (hit) return hit.stopCode;
  const code = t.toUpperCase();
  return stops.some((s) => s.code === code) ? code : null;
}

let favouriteSearch = null;
let toastTimer = null;
function toast(text) {
  const t = $('#saved');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 1800);
}

/* ---------- saving ---------- */

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    try {
      profile = await api('/me/profile', { method: 'PUT', body: profile });
      toast(t('Saved'));
      renderSummaries();
      changed();
    } catch (err) {
      toast(t('Not saved. {0}', err.message));
    }
  }, 400);
}

/** Save straight away, for steps that must land before moving on. */
async function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  profile = await api('/me/profile', { method: 'PUT', body: profile });
  return profile;
}

function nearestStopTo(lat, lon) {
  return stops.map((s) => ({ s, d: haversineM(lat, lon, s.lat, s.lon) })).sort((a, b) => a.d - b.d)[0].s;
}

/** What onboarding.js gets: the page's helpers, and the live profile. */
export const onboardingCtx = {
  el,
  api,
  stopSelect,
  toast,
  nearestStop: nearestStopTo,
  get residences() {
    return residences;
  },
  save: saveNow,
  get profile() {
    return profile;
  },
  onImport: (r) => {
    term = r.term;
  },
  onChange: () => {
    renderHome();
    changed();
  },
};

/** Before anything is typed: favourites, then where classes are. */
function mySuggestions() {
  const places = (profile?.places ?? []).map((p) => ({ code: p.to, label: p.label, stopCode: p.to, kind: 'place' }));
  const seen = new Set();
  const classes = [...(profile?.trips ?? []), ...(profile?.manual ?? [])]
    .filter((t) => !seen.has(t.to) && seen.add(t.to))
    .slice(0, 4)
    .map((t) => ({ code: t.to, label: t.label, stopCode: t.to, kind: 'class' }));
  return [...places.slice(0, 4), ...classes];
}

/**
 * The stops your classes go to, for the top of the favourites picker: one
 * entry per stop, saying which classes use it, leaving out favourites already.
 */
function timetableStops() {
  const byStop = new Map();
  for (const t of [...(profile?.trips ?? []), ...(profile?.manual ?? [])]) {
    const names = byStop.get(t.to) ?? [];
    const name = t.label.split(' @ ')[0];
    if (!names.includes(name)) names.push(name);
    byStop.set(t.to, names);
  }
  const fav = new Set((profile?.places ?? []).map((p) => p.to));
  return [...byStop]
    .filter(([to]) => !fav.has(to))
    .map(([to, names]) => ({ code: to, label: stopName(to), stopCode: to, kind: 'timetable', detail: names.join(', ') }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * A favourite has no name to type: it's called what was picked, short, as
 * it reads on a button ("KR MRT", "The Deck", "COM1" for School of Computing).
 */
function addFavourite(to, label) {
  // One per stop: COM1 and COM 3 would be the same button.
  const same = profile.places.find((p) => p.to === to);
  if (same) return toast(t('Already a favourite: {0}', same.label));
  label = label.slice(0, 24);
  let key = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'place';
  while (profile.places.some((p) => p.key === key)) key = `${key.slice(0, 21)}-${Math.floor(Math.random() * 90 + 10)}`;
  profile.places.push({ key, label, to });
  renderPlaces();
  save();
}

/* ---------- rendering ---------- */

/**
 * Where a class shown on the page is in the profile now. Every save replaces
 * the profile with the server's copy, sorted its own way, so a row finds its
 * class again by what it is, never by where it was.
 */
function findClass(list, t) {
  return profile[list].findIndex((x) => x.day === t.day && x.arriveByMin === t.arriveByMin && x.label === t.label && x.to === t.to);
}

function renderClasses() {
  const box = $('#classes');
  box.replaceChildren();
  const all = [
    ...profile.trips.map((t) => ({ t: { ...t }, list: 'trips' })),
    ...profile.manual.map((t) => ({ t: { ...t }, list: 'manual' })),
  ];
  $('#class-count').textContent = all.length ? `${all.length === 1 ? t('1 class') : t('{0} classes', all.length)}${term && profile.trips.length ? ` · ${term}` : ''}` : '';
  if (!all.length) {
    box.append(el('p', { class: 'hint', textContent: t('No classes yet. Import from NUSMods or add them by hand.') }));
    return;
  }
  for (const day of DAY_ORDER) {
    const rows = all.filter((r) => r.t.day === day).sort((a, b) => a.t.arriveByMin - b.t.arriveByMin);
    if (!rows.length) continue;
    box.append(el('div', { class: 'day', textContent: DAYS[day] }));
    for (const { t, list } of rows) {
      const time = t.endMin ? `${hhmm(t.arriveByMin)}–${hhmm(t.endMin)}` : hhmm(t.arriveByMin);
      const weeks = Array.isArray(t.weeks) && t.weeks.length < 13 ? ` · ${tr('wk {0}–{1}', t.weeks[0], t.weeks.at(-1))}` : '';
      box.append(
        el(
          'div',
          { class: 'cls' },
          el('span', { class: 'time', textContent: time }),
          el('span', { class: 'name', textContent: t.label + weeks, title: t.label }),
          stopSelect(t.to, (v) => {
            const at = findClass(list, t);
            if (at < 0) return;
            profile[list][at].to = v;
            t.to = v;
            save();
          }),
          el('button', {
            type: 'button',
            class: 'remove',
            textContent: tr('Remove'),
            'aria-label': tr('Remove {0}', t.label),
            onclick: () => {
              const at = findClass(list, t);
              if (at >= 0) profile[list].splice(at, 1);
              renderClasses();
              save();
            },
          }),
        ),
      );
    }
  }
}

function renderUnresolved(list) {
  const box = $('#unresolved');
  box.replaceChildren();
  if (!list?.length) return;
  box.append(el('p', { class: 'warn-text', textContent: list.length === 1 ? t("1 class had a venue we couldn't place. Pick the nearest stop, or skip it:") : t("{0} classes had a venue we couldn't place. Pick the nearest stop, or skip it:", list.length) }));
  const ul = el('ul', { class: 'list' });
  for (const u of list) {
    const li = el('li', {}, el('span', { textContent: `${DAYS[u.day]} ${hhmm(u.arriveByMin)} · ${u.module} @ ${u.venue}${u.offCampus ? t(' (off campus)') : ''}` }));
    // The heading goes with the last one placed or skipped.
    const done = () => {
      li.remove();
      if (!ul.children.length) box.replaceChildren();
    };
    li.append(el('button', { type: 'button', class: 'link-btn', textContent: t('Skip'), onclick: done }));
    li.append(
      stopSelect(
        '',
        (v) => {
          if (!v) return;
          profile.manual.push({ day: u.day, arriveByMin: u.arriveByMin, ...(u.endMin ? { endMin: u.endMin } : {}), to: v, label: `${u.module} @ ${u.venue.split('-')[0]}`, venue: u.venue });
          done();
          renderClasses();
          save();
        },
        { blank: t('Choose stop') },
      ),
    );
    ul.append(li);
  }
  box.append(ul);
}

function renderHome() {
  const now = profile.home?.stops ?? [];
  const pick = (idx) => (v) => {
    const next = [...now];
    next[idx] = v;
    const clean = next.filter(Boolean).filter((c, i, a) => a.indexOf(c) === i);
    profile.home = clean.length ? { stops: clean } : null;
    renderHome();
    save();
  };
  $('#home-1').replaceWith(Object.assign(stopSelect(now[0], pick(0), { blank: t('Main stop') }), { id: 'home-1' }));
  $('#home-2').replaceWith(Object.assign(stopSelect(now[1], pick(1), { blank: t('Second stop (optional)') }), { id: 'home-2' }));
  $('#gap').value = profile.gapHours;
  $('#home-walk').value = profile.homeWalkMin ?? 5;
  $('#residence').value = residenceFor(now)?.code ?? '';
  $('#pace').value = profile.walkPace ?? 'normal';
  $('#full-bus').checked = profile.fullBusMargin !== false;
  $('#day-start').value = hhmm(profile.dayStartMin ?? 360);
  $('#day-end').value = hhmm(profile.dayEndMin ?? 1080);
}

function renderPlaces() {
  const ul = $('#places');
  ul.replaceChildren();
  profile.usual ??= [];
  profile.places.forEach((p) => {
    // Usual times (phase 8.3): each one a trip that day, planned like a class.
    const times = profile.usual.filter((u) => u.place === p.key);
    const usual = el(
      'div',
      { class: 'usual' },
      ...times.map((u) =>
        el(
          'span',
          { class: 'usual-time' },
          `${DAYS[u.day]} ${hhmm(u.atMin)}`,
          el('button', {
            type: 'button',
            class: 'remove',
            textContent: '×',
            'aria-label': t('Remove {0}', `${DAYS[u.day]} ${hhmm(u.atMin)}`),
            onclick: () => {
              profile.usual = profile.usual.filter((x) => !(x.place === u.place && x.day === u.day && x.atMin === u.atMin));
              renderPlaces();
              save();
            },
          }),
        ),
      ),
    );
    const day = el('select', { 'aria-label': t('Day') }, ...DAYS.map((d, n) => el('option', { value: String(n), textContent: d, ...(n === 1 ? { selected: true } : {}) })));
    const at = el('input', { type: 'time', 'aria-label': t('Be there at'), required: true });
    const add = el(
      'form',
      {
        class: 'row usual-form',
        onsubmit: (e) => {
          e.preventDefault();
          const atMin = toMin(at.value);
          if (atMin === null) return;
          profile.usual.push({ place: p.key, day: Number(day.value), atMin });
          renderPlaces();
          save();
        },
      },
      day,
      at,
      el('button', { type: 'submit', class: 'btn small ghost', textContent: t('Add') }),
    );
    const more = el('details', { class: 'usual-add' }, el('summary', { textContent: t('Add a usual time') }), add);
    ul.append(
      el(
        'li',
        { class: 'place' },
        el(
          'div',
          { class: 'place-row' },
          // Where it goes, when the name doesn't already say (a building's stop, or a name from before favourites).
          el('span', {}, el('strong', { textContent: p.label }), p.label === stopName(p.to) ? '' : el('span', { class: 'meta', textContent: ` → ${stopName(p.to)}` })),
          el('button', {
            type: 'button',
            class: 'remove',
            textContent: t('Remove'),
            onclick: () => {
              profile.places = profile.places.filter((x) => x.key !== p.key);
              profile.usual = profile.usual.filter((u) => u.place !== p.key);
              renderPlaces();
              save();
            },
          }),
        ),
        usual,
        more,
      ),
    );
  });
}

async function renderDevices() {
  const { devices } = await api('/me/devices');
  const ul = $('#devices');
  ul.replaceChildren();
  const fmt = (ms) => new Date(ms).toLocaleDateString(locale(), { day: 'numeric', month: 'short' });
  for (const d of devices) {
    ul.append(
      el(
        'li',
        {},
        el('span', {}, el('strong', { textContent: d.name ?? t('Device') }), el('div', { class: 'meta', textContent: t('Added {0} · used {1}', fmt(d.created), fmt(d.lastSeen)) })),
        el('button', {
          type: 'button',
          class: 'remove',
          textContent: t('Remove'),
          onclick: async () => {
            await api(`/me/devices/${d.id}`, { method: 'DELETE' });
            renderDevices();
          },
        }),
      ),
    );
  }
  deviceCount = devices.length;
  renderSummaries();
  return devices.length;
}

/* ---------- API keys ---------- */

async function renderKeys() {
  const { keys } = await api('/me/keys');
  const ul = $('#keys');
  ul.replaceChildren();
  const fmt = (ms) => new Date(ms).toLocaleDateString(locale(), { day: 'numeric', month: 'short' });
  for (const k of keys) {
    ul.append(
      el(
        'li',
        {},
        el('span', {}, el('strong', { textContent: k.name }), el('div', { class: 'meta', textContent: `…${k.hint} · ${t('made {0}', fmt(k.created))} · ${k.lastUsed ? t('used {0}', fmt(k.lastUsed)) : t('never used')}` })),
        el('button', {
          type: 'button',
          class: 'remove',
          textContent: t('Revoke'),
          'aria-label': t('Revoke {0}', k.name),
          onclick: async () => {
            if (!confirm(t('Revoke "{0}"? Anything using it stops working straight away.', k.name))) return;
            await api(`/me/keys/${k.id}`, { method: 'DELETE' });
            $('#new-key').hidden = true;
            renderKeys();
          },
        }),
      ),
    );
  }
}

/* ---------- timetable, day, places ---------- */

async function runImport(share) {
  const msg = $('#import-msg');
  msg.textContent = t('Importing…');
  try {
    const r = await api('/me/import', { method: 'POST', body: { share } });
    profile = r.profile;
    term = r.term;
    const n = profile.trips.length;
    const notes = [n === 1 ? t('Imported 1 class for {0}.', r.term) : t('Imported {0} classes for {1}.', n, r.term)];
    if (r.missing?.length) notes.push(r.missing.length === 1 ? t('{0} has no classes that semester.', r.missing[0]) : t('{0} have no classes that semester.', r.missing.join(', ')));
    if (r.online) notes.push(r.online === 1 ? t('1 online lesson skipped.') : t('{0} online lessons skipped.', r.online));
    msg.textContent = notes.join(' ');
    $('#reimport').hidden = true;
    renderClasses();
    renderUnresolved(r.unresolved);
    changed();
  } catch (err) {
    msg.textContent = err.status === 500 ? t('Something went wrong on our side. Your timetable was not changed.') : err.message;
  }
}

/** The residence whose stops are exactly these, if any. Only stops are saved. */
function residenceFor(homeStops) {
  const key = [...homeStops].sort().join();
  return residences.find((r) => [...r.stops].sort().join() === key) ?? null;
}

/** A residence's stops and walk, as home. */
function useResidence(r) {
  profile.home = { stops: [...r.stops] };
  profile.homeWalkMin = Math.max(1, Math.round(r.walkM / 1.3 / 60));
}

/* ---------- trip choices (phase 3) ---------- */

const PREF_TEXT = { earlier: t('One bus earlier'), quiet: t('No reminders') };

/** Classes you leave a bus earlier for or get no reminders for, and the muted question. */
async function renderChoices() {
  let r;
  try {
    r = await api('/me/choices');
  } catch {
    return;
  }
  $('#choice-list').replaceChildren(
    ...r.choices.map((c) =>
      el(
        'li',
        {},
        el('span', {}, el('span', { textContent: c.label ?? t('A class no longer in your timetable') }), el('div', { class: 'meta', textContent: PREF_TEXT[c.pref] })),
        el('button', {
          type: 'button',
          class: 'btn small ghost',
          textContent: t('Undo'),
          onclick: async () => {
            await api('/me/choice', { method: 'POST', body: { trip: c.trip, pref: c.pref, choice: 'undo' } });
            renderChoices();
            changed();
          },
        }),
      ),
    ),
  );
  $('#trip-choices').hidden = !r.choices.length;
  $('#trip-history').hidden = !r.history;
  $('#history-size').textContent = r.history === 1 ? t('1 trip recorded.') : t('{0} trips recorded.', r.history);
}

let pairPoll = null;

/** The QR code library, from cdnjs, the first time a code is shown. */
function loadQr() {
  if (window.qrcode) return Promise.resolve();
  return new Promise((resolve, reject) => {
    document.head.append(
      el('script', {
        src: 'https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js',
        integrity: 'sha384-mZT2gIty7ZDdOGkxfP6joZcYdMW1Jvj9dRlfpTmaJAKKXTqzygtB22k7FLe+KZC1',
        crossOrigin: 'anonymous',
        onload: resolve,
        onerror: reject,
      }),
    );
  });
}

/** The page's controls: each one saves as it changes. */
function wire() {
  $('#key-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = e.target.name.value.trim();
    $('#key-msg').textContent = '';
    try {
      const made = await api('/me/keys', { method: 'POST', body: { name } });
      e.target.reset();
      $('#new-key-value').textContent = made.key;
      $('#new-key-eg').textContent = `curl -H "x-api-key: ${made.key}" "${location.origin}/arrivals?stop=COM3"`;
      $('#new-key').hidden = false;
      renderKeys();
    } catch (err) {
      $('#key-msg').textContent = err.message;
    }
  });

  $('#copy-key').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('#new-key-value').textContent);
      toast(t('Copied'));
    } catch {
      toast(t('Select the key and copy it'));
    }
  });

  $('#import-form').addEventListener('submit', (e) => {
    e.preventDefault();
    runImport($('#share').value);
  });

  $('#manual-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const to = resolveWhere(e.target.where);
    if (!to) {
      e.target.where.setCustomValidity(t('Pick a stop, building or room from the list'));
      e.target.where.reportValidity();
      return;
    }
    const start = toMin(f.get('start'));
    const end = toMin(f.get('end'));
    profile.manual.push({ day: Number(f.get('day')), arriveByMin: start, ...(end && end > start ? { endMin: end } : {}), to, label: f.get('label').trim(), venue: '' });
    e.target.reset();
    delete e.target.where.dataset.stop;
    renderClasses();
    save();
  });

  // Picking from the list adds it; Enter on a typed stop code or name does too.
  $('#place-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const to = resolveWhere(e.target.where);
    if (!to) {
      e.target.where.setCustomValidity(t('Pick a stop, building or room from the list'));
      e.target.where.reportValidity();
      return;
    }
    addFavourite(to, stopName(to));
    favouriteSearch.clear();
  });

  for (const form of ['#manual-form', '#place-form']) {
    $(form).where.addEventListener('input', (e) => e.target.setCustomValidity(''));
  }

  $('#gap').addEventListener('change', (e) => {
    const v = Number(e.target.value);
    if (v >= 0.5 && v <= 12) {
      profile.gapHours = v;
      save();
    }
  });

  $('#residence').addEventListener('change', (e) => {
    const r = residences.find((x) => x.code === e.target.value);
    if (!r) return; // "Off campus": keep the stops, pick them below
    useResidence(r);
    renderHome();
    save();
  });

  // This browser and the account, so emails and the other devices follow.
  $('#lang').addEventListener('change', async (e) => {
    const v = e.target.value;
    profile.lang = v;
    window.i18n?.noteAccount(v);
    await saveNow().catch(() => {});
    window.i18n?.setLang(v);
  });

  // This browser only, so straight away, with nothing to save.
  for (const radio of root.querySelectorAll('input[name="theme"]')) {
    radio.checked = radio.value === (window.theme?.pref() ?? 'auto');
    radio.addEventListener('change', () => {
      window.theme?.set(radio.value);
      renderSummaries();
    });
  }

  $('#pace').addEventListener('change', (e) => {
    profile.walkPace = e.target.value;
    save();
  });
  $('#full-bus').addEventListener('change', (e) => {
    profile.fullBusMargin = e.target.checked;
    save();
  });

  $('#clear-history').addEventListener('click', async () => {
    if (!confirm(t("Clear your trip history? Your settings won't change."))) return;
    await api('/me/history', { method: 'DELETE' });
    toast(t('Trip history cleared'));
    renderChoices();
    changed();
  });
  document.addEventListener('trip-choices', renderChoices);

  $('#home-walk').addEventListener('change', (e) => {
    const v = Number(e.target.value);
    if (Number.isInteger(v) && v >= 0 && v <= 30) {
      profile.homeWalkMin = v;
      save();
    } else {
      toast(t('Between 0 and 30 minutes'));
      e.target.value = profile.homeWalkMin ?? 5;
    }
  });

  for (const [id, field] of [['#day-start', 'dayStartMin'], ['#day-end', 'dayEndMin']]) {
    $(id).addEventListener('change', (e) => {
      const v = toMin(e.target.value);
      if (v == null) return;
      const next = { ...profile, [field]: v };
      if (next.dayStartMin >= next.dayEndMin) {
        toast(t('The start time must be before the end time'));
        e.target.value = hhmm(profile[field]);
        return;
      }
      profile[field] = v;
      save();
    });
  }

  // Finds the nearest stops in the browser. The location itself is never sent.
  $('#locate').addEventListener('click', () => {
    const msg = $('#home-msg');
    if (!navigator.geolocation) {
      msg.textContent = t('This browser cannot share its location.');
      return;
    }
    msg.textContent = t('Finding the nearest stops…');
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        const near = stops.map((s) => ({ s, d: haversineM(coords.latitude, coords.longitude, s.lat, s.lon) })).sort((a, b) => a.d - b.d);
        const within = near.filter((n) => n.d <= WALK_RADIUS_M).slice(0, 2);
        const picked = (within.length ? within : near.slice(0, 1)).map((n) => n.s.code);
        profile.home = { stops: picked };
        msg.textContent = within.length
          ? t('Picked {0}. Change them if you use a different stop.', picked.map(stopName).join(t(' and ')))
          : t('No stop within {0} m, so we picked the nearest: {1}.', WALK_RADIUS_M, stopName(picked[0]));
        renderHome();
        save();
      },
      (err) => {
        msg.textContent = t("Couldn't get your location ({0}). Pick your stops instead.", err.message);
      },
      { enableHighAccuracy: true, timeout: 10_000 },
    );
  });

  /* ---------- devices ---------- */

  $('#pair').addEventListener('click', async () => {
    let code, expires;
    try {
      ({ code, expires } = await api('/me/pair-code', { method: 'POST' }));
    } catch (err) {
      clearInterval(pairPoll);
      $('#pairing').hidden = false;
      $('#qr').replaceChildren();
      $('#pair-code').textContent = '';
      $('#pair-hint').textContent = err.message;
      return;
    }
    const link = `${location.origin}/pair?code=${code}`;
    $('#pairing').hidden = false;
    await loadQr().catch(() => {});
    if (window.qrcode) {
      const qr = window.qrcode(0, 'M');
      qr.addData(link);
      qr.make();
      $('#qr').innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
    }
    const before = await renderDevices();
    clearInterval(pairPoll);
    const tick = async () => {
      const left = Math.max(0, Math.round((expires - Date.now()) / 1000));
      $('#pair-code').textContent = left ? `${code.slice(0, 3)} ${code.slice(3)}` : t('Expired');
      $('#pair-hint').textContent = left
        ? t("Scan with your phone's camera, or type the code in the app. Expires in {0}.", `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`)
        : t('Get a new code to pair.');
      if (!left) {
        $('#qr').replaceChildren();
        return clearInterval(pairPoll);
      }
      // Hide the code once a device has used it.
      if (left % 4 === 0 && (await renderDevices()) > before) {
        clearInterval(pairPoll);
        $('#qr').replaceChildren();
        $('#pair-code').textContent = t('Paired');
        $('#pair-hint').textContent = t('That device is now signed in.');
        changed();
      }
    };
    tick();
    pairPoll = setInterval(tick, 1000);
  });

  /* ---------- account ---------- */

  $('#signout-all').addEventListener('click', async () => {
    if (!confirm(t('Sign out of every browser and device, including this one?'))) return;
    await api('/me/sessions', { method: 'DELETE' });
    location.reload();
  });

  $('#delete').addEventListener('click', async () => {
    const typed = prompt(t('This deletes your account, timetable, favourites and paired devices immediately. Type DELETE to confirm.'));
    if (typed !== 'DELETE') return;
    try {
      await api('/me', { method: 'DELETE' });
      location.href = '/';
    } catch (err) {
      $('#account-msg').textContent = err.message;
    }
  });
}

/* ---------- pages ---------- */

const PAGES = ['trips', 'timetable', 'favourites', 'notifications', 'devices', 'language', 'appearance', 'account'];
/** The addresses: the list's (#settings in the web app, none on the account page) and a page's prefix. */
let listHash = '';
let pageHash = '#';
/** Wide enough for the list and a page side by side (as in account.css). */
const wide = window.matchMedia('(min-width: 900px)');
/** The page on screen (null: the list); undefined before the first draw. */
let shown;
/** Where the list was scrolled to, for coming back to it. */
let listScroll = 0;
/** Opened from the list here, so Back is the browser's. */
let pushed = false;
/** Slides under way, finished at once by the next change. */
let sliding = [];
/** How far a swipe back had moved the page when it was let go, in px. */
let swipedTo = 0;

const pageNode = (p) => root.querySelector(`.settings-page[data-page="${p}"]`);
const rowNode = (p) => root.querySelector(`.settings-row[data-page="${p}"]`);

/** The page the address names, if it's one that's shown here. */
function pageInAddress() {
  const p = location.hash.startsWith(pageHash) ? location.hash.slice(pageHash.length) : '';
  return PAGES.includes(p) && !rowNode(p).hidden ? p : null;
}

/** What each group has set, a line under its name in the list. */
function renderSummaries() {
  if (!root || !profile) return;
  const sum = (p, text) => {
    root.querySelector(`[data-sum="${p}"]`).textContent = text;
  };
  const pace = { slow: t('Slow'), normal: t('Normal'), fast: t('Fast') }[profile.walkPace ?? 'normal'] ?? t('Normal');
  const home = profile.home?.stops?.[0];
  sum('trips', `${home ? stopName(home) : t('No home stop yet')} · ${t('{0} pace', pace)}`);
  const classes = profile.trips.length + profile.manual.length;
  sum('timetable', me?.needsReimport && !$('#reimport').hidden ? t('Re-import needed') : classes === 0 ? t('No classes yet') : classes === 1 ? t('1 class') : t('{0} classes', classes));
  sum('favourites', profile.places.map((p) => p.label).join(', ') || t('None yet'));
  const notify = $('#notify-on');
  sum('notifications', notify?.dataset.on ? t('On for this device') : t('Off'));
  sum('devices', me?.anonymous ? t('Add an email to use other devices') : deviceCount === null ? '' : deviceCount === 1 ? t('1 device') : t('{0} devices', deviceCount));
  sum('language', { en: 'English', zh: '中文' }[window.i18n?.pref()] ?? t('Follow this browser'));
  sum('appearance', { light: t('Light'), dark: t('Dark') }[window.theme?.pref()] ?? t('Follow this device'));
  sum('account', me?.email ?? t('No email'));
}

/**
 * Shows the page the address names, or the list. On a phone one replaces
 * the other, sliding in from the side (a fade with reduced motion); side by
 * side, a page is always open, the first until another is chosen.
 */
function showPage() {
  // Somewhere else in the web app (Now, Map): settings stay as they are.
  if (listHash && !location.hash.startsWith(listHash)) return;
  const page = pageInAddress() ?? (wide.matches ? 'trips' : null);
  if (page === shown) return;
  for (const a of sliding) a.finish();
  sliding = [];
  const prev = shown;
  const from = window.scrollY;
  shown = page;
  renderSummaries();
  root.firstElementChild.classList.toggle('page-open', page !== null);
  for (const p of PAGES) {
    pageNode(p).hidden = p !== page;
    if (p === page) rowNode(p).setAttribute('aria-current', 'page');
    else rowNode(p).removeAttribute('aria-current');
  }
  if (prev === undefined || wide.matches) return;
  if (page) listScroll = from;
  const to = page ? 0 : listScroll;
  window.scrollTo(0, to);
  // Drawn only when Settings is on screen (not while the web app shows another tab).
  if (root.closest('[hidden]') || document.visibilityState !== 'visible') return;
  const list = $('.settings-side');
  slide(page ? list : pageNode(prev), page ? pageNode(page) : list, Boolean(page), to - from);
  if (page) $(`#page-${page}`).focus({ preventScroll: true });
  else rowNode(prev).focus({ preventScroll: true });
}

/** The old view slides away under the new one; `shift` keeps the old one where it was on screen. */
function slide(out, into, forward, shift) {
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const timing = { duration: reduce ? 150 : 300, easing: 'cubic-bezier(0.2, 0, 0, 1)' };
  out.classList.add('leaving');
  out.hidden = false;
  out.style.top = `${shift}px`;
  const gone = forward ? 'translateX(-25%)' : 'translateX(100%)';
  const from = !forward && swipedTo ? `translateX(${swipedTo}px)` : 'none';
  swipedTo = 0;
  const outFrames = reduce ? [{ opacity: 1 }, { opacity: 0 }] : [{ transform: from, opacity: 1 }, { transform: gone, opacity: forward ? 0 : 1 }];
  const inFrames = reduce ? [{ opacity: 0 }, { opacity: 1 }] : [{ transform: forward ? 'translateX(100%)' : 'translateX(-25%)', opacity: forward ? 1 : 0 }, { transform: 'none', opacity: 1 }];
  const a = out.animate(outFrames, timing);
  const b = into.animate(inFrames, timing);
  sliding = [a, b];
  a.finished
    .catch(() => {})
    .finally(() => {
      out.classList.remove('leaving');
      out.style.top = '';
      if (out.classList.contains('settings-page') && out.dataset.page !== shown) out.hidden = true;
    });
}

/** Opens a page from the list, as a new entry in the browser's history. */
function openPage(p) {
  pushed = true;
  location.hash = pageHash + p;
}

/** Back to the list: the browser's Back when the page was opened here, so history stays in step. */
function closePage() {
  if (pushed) {
    pushed = false;
    history.back();
  } else if (listHash) {
    location.hash = listHash;
  } else {
    history.pushState(null, '', location.pathname + location.search);
    showPage();
  }
}

/**
 * Swiping from the left edge goes back, in the installed app on an iPhone:
 * it has no browser swipe of its own. The page follows the finger.
 */
function wireSwipe() {
  if (navigator.standalone !== true) return;
  let start = null;
  root.addEventListener('touchstart', (e) => {
    const page = shown && !wide.matches ? pageNode(shown) : null;
    const tch = e.touches[0];
    start = page && e.touches.length === 1 && tch.clientX < 24 ? { x: tch.clientX, y: tch.clientY, page, dx: 0 } : null;
  }, { passive: true });
  root.addEventListener('touchmove', (e) => {
    if (!start) return;
    const tch = e.touches[0];
    const dx = Math.max(0, tch.clientX - start.x);
    if (start.dx === 0 && Math.abs(tch.clientY - start.y) > dx) {
      start = null;
      return;
    }
    start.dx = dx;
    start.page.style.transform = `translateX(${dx}px)`;
  }, { passive: true });
  const end = () => {
    if (!start) return;
    const { page, dx } = start;
    start = null;
    page.style.transform = '';
    if (dx > window.innerWidth / 3) {
      swipedTo = dx;
      closePage();
    } else if (dx > 0) {
      page.animate([{ transform: `translateX(${dx}px)` }, { transform: 'none' }], { duration: 200, easing: 'cubic-bezier(0.2, 0, 0, 1)' });
    }
  };
  root.addEventListener('touchend', end);
  root.addEventListener('touchcancel', end);
}

/* ---------- drawing ---------- */

/**
 * Draws settings into `into` for the signed-in account `account` (from /me),
 * and loads what they show. `inApp`: in the web app, which shows the answer
 * on Now (so no preview here), has no header (so Sign out is here), and keeps
 * its tab in the address (#settings, #settings/trips). `notify`: the app's
 * "Notify me when to leave", for the Notifications page. `onChange` runs
 * after anything the answer depends on changes.
 */
export async function mountSettings(into, { me: account, inApp = false, notify = null, onChange = () => {} }) {
  const res = await fetch('/account/settings.html', { credentials: 'same-origin' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  into.innerHTML = await res.text();
  root = into;
  me = account;
  changed = onChange;
  if (inApp) {
    listHash = '#settings';
    pageHash = '#settings/';
  }
  if (notify) {
    $('#notify-slot').append(notify);
    rowNode('notifications').hidden = false;
  }
  if (inApp) {
    $('.side-preview').remove();
    $('#who-row').hidden = false;
    $('#who-email').textContent = me.email ?? t('No email');
    $('#who-add-email').hidden = me.anonymous !== true;
    $('#who-logout').hidden = me.anonymous === true;
    $('#who-logout').addEventListener('click', async () => {
      await api('/auth/logout', { method: 'POST' }).catch(() => {});
      location.reload();
    });
    // The account page's sign-in card, then back to the app.
    $('#who-add-email').addEventListener('click', () => location.assign('/account/?add=1&next=/app/'));
  }
  window.i18n?.translate(root);
  wire();
  wireSwipe();
  for (const p of PAGES) {
    rowNode(p).addEventListener('click', () => (shown === p ? null : openPage(p)));
    pageNode(p).querySelector('.page-back').addEventListener('click', closePage);
  }
  window.addEventListener('hashchange', showPage);
  wide.addEventListener('change', showPage);

  if (me.anonymous === true) {
    // Signing out would leave no way back in, so it's Add an email instead.
    $('#pair').hidden = true;
    $('#devices-hint').textContent = t('Add an email to use terminus on your other devices too.');
    if (!inApp) $('#report-hint').textContent = t('This sends the answer above and your note. Add an email if you want a reply.');
  }
  term = me.term;
  $('#reimport').hidden = !me.needsReimport;
  $('#reimport-text').textContent = t("This link is for {0}, which has ended. Copy this semester's link from NUSMods and import it below.", me.term);

  const [p, campus] = await Promise.all([api('/me/profile'), api('/campus')]);
  profile = p;
  // The account's language (phase 10): one chosen on another device is used
  // here; one chosen here before the account had one goes to the account.
  const mine = window.i18n?.followAccount(profile.lang ?? 'auto');
  if (mine) {
    profile.lang = mine;
    save();
  }
  $('#lang').value = window.i18n?.pref() ?? 'auto';
  stops = campus.stops.map(({ code, name, lat, lon }) => ({ code, name, lat, lon })).sort((a, b) => a.name.localeCompare(b.name));

  destinations = campus.destinations;
  residences = (campus.residences ?? []).sort((a, b) => a.name.localeCompare(b.name));
  for (const r of residences) $('#residence').append(el('option', { value: r.code, textContent: r.name }));
  attachSearch($('#manual-form').where, { source: () => destinations, suggestions: mySuggestions, stopName });
  favouriteSearch = attachSearch($('#place-form').where, {
    source: () => destinations,
    pinned: timetableStops,
    suggestions: timetableStops,
    stopName,
    onPick: (d) => {
      addFavourite(d.kind === 'landmark' ? d.code : d.stopCode, d.kind === 'building' || d.kind === 'room' ? d.code : d.label);
      favouriteSearch.clear();
    },
  });
  render();
}

/** Everything drawn from the profile, after it was loaded or changed elsewhere. */
export function render() {
  if (profile.share) $('#share').value = profile.share;
  renderClasses();
  renderHome();
  renderPlaces();
  showPage();
  renderSummaries();
}

/** The lists the server keeps apart from the profile. */
export const renderLists = () => Promise.all([renderDevices(), renderKeys(), renderChoices()]);

/**
 * The profile again, for coming back to settings in the web app: a stop may
 * have been saved as a place from the map meanwhile. Not while a change here
 * is still waiting to be saved, which would be lost.
 */
export async function reload() {
  if (!root || saveTimer) return;
  profile = await api('/me/profile');
  render();
  await renderLists();
}

/** A NUSMods link shared to the app: in the box, for the person to import. */
export function offerImport(link) {
  if (shown !== 'timetable') openPage('timetable');
  $('#share').value = link;
  $('#share').scrollIntoView({ block: 'center' });
  // Never import straight from the URL: any page could link here and
  // replace a signed-in person's timetable. They press Import themselves.
  $('#import-msg').textContent = t('Press Import to replace your timetable with this one.');
}
