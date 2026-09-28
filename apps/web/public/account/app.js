// Account page. Same origin as the API, so the session cookie just works.

const $ = (sel) => document.querySelector(sel);
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
const WALK_RADIUS_M = 450;

let profile = null;
let stops = []; // [{code, name, lat, lon}]
let destByValue = new Map(); // datalist value -> stop code

/* ---------- helpers ---------- */

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status });
  return data;
}

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node[k] = v;
  }
  for (const c of children) node.append(c);
  return node;
}

const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const toMin = (v) => (v ? Number(v.slice(0, 2)) * 60 + Number(v.slice(3, 5)) : null);
const stopName = (code) => stops.find((s) => s.code === code)?.name ?? code;

function haversineM(aLat, aLon, bLat, bLon) {
  const r = (d) => (d * Math.PI) / 180;
  const s = Math.sin(r(bLat - aLat) / 2) ** 2 + Math.cos(r(aLat)) * Math.cos(r(bLat)) * Math.sin(r(bLon - aLon) / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(s)));
}

function stopSelect(value, onChange, { blank } = {}) {
  const sel = el('select', { onchange: () => onChange(sel.value) });
  if (blank) sel.append(el('option', { value: '', textContent: blank }));
  for (const s of stops) sel.append(el('option', { value: s.code, textContent: s.name }));
  sel.value = value ?? '';
  return sel;
}

/** A typed destination: a datalist entry, or a bare stop code. */
function resolveWhere(text) {
  const t = text.trim();
  if (destByValue.has(t)) return destByValue.get(t);
  const code = t.toUpperCase();
  return stops.some((s) => s.code === code) ? code : null;
}

/* ---------- saving ---------- */

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  $('#saved').textContent = 'Saving…';
  saveTimer = setTimeout(async () => {
    try {
      profile = await api('/me/profile', { method: 'PUT', body: profile });
      $('#saved').textContent = 'Saved';
    } catch (err) {
      $('#saved').textContent = `Not saved: ${err.message}`;
    }
  }, 400);
}

/* ---------- rendering ---------- */

