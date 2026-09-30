// The operator dashboard: /admin/stats, with the HEALTH_TOKEN kept in this
// tab's sessionStorage only.

const $ = (id) => document.getElementById(id);
const KEY = 'terminus-operator-token';
const TZ = { timeZone: 'Asia/Singapore' };
const when = (iso) => new Date(iso).toLocaleString('en-SG', { ...TZ, day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
const fmt = (n) => Number(n ?? 0).toLocaleString('en-SG');

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else node[k] = v;
  }
  for (const c of children) if (c != null) node.append(c);
  return node;
}

function token() {
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}

function remember(t) {
  try {
    if (t) sessionStorage.setItem(KEY, t);
    else sessionStorage.removeItem(KEY);
  } catch {
    // Without storage the token lasts until the page reloads.
  }
}

let memory = null;

async function load() {
  const t = memory ?? token();
  if (!t) return showUnlock();
  const res = await fetch('/admin/stats', { headers: { 'x-health-token': t }, cache: 'no-store' }).catch(() => null);
  if (!res) {
    $('as-of').textContent = "Couldn't reach terminus.";
    return;
  }
  if (res.status === 404) {
    remember(null);
    memory = null;
    return showUnlock('That token was not accepted.');
  }
  if (!res.ok) {
    $('as-of').textContent = `The stats answered ${res.status}.`;
    return;
  }
  render(await res.json());
}

function showUnlock(msg = '') {
  $('dash').hidden = true;
  $('refresh').hidden = $('lock').hidden = true;
  $('unlock').hidden = false;
  $('unlock-msg').textContent = msg;
  $('token').focus();
}

function tile(n, k) {
  return el('div', { class: 'tile' }, el('div', { class: 'n', textContent: n }), el('div', { class: 'k', textContent: k }));
}

/** Bars for [{label, n}], with the first and last label underneath. */
function bars(rows, cls = '') {
  const max = Math.max(1, ...rows.map((r) => r.n));
  const box = el('div', { class: 'bars' });
  for (const r of rows) {
    const b = el('div', { class: `bar ${cls}`, title: `${r.label}: ${fmt(r.n)}` });
    b.style.height = `${Math.max(2, (r.n / max) * 100)}%`;
    box.append(b);
  }
  const foot = el('div', { class: 'bars-foot' }, el('span', { textContent: rows[0]?.label ?? '' }), el('span', { textContent: rows.at(-1)?.label ?? '' }));
  return [box, foot];
}

/** Every Singapore day from `days` ago to today, so quiet days show as gaps. */
function lastDays(days) {
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    out.push(new Date(Date.now() - i * 86_400_000).toLocaleDateString('en-CA', TZ));
  }
  return out;
}

