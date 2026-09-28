// Account page. Same origin as the API, so the session cookie just works.

const $ = (sel) => document.querySelector(sel);
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
const WALK_RADIUS_M = 450;

let profile = null;
let stops = []; // [{code, name, lat, lon}]
const destByValue = new Map(); // datalist value -> stop code

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
    else if (k.startsWith('aria-')) node.setAttribute(k, v);
    else node[k] = v;
  }
  for (const c of children) if (c != null) node.append(c);
  return node;
}

const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const toMin = (v) => (v ? Number(v.slice(0, 2)) * 60 + Number(v.slice(3, 5)) : null);
const stopName = (code) => stops.find((s) => s.code === code)?.name ?? code;
const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

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

/* ---------- widget preview ---------- */

/** Renders /me/next the way the widget does, so settings changes show up. */
async function renderPreview() {
  const box = $('#preview');
  let a;
  try {
    a = await api('/me/next');
  } catch {
    box.replaceChildren(el('div', { class: 'detail', textContent: 'Preview unavailable right now.' }));
    return;
  }
  const where =
    a.mode === 'rest' ? 'Off hours' : a.mode === 'nearby' ? 'Nearby' : a.dest?.why === 'class' ? `Next class · ${a.dest.label}` : a.dest?.why === 'gap-home' ? `Long gap · ${a.dest.label}` : a.dest?.label ?? 'Next bus';
  // Show a departure as a clock time, the way the widget does, so it can't go stale.
  const svc = a.label.split(' · ')[0];
  const big = a.departsAt && a.quality !== 'unknown' ? `${svc} · ${clock(a.departsAt)}` : a.label;
  const crowd = a.arrivals?.[0]?.crowd;
  const parts = [
    el('div', { class: 'where', textContent: where }),
    el('div', { class: 'big', textContent: big }),
    el('div', { class: 'detail', textContent: a.detail }),
    a.timing ? el('span', { class: `ontime ${a.timing.status}`, textContent: a.timing.text }) : null,
    crowd ? el('div', { class: 'detail', textContent: `Crowd: ${crowd}` }) : null,
    a.places?.length ? el('div', { class: 'chips' }, ...a.places.slice(0, 3).map((p) => el('span', { textContent: p.label })), el('span', { textContent: 'Nearby' })) : null,
  ];
  box.replaceChildren(...parts.filter(Boolean));
}

/* ---------- rendering ---------- */

function renderClasses() {
  const box = $('#classes');
  box.replaceChildren();
  const all = [
    ...profile.trips.map((t, i) => ({ t, list: 'trips', i })),
    ...profile.manual.map((t, i) => ({ t, list: 'manual', i })),
  ];
  $('#class-count').textContent = all.length ? `${all.length} class${all.length === 1 ? '' : 'es'}` : '';
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
  box.append(el('p', { class: 'warn-text', textContent: `${list.length} class${list.length === 1 ? '' : 'es'} had a venue we couldn't place. Pick the nearest stop:` }));
  const ul = el('ul', { class: 'list' });
  for (const u of list) {
    const li = el('li', {}, el('span', { textContent: `${DAYS[u.day]} ${hhmm(u.arriveByMin)} · ${u.module} @ ${u.venue}` }));
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

/* ---------- sign in ---------- */

let turnstileToken = null;

async function setupTurnstile() {
  const { turnstileSiteKey } = await api('/auth/config').catch(() => ({}));
  if (!turnstileSiteKey) return;
  await new Promise((resolve, reject) => {
    const s = el('script', { src: 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit', onload: resolve, onerror: reject });
    document.head.append(s);
  });
  window.turnstile.render('#turnstile', {
    sitekey: turnstileSiteKey,
    callback: (t) => (turnstileToken = t),
    'expired-callback': () => (turnstileToken = null),
  });
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('#login-msg');
  const btn = e.target.querySelector('button');
  btn.disabled = true;
  try {
    const r = await api('/auth/login', { method: 'POST', body: { email: $('#login-email').value, turnstile: turnstileToken } });
    msg.textContent = r.message;
  } catch (err) {
    msg.textContent = err.message;
    if (window.turnstile) window.turnstile.reset('#turnstile');
  } finally {
    btn.disabled = false;
  }
});

$('#logout').addEventListener('click', async () => {
  await api('/auth/logout', { method: 'POST' }).catch(() => {});
  location.reload();
});

/* ---------- timetable, day, places ---------- */

$('#import-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('#import-msg');
  msg.textContent = 'Importing…';
  try {
    const r = await api('/me/import', { method: 'POST', body: { share: $('#share').value } });
    profile = r.profile;
    msg.textContent = `Imported ${profile.trips.length} class${profile.trips.length === 1 ? '' : 'es'}.`;
    $('#reimport').hidden = true;
    renderClasses();
    renderUnresolved(r.unresolved);
    renderPreview();
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
  $('#reimport').hidden = !me.needsReimport;

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
  $('#app').hidden = false;
  await Promise.all([renderDevices(), renderPreview()]);
  setInterval(() => document.visibilityState === 'visible' && renderPreview(), 60_000);
}

start().catch((err) => {
  document.querySelector('main').append(el('p', { class: 'hint', textContent: `Something went wrong: ${err.message}` }));
});
