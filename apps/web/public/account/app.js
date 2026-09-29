// Account page. Same origin as the API, so the session cookie just works.

import { pacePrompt, runOnboarding } from './onboarding.js';
import { attachSearch } from './search.js';
import { $, api, el } from './dom.js';
import { renderPreview } from './preview.js';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
const WALK_RADIUS_M = 450;

let profile = null;
let term = null; // "Sem 1 2026/27", the semester the imported classes are for
let stops = []; // [{code, name, lat, lon}]
let destinations = []; // the search list from /campus
let residences = []; // on-campus residences and their stops, from /campus

/* ---------- helpers ---------- */

const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const toMin = (v) => (v ? Number(v.slice(0, 2)) * 60 + Number(v.slice(3, 5)) : null);
// A stop's name, or a food court's (saved places and classes can go to one).
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
    try {
      profile = await api('/me/profile', { method: 'PUT', body: profile });
      toast('Saved');
      renderPreview();
    } catch (err) {
      toast(`Not saved: ${err.message}`);
    }
  }, 400);
}

/** Save straight away, for steps that must land before moving on. */
async function saveNow() {
  clearTimeout(saveTimer);
  profile = await api('/me/profile', { method: 'PUT', body: profile });
  return profile;
}

function nearestStopTo(lat, lon) {
  return stops.map((s) => ({ s, d: haversineM(lat, lon, s.lat, s.lon) })).sort((a, b) => a.d - b.d)[0].s;
}

/** What onboarding.js gets: the page's helpers, and the live profile. */
const onboardingCtx = {
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
    renderPreview();
  },
};

/** Before anything is typed: saved places, then where classes are. */
function mySuggestions() {
  const places = (profile?.places ?? []).map((p) => ({ code: p.to, label: p.label, stopCode: p.to, kind: 'place' }));
  const seen = new Set();
  const classes = [...(profile?.trips ?? []), ...(profile?.manual ?? [])]
    .filter((t) => !seen.has(t.to) && seen.add(t.to))
    .slice(0, 4)
    .map((t) => ({ code: t.to, label: t.label, stopCode: t.to, kind: 'class' }));
  return [...places.slice(0, 4), ...classes];
}

/* ---------- widget preview ---------- */

/* ---------- rendering ---------- */