function renderClasses() {
  const box = $('#classes');
  box.replaceChildren();
  const all = [
    ...profile.trips.map((t, i) => ({ t, list: 'trips', i })),
    ...profile.manual.map((t, i) => ({ t, list: 'manual', i })),
  ];
  if (!all.length) {
    box.append(el('p', { class: 'hint', textContent: 'No classes yet.' }));
    return;
  }
  for (const day of DAY_ORDER) {
    const rows = all.filter((r) => r.t.day === day).sort((a, b) => a.t.arriveByMin - b.t.arriveByMin);
    if (!rows.length) continue;
    box.append(el('div', { class: 'day', textContent: DAYS[day] }));
    for (const { t, list, i } of rows) {
      const time = t.endMin ? `${hhmm(t.arriveByMin)}–${hhmm(t.endMin)}` : hhmm(t.arriveByMin);
      box.append(
        el(
          'div',
          { class: 'cls' },
          el('span', { class: 'time', textContent: time }),
          el('span', { textContent: t.label }),
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
  box.append(el('p', { class: 'warn', textContent: `${list.length} class${list.length === 1 ? '' : 'es'} had a venue we couldn't place. Pick the nearest stop:` }));
  const ul = el('ul', { class: 'list' });
  list.forEach((u) => {
    const li = el('li', {}, el('span', { textContent: `${DAYS[u.day]} ${hhmm(u.arriveByMin)} ${u.module} @ ${u.venue}` }));
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
  });
  box.append(ul);
}

function renderHome() {
  const stopsNow = profile.home?.stops ?? [];
  const pick = (idx) => (v) => {
    const next = [...(profile.home?.stops ?? [])];
    next[idx] = v;
    const clean = next.filter(Boolean).filter((c, i, a) => a.indexOf(c) === i);
    if (!clean.length) {
      profile.home = null;
    } else {
      // A home set with "Use my location" keeps its coordinates. Otherwise the
      // main stop stands in for home, and follows it when it changes.
      const main = stops.find((s) => s.code === clean[0]);
      const h = profile.home;
      const derived = !h || stops.some((s) => s.lat === h.lat && s.lon === h.lon);
      profile.home = { lat: derived ? main.lat : h.lat, lon: derived ? main.lon : h.lon, stops: clean };
    }
    renderHome();
    save();
  };
  $('#home-1').replaceWith(Object.assign(stopSelect(stopsNow[0], pick(0), { blank: 'Main stop' }), { id: 'home-1' }));
  $('#home-2').replaceWith(Object.assign(stopSelect(stopsNow[1], pick(1), { blank: 'Second stop (optional)' }), { id: 'home-2' }));
  $('#gap').value = profile.gapHours;
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
        el('span', { textContent: `${p.label} → ${stopName(p.to)}` }),
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
        el('span', { textContent: `${d.name ?? 'Device'} · added ${fmt(d.created)} · last used ${fmt(d.lastSeen)}` }),
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

/* ---------- events ---------- */

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('#login-msg');
  try {
    const r = await api('/auth/login', { method: 'POST', body: { email: $('#login-email').value } });
    msg.textContent = r.message;
  } catch (err) {
    msg.textContent = err.message;
  }
});

$('#logout').addEventListener('click', async () => {
  await api('/auth/logout', { method: 'POST' }).catch(() => {});
  location.reload();
});

$('#import-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('#import-msg');
  msg.textContent = 'Importing…';
  try {
    const r = await api('/me/import', { method: 'POST', body: { share: $('#share').value } });
    profile = r.profile;
    msg.textContent = `Imported ${profile.trips.length} class${profile.trips.length === 1 ? '' : 'es'}.`;
    renderClasses();
    renderUnresolved(r.unresolved);
  } catch (err) {
    msg.textContent = err.message;
  }
});

$('#manual-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const to = resolveWhere(f.get('where'));
  if (!to) {
    e.target.where.setCustomValidity('Pick a stop, building or room from the list');
    e.target.where.reportValidity();
    return;
  }
  const start = toMin(f.get('start'));
  const end = toMin(f.get('end'));
  profile.manual.push({ day: Number(f.get('day')), arriveByMin: start, ...(end && end > start ? { endMin: end } : {}), to, label: f.get('label').trim(), venue: '' });
  e.target.reset();
  renderClasses();
  save();
});

$('#place-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const to = resolveWhere(f.get('where'));
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

for (const [id, field] of [['#day-start', 'dayStartMin'], ['#day-end', 'dayEndMin']]) {
  $(id).addEventListener('change', (e) => {
    const v = toMin(e.target.value);
    if (v == null) return;
    const next = { ...profile, [field]: v };
    if (next.dayStartMin >= next.dayEndMin) {
      $('#saved').textContent = 'The day has to start before it ends';
      e.target.value = hhmm(profile[field]);
      return;
    }
    profile[field] = v;
    save();
  });
}

$('#locate').addEventListener('click', () => {
  const msg = $('#home-msg');
  if (!navigator.geolocation) {
    msg.textContent = 'This browser cannot share its location.';
    return;
  }
  msg.textContent = 'Finding you…';
  navigator.geolocation.getCurrentPosition(
    ({ coords }) => {
      const near = stops
        .map((s) => ({ s, d: haversineM(coords.latitude, coords.longitude, s.lat, s.lon) }))
        .sort((a, b) => a.d - b.d);
      const within = near.filter((n) => n.d <= WALK_RADIUS_M).slice(0, 2);
      const picked = (within.length ? within : near.slice(0, 1)).map((n) => n.s.code);
      profile.home = { lat: coords.latitude, lon: coords.longitude, stops: picked };
      msg.textContent = within.length
        ? `Home set here. Nearest stops: ${picked.map(stopName).join(', ')}. Change them if you use a different one.`
        : `No stop within ${WALK_RADIUS_M} m; picked the nearest, ${stopName(picked[0])}.`;
      renderHome();
      save();
    },
    (err) => {
      msg.textContent = `Couldn't get your location (${err.message}). Pick your stops instead.`;
    },
    { enableHighAccuracy: true, timeout: 10_000 },
  );
});

let pairPoll = null;
$('#pair').addEventListener('click', async () => {
  const { code, expires } = await api('/me/pair-code', { method: 'POST' });
  const out = $('#pair-code');
  out.hidden = false;
  const before = await renderDevices();
  clearInterval(pairPoll);
  const tick = async () => {
    const left = Math.max(0, Math.round((expires - Date.now()) / 1000));
    out.textContent = left ? `${code.slice(0, 3)} ${code.slice(3)}` : 'Expired';
    out.title = `Expires in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
    if (!left) return clearInterval(pairPoll);
    // Hide the code once a device has used it.
    if (left % 5 === 0 && (await renderDevices()) > before) {
      clearInterval(pairPoll);
      out.textContent = 'Paired.';
    }
  };
  tick();
  pairPoll = setInterval(tick, 1000);
});

/* ---------- start ---------- */

async function start() {
  let me;
  try {
    me = await api('/me');
  } catch (err) {
    if (err.status === 401) {
      $('#signin').hidden = false;
      return;
    }
    throw err;
  }
  $('#email').textContent = me.email;
  $('#who').hidden = false;

  const [p, campus] = await Promise.all([api('/me/profile'), api('/campus')]);
  profile = p;
  stops = campus.stops.map(({ code, name, lat, lon }) => ({ code, name, lat, lon })).sort((a, b) => a.name.localeCompare(b.name));

  const dl = $('#destinations');
  for (const d of campus.destinations) {
    const value = d.label === d.code ? d.code : `${d.label} · ${d.code}`;
    destByValue.set(value, d.stopCode);
    dl.append(el('option', { value }));
  }
  if (profile.share) $('#share').value = profile.share;

  renderClasses();
  renderHome();
  renderPlaces();
  await renderDevices();
  $('#app').hidden = false;
}

start().catch((err) => {
  document.querySelector('main').append(el('p', { class: 'warn', textContent: `Something went wrong: ${err.message}` }));
});