function render(s) {
  $('unlock').hidden = true;
  $('dash').hidden = false;
  $('refresh').hidden = $('lock').hidden = false;
  $('as-of').textContent = `As of ${when(s.now)} (Singapore time).`;

  const a = s.accounts ?? {};
  const pct = (n) => (a.total ? ` (${Math.round((n / a.total) * 100)}%)` : '');
  $('tiles').replaceChildren(
    tile(fmt(a.total), 'accounts'),
    tile(fmt(a.active1d), 'active today'),
    tile(fmt(a.active7d), 'active this week'),
    tile(fmt(a.new7d), `new this week · ${fmt(a.new30d)} this month`),
    tile(fmt(a.withTimetable), `with a timetable${pct(a.withTimetable)}`),
    tile(fmt(a.withHome), `with home stops${pct(a.withHome)}`),
    tile(fmt(a.anonymous), `without an email${pct(a.anonymous)}`),
  );

  // Accounts in the apps: installs, how many finished setup, how many added an email.
  const ap = s.apps ?? {};
  const of = (n, d) => (d ? ` (${Math.round((n / d) * 100)}%)` : '');
  $('apps').replaceChildren(
    tile(fmt(ap.installs30d), 'app installs this month'),
    tile(fmt(ap.onboarded30d), `finished setup${of(ap.onboarded30d, ap.installs30d)}`),
    tile(fmt(ap.addedEmail30d), `added an email this month · ${fmt(ap.addedEmail)} ever`),
  );
  $('clients').replaceChildren(
    ...(s.clients ?? []).map((c) => el('li', {}, el('code', { textContent: c.client }), ` · ${fmt(c.n)}`)),
  );
  if (!s.clients?.length) $('clients').append(el('li', { class: 'hint', textContent: 'No app has sent its version yet.' }));

  const byDay = new Map((s.signups ?? []).map((r) => [r.day, r.n]));
  $('signups').replaceChildren(...bars(lastDays(30).map((d) => ({ label: d.slice(5), n: byDay.get(d) ?? 0 }))));

  const names = { android: 'Android', mac: 'Mac', ios: 'iPhone', unknown: 'Not seen since pairing' };
  $('devices').tBodies[0].replaceChildren(
    ...(s.devices ?? []).map((d) => el('tr', {}, el('td', { textContent: names[d.platform] ?? d.platform }), el('td', { textContent: fmt(d.total) }), el('td', { textContent: fmt(d.active7) }))),
  );
  if (!s.devices?.length) $('devices').tBodies[0].append(el('tr', {}, el('td', { colSpan: 3, class: 'hint', textContent: 'No paired devices yet.' })));
  $('keys').textContent = s.apiKeys ? `API keys: ${fmt(s.apiKeys.total)}, ${fmt(s.apiKeys.used7d)} used this week. Web sessions this week: ${fmt(a.webSessions7d)}.` : '';

  renderAnalytics(s.analytics);

  if (s.feed) {
    $('feed').replaceChildren(
      el('strong', { class: s.feed.up ? 'good' : 'bad', textContent: s.feed.up ? 'Up' : 'Down' }),
      ` since ${when(s.feed.since)}; last checked ${when(s.feed.checkedAt)}.`,
    );
  } else {
    $('feed').textContent = 'No checks recorded yet.';
  }
  $('incidents').replaceChildren(
    ...(s.incidents ?? []).map((i) =>
      el('li', { textContent: `${when(i.start)} → ${i.end ? when(i.end) : 'ongoing'} · ${i.cause === 'version' ? 'new uNivUS version' : 'feed failed'}` }),
    ),
  );

  const fb = s.feedback ?? { latest: [], last7d: 0 };
  $('fb-count').textContent = `· ${fmt(fb.last7d)} this week`;
  $('reports').replaceChildren(
    ...fb.latest.map((f) =>
      el(
        'li',
        {},
        el('div', { class: 'meta', textContent: `${when(f.created)} · ${f.email ?? 'no email'} · ${f.platform}${f.appVersion ? ` ${f.appVersion}` : ''}` }),
        el('div', { class: 'note', textContent: f.note || '(no note)' }),
        el('div', { class: 'meta', textContent: `Answer: ${f.answer}` }),
        f.context ? el('details', {}, el('summary', { textContent: 'The answer they saw' }), el('pre', { textContent: JSON.stringify(f.context, null, 2) })) : null,
      ),
    ),
  );
  if (!fb.latest.length) $('reports').append(el('li', { class: 'hint', textContent: 'No reports yet.' }));
}

function renderAnalytics(an) {
  const box = $('analytics');
  if (!an) {
    box.replaceChildren(
      el('p', {
        class: 'hint',
        textContent:
          'Not connected. Set the ANALYTICS_TOKEN secret (an API token with Account Analytics: Read) and CF_ACCOUNT_ID to see answers, their quality and errors per day.',
      }),
    );
    return;
  }
  if (an.error) {
    box.replaceChildren(el('p', { class: 'bad', textContent: `Analytics Engine: ${an.error}` }));
    return;
  }
  const days = lastDays(14);
  const per = (kind) => {
    const m = new Map(an.daily.filter((r) => r.kind === kind).map((r) => [String(r.day).slice(0, 10), Number(r.n)]));
    return days.map((d) => ({ label: d.slice(5), n: m.get(d) ?? 0 }));
  };
  const answers = per('answer');
  const errors = per('error');
  const total = (rows) => rows.reduce((t, r) => t + r.n, 0);
  const quality = el('table', {}, el('thead', {}, el('tr', {}, el('th', { textContent: 'Quality, this week' }), el('th', { textContent: 'Answers' }))));
  quality.append(el('tbody', {}, ...an.quality.map((q) => el('tr', {}, el('td', { textContent: q.quality || '—' }), el('td', { textContent: fmt(q.n) })))));
  const errs = el('table', {}, el('thead', {}, el('tr', {}, el('th', { textContent: 'Errors by route, this week' }), el('th', { textContent: 'Count' }))));
  errs.append(el('tbody', {}, ...(an.errors.length ? an.errors.map((e) => el('tr', {}, el('td', {}, el('code', { textContent: e.route })), el('td', { textContent: fmt(e.n) }))) : [el('tr', {}, el('td', { colSpan: 2, class: 'hint', textContent: 'None.' }))])));
  box.replaceChildren(
    el('p', { class: 'hint', textContent: `${fmt(total(answers))} answers, ${fmt(total(errors))} errors.` }),
    ...bars(answers),
    el('p', { class: 'hint', textContent: 'Errors' }),
    ...bars(errors, 'error'),
    el('div', { class: 'split' }, quality, errs),
  );
}

$('unlock').addEventListener('submit', (e) => {
  e.preventDefault();
  memory = $('token').value.trim();
  remember(memory);
  $('token').value = '';
  load();
});
$('refresh').addEventListener('click', load);
$('lock').addEventListener('click', () => {
  remember(null);
  memory = null;
  showUnlock();
});

load();