function renderClasses() {
  const box = $('#classes');
  box.replaceChildren();
  const all = [
    ...profile.trips.map((t, i) => ({ t, list: 'trips', i })),
    ...profile.manual.map((t, i) => ({ t, list: 'manual', i })),
  ];
  $('#class-count').textContent = all.length ? `${all.length} class${all.length === 1 ? '' : 'es'}${term && profile.trips.length ? ` · ${term}` : ''}` : '';
  if (!all.length) {
    box.append(el('p', { class: 'hint', textContent: 'No classes yet. Import from NUSMods or add them by hand.' }));
    return;
  }
  for (const day of DAY_ORDER) {
    const rows = all.filter((r) => r.t.day === day).sort((a, b) => a.t.arriveByMin - b.t.arriveByMin);
    if (!rows.length) continue;
    box.append(el('div', { class: 'day', textContent: DAYS[day] }));
    for (const { t, list, i } of rows) {
      const time = t.endMin ? `${hhmm(t.arriveByMin)}–${hhmm(t.endMin)}` : hhmm(t.arriveByMin);
      const weeks = Array.isArray(t.weeks) && t.weeks.length < 13 ? ` · wk ${t.weeks[0]}–${t.weeks.at(-1)}` : '';
      box.append(
        el(
          'div',
          { class: 'cls' },
          el('span', { class: 'time', textContent: time }),
          el('span', { class: 'name', textContent: t.label + weeks, title: t.label }),
          stopSelect(t.to, (v) => {
            profile[list][i].to = v;
            save();
          }),
          el('button', {
            type: 'button',
            class: 'remove',
            textContent: 'Remove',
            'aria-label': `Remove ${t.label}`,
            onclick: () => {
              profile[list].splice(i, 1);
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
  box.append(el('p', { class: 'warn-text', textContent: `${list.length} class${list.length === 1 ? '' : 'es'} had a venue we couldn't place. Pick the nearest stop, or skip it:` }));
  const ul = el('ul', { class: 'list' });
  for (const u of list) {
    const li = el('li', {}, el('span', { textContent: `${DAYS[u.day]} ${hhmm(u.arriveByMin)} · ${u.module} @ ${u.venue}${u.offCampus ? ' (off campus)' : ''}` }));
    li.append(el('button', { type: 'button', class: 'link-btn', textContent: 'Skip', onclick: () => li.remove() }));
    li.append(
      stopSelect(
        '',
        (v) => {
          if (!v) return;
          profile.manual.push({ day: u.day, arriveByMin: u.arriveByMin, ...(u.endMin ? { endMin: u.endMin } : {}), to: v, label: `${u.module} @ ${u.venue.split('-')[0]}`, venue: u.venue });
          li.remove();
          renderClasses();
          save();
        },
        { blank: 'Choose stop' },
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
  $('#home-1').replaceWith(Object.assign(stopSelect(now[0], pick(0), { blank: 'Main stop' }), { id: 'home-1' }));
  $('#home-2').replaceWith(Object.assign(stopSelect(now[1], pick(1), { blank: 'Second stop (optional)' }), { id: 'home-2' }));
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
  profile.places.forEach((p, i) => {
    ul.append(
      el(
        'li',
        {},
        el('span', {}, el('strong', { textContent: p.label }), el('span', { class: 'meta', textContent: ` → ${stopName(p.to)}` })),
        el('button', {
          type: 'button',
          class: 'remove',
          textContent: 'Remove',
          onclick: () => {
            profile.places.splice(i, 1);
            renderPlaces();
            save();
          },
        }),
      ),
    );
  });
}

async function renderDevices() {
  const { devices } = await api('/me/devices');
  const ul = $('#devices');
  ul.replaceChildren();
  const fmt = (ms) => new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  for (const d of devices) {
    ul.append(
      el(
        'li',
        {},
        el('span', {}, el('strong', { textContent: d.name ?? 'Device' }), el('div', { class: 'meta', textContent: `Added ${fmt(d.created)} · used ${fmt(d.lastSeen)}` })),
        el('button', {
          type: 'button',
          class: 'remove',
          textContent: 'Remove',
          onclick: async () => {
            await api(`/me/devices/${d.id}`, { method: 'DELETE' });
            renderDevices();
          },
        }),
      ),
    );
  }
  return devices.length;
}

/* ---------- API keys ---------- */

async function renderKeys() {
  const { keys } = await api('/me/keys');
  const ul = $('#keys');
  ul.replaceChildren();
  const fmt = (ms) => new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  for (const k of keys) {
    ul.append(
      el(
        'li',
        {},
        el('span', {}, el('strong', { textContent: k.name }), el('div', { class: 'meta', textContent: `…${k.hint} · made ${fmt(k.created)} · ${k.lastUsed ? `used ${fmt(k.lastUsed)}` : 'never used'}` })),
        el('button', {
          type: 'button',
          class: 'remove',
          textContent: 'Revoke',
          'aria-label': `Revoke ${k.name}`,
          onclick: async () => {
            if (!confirm(`Revoke "${k.name}"? Anything using it stops working straight away.`)) return;
            await api(`/me/keys/${k.id}`, { method: 'DELETE' });
            $('#new-key').hidden = true;
            renderKeys();
          },
        }),
      ),
    );
  }
}

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
    toast('Copied');
  } catch {
    toast('Select the key and copy it');
  }
});

/* ---------- sign in ---------- */

let turnstileToken = null;

async function setupTurnstile() {
  const { turnstileSiteKey } = await api('/auth/config').catch(() => ({}));
  if (!turnstileSiteKey) return;
  await new Promise((resolve, reject) => {
    const s = el('script', { src: 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit', onload: resolve, onerror: reject });
    document.head.append(s);
  });
  window.turnstile.render('#turnstile-box', {
    sitekey: turnstileSiteKey,
    callback: (t) => (turnstileToken = t),
    'expired-callback': () => (turnstileToken = null),
  });
}

async function sendLink(email) {
  return api('/auth/login', { method: 'POST', body: { email, turnstile: turnstileToken } });
}

function resetTurnstile() {
  turnstileToken = null;
  if (typeof window.turnstile?.reset === 'function') window.turnstile.reset('#turnstile-box');
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#login-msg');
  const btn = e.target.querySelector('button');
  const email = $('#login-email').value.trim();
  err.textContent = '';
  btn.disabled = true;
  btn.textContent = 'Sending…';
  try {
    await sendLink(email);
    $('#sent-to').textContent = email;
    $('#login-step').hidden = true;
    $('#sent-step').hidden = false;
  } catch (e2) {
    err.textContent = e2.message;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Email me a sign-in link';
    resetTurnstile();
  }
});

$('#different').addEventListener('click', () => {
  $('#sent-step').hidden = true;
  $('#login-step').hidden = false;
  $('#login-email').select();
});

// Resending needs a fresh Turnstile pass, so it goes back to the form.
$('#resend').addEventListener('click', () => {
  $('#sent-step').hidden = true;
  $('#login-step').hidden = false;
  $('#login-msg').textContent = 'Complete the check below, then send again.';
});

$('#logout').addEventListener('click', async () => {
  await api('/auth/logout', { method: 'POST' }).catch(() => {});
  location.reload();
});

/* ---------- timetable, day, places ---------- */

async function runImport(share) {
  const msg = $('#import-msg');
  msg.textContent = 'Importing…';
  try {
    const r = await api('/me/import', { method: 'POST', body: { share } });
    profile = r.profile;
    term = r.term;
    const n = profile.trips.length;
    const notes = [`Imported ${n} class${n === 1 ? '' : 'es'} for ${r.term}.`];
    if (r.missing?.length) notes.push(`${r.missing.join(', ')} ${r.missing.length === 1 ? 'has' : 'have'} no classes that semester.`);
    if (r.online) notes.push(`${r.online} online lesson${r.online === 1 ? '' : 's'} skipped.`);
    msg.textContent = notes.join(' ');
    $('#reimport').hidden = true;
    renderClasses();
    renderUnresolved(r.unresolved);
    renderPreview();
  } catch (err) {
    msg.textContent = err.status === 500 ? 'Something went wrong on our side. Your timetable was not changed.' : err.message;
  }
}

$('#import-form').addEventListener('submit', (e) => {
  e.preventDefault();
  runImport($('#share').value);
});
$('#reimport-now').addEventListener('click', () => runImport(profile.share));

$('#manual-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const to = resolveWhere(e.target.where);
  if (!to) {
    e.target.where.setCustomValidity('Pick a stop, building or room from the list');
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

$('#place-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const to = resolveWhere(e.target.where);
  if (!to) {
    e.target.where.setCustomValidity('Pick a stop, building or room from the list');
    e.target.where.reportValidity();
    return;
  }
  const label = f.get('label').trim();
  let key = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'place';
  while (profile.places.some((p) => p.key === key)) key = `${key.slice(0, 21)}-${Math.floor(Math.random() * 90 + 10)}`;
  profile.places.push({ key, label, to });
  e.target.reset();
  delete e.target.where.dataset.stop;
  renderPlaces();
  save();
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

$('#residence').addEventListener('change', (e) => {
  const r = residences.find((x) => x.code === e.target.value);
  if (!r) return; // "Off campus": keep the stops, pick them below
  useResidence(r);
  renderHome();
  save();
});

$('#pace').addEventListener('change', (e) => {
  profile.walkPace = e.target.value;
  save();
});
$('#full-bus').addEventListener('change', (e) => {
  profile.fullBusMargin = e.target.checked;
  save();
});

$('#home-walk').addEventListener('change', (e) => {
  const v = Number(e.target.value);
  if (Number.isInteger(v) && v >= 0 && v <= 30) {
    profile.homeWalkMin = v;
    save();
  } else {
    toast('Between 0 and 30 minutes');
    e.target.value = profile.homeWalkMin ?? 5;
  }
});

for (const [id, field] of [['#day-start', 'dayStartMin'], ['#day-end', 'dayEndMin']]) {
  $(id).addEventListener('change', (e) => {
    const v = toMin(e.target.value);
    if (v == null) return;
    const next = { ...profile, [field]: v };
    if (next.dayStartMin >= next.dayEndMin) {
      toast('The day has to start before it ends');
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
    msg.textContent = 'This browser cannot share its location.';
    return;
  }
  msg.textContent = 'Finding the nearest stops…';
  navigator.geolocation.getCurrentPosition(
    ({ coords }) => {
      const near = stops.map((s) => ({ s, d: haversineM(coords.latitude, coords.longitude, s.lat, s.lon) })).sort((a, b) => a.d - b.d);
      const within = near.filter((n) => n.d <= WALK_RADIUS_M).slice(0, 2);
      const picked = (within.length ? within : near.slice(0, 1)).map((n) => n.s.code);
      profile.home = { stops: picked };
      msg.textContent = within.length
        ? `Picked ${picked.map(stopName).join(' and ')}. Change them if you use a different stop.`
        : `No stop within ${WALK_RADIUS_M} m, so we picked the nearest: ${stopName(picked[0])}.`;
      renderHome();
      save();
    },
    (err) => {
      msg.textContent = `Couldn't get your location (${err.message}). Pick your stops instead.`;
    },
    { enableHighAccuracy: true, timeout: 10_000 },
  );
});

/* ---------- devices ---------- */

let pairPoll = null;
$('#pair').addEventListener('click', async () => {
  const { code, expires } = await api('/me/pair-code', { method: 'POST' });
  const link = `${location.origin}/pair?code=${code}`;
  $('#pairing').hidden = false;
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
    $('#pair-code').textContent = left ? `${code.slice(0, 3)} ${code.slice(3)}` : 'Expired';
    $('#pair-hint').textContent = left
      ? `Scan with your phone's camera, or type the code in the app. Expires in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}.`
      : 'Get a new code to pair.';
    if (!left) {
      $('#qr').replaceChildren();
      return clearInterval(pairPoll);
    }
    // Hide the code once a device has used it.
    if (left % 4 === 0 && (await renderDevices()) > before) {
      clearInterval(pairPoll);
      $('#qr').replaceChildren();
      $('#pair-code').textContent = 'Paired';
      $('#pair-hint').textContent = 'That device is now signed in.';
      renderPreview();
    }
  };
  tick();
  pairPoll = setInterval(tick, 1000);
});

/* ---------- account ---------- */

$('#signout-all').addEventListener('click', async () => {
  if (!confirm('Sign out of every browser and device, including this one?')) return;
  await api('/me/sessions', { method: 'DELETE' });
  location.reload();
});

$('#delete').addEventListener('click', async () => {
  const typed = prompt('This deletes your account, timetable, places and paired devices immediately. Type DELETE to confirm.');
  if (typed !== 'DELETE') return;
  try {
    await api('/me', { method: 'DELETE' });
    location.href = '/';
  } catch (err) {
    $('#account-msg').textContent = err.message;
  }
});

/* ---------- start ---------- */

async function start() {
  let me;
  try {
    me = await api('/me');
  } catch (err) {
    if (err.status === 401) {
      $('#signin').hidden = false;
      await setupTurnstile().catch(() => {});
      return;
    }
    throw err;
  }
  $('#email').textContent = me.email;
  $('#who').hidden = false;
  term = me.term;
  $('#reimport').hidden = !me.needsReimport;
  $('#reimport-text').textContent =
    me.reimportReason === 'ended'
      ? `It's for ${me.term}, which has ended. Copy this semester's link from NUSMods and import it below.`
      : "It was imported before terminus knew about teaching weeks, so it may count classes in weeks they don't run.";

  const [p, campus] = await Promise.all([api('/me/profile'), api('/campus')]);
  profile = p;
  stops = campus.stops.map(({ code, name, lat, lon }) => ({ code, name, lat, lon })).sort((a, b) => a.name.localeCompare(b.name));

  destinations = campus.destinations;
  residences = (campus.residences ?? []).sort((a, b) => a.name.localeCompare(b.name));
  for (const r of residences) $('#residence').append(el('option', { value: r.code, textContent: r.name }));
  for (const form of ['#manual-form', '#place-form']) {
    attachSearch($(form).where, { source: () => destinations, suggestions: mySuggestions, stopName });
  }
  if (profile.share) $('#share').value = profile.share;
  // Same link, fresh data: only useful when the semester hasn't changed.
  $('#reimport-now').hidden = !(me.reimportReason === 'legacy' && profile.share);

  // First sign-in: set up before the account page appears.
  if (me.onboarding === 'full') {
    await runOnboarding(onboardingCtx);
    if (profile.share) $('#share').value = profile.share;
  }

  renderClasses();
  renderHome();
  renderPlaces();
  $('#app').hidden = false;
  if (me.onboarding === 'pace') pacePrompt(onboardingCtx);
  await Promise.all([renderDevices(), renderKeys(), renderPreview()]);
  setInterval(() => document.visibilityState === 'visible' && renderPreview(), 60_000);
}

start().catch((err) => {
  document.querySelector('main').append(el('p', { class: 'hint', textContent: `Something went wrong: ${err.message}` }));
});
