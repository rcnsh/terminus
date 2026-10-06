// The operator dashboard: /admin/stats, with the HEALTH_TOKEN kept in this
// tab's sessionStorage only. English only: it's for the operator.

import { html, render, store, useEffect, useRef, useStore } from '/assets/ui.js';

const KEY = 'terminus-operator-token';
const TZ = { timeZone: 'Asia/Singapore' };
const when = (iso) => new Date(iso).toLocaleString('en-SG', { ...TZ, day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
const fmt = (n) => Number(n ?? 0).toLocaleString('en-SG');

/** The stats once unlocked, or the token form (with why), or a line saying what went wrong. */
const view = store({ locked: false, msg: '', stats: null, note: '' });

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
  if (!t) return view.set({ locked: true, msg: '', stats: null, note: '' });
  const res = await fetch('/admin/stats', { headers: { 'x-health-token': t }, cache: 'no-store' }).catch(() => null);
  if (!res) return view.set((v) => ({ ...v, note: "Couldn't reach terminus." }));
  if (res.status === 404) {
    remember(null);
    memory = null;
    return view.set({ locked: true, msg: 'That token was not accepted.', stats: null, note: '' });
  }
  if (!res.ok) return view.set((v) => ({ ...v, note: `The stats answered ${res.status}.` }));
  try {
    view.set({ locked: false, msg: '', stats: await res.json(), note: '' });
  } catch (err) {
    // A stats reply this page can't read: say so, not a blank page.
    view.set((v) => ({ ...v, note: `Couldn't show the stats: ${err.message}` }));
  }
}

function lock() {
  remember(null);
  memory = null;
  view.set({ locked: true, msg: '', stats: null, note: '' });
}

const Tile = ({ n, k }) => html`<div class="tile"><div class="n">${n}</div><div class="k">${k}</div></div>`;

/** Bars for [{label, n}], with the first and last label underneath. */
function Bars({ rows, cls = '' }) {
  const max = Math.max(1, ...rows.map((r) => r.n));
  return html`
    <div class="bars">${rows.map((r) => html`<div class=${`bar ${cls}`} title=${`${r.label}: ${fmt(r.n)}`} style=${{ height: `${Math.max(2, (r.n / max) * 100)}%` }}></div>`)}</div>
    <div class="bars-foot"><span>${rows[0]?.label ?? ''}</span><span>${rows.at(-1)?.label ?? ''}</span></div>
  `;
}

/** Every Singapore day from `days` ago to today, so quiet days show as gaps. */
function lastDays(days) {
  const out = [];
  for (let i = days - 1; i >= 0; i--) out.push(new Date(Date.now() - i * 86_400_000).toLocaleDateString('en-CA', TZ));
  return out;
}

function Analytics({ an }) {
  if (!an) {
    return html`<p class="hint">Not connected. Set the ANALYTICS_TOKEN secret (an API token with Account Analytics: Read) and CF_ACCOUNT_ID to see answers, their quality and errors per day.</p>`;
  }
  if (an.error) return html`<p class="bad">${`Analytics Engine: ${an.error}`}</p>`;
  const days = lastDays(14);
  const per = (kind) => {
    const m = new Map(an.daily.filter((r) => r.kind === kind).map((r) => [String(r.day).slice(0, 10), Number(r.n)]));
    return days.map((d) => ({ label: d.slice(5), n: m.get(d) ?? 0 }));
  };
  const answers = per('answer');
  const errors = per('error');
  const total = (rows) => rows.reduce((t, r) => t + r.n, 0);
  return html`
    <p class="hint">${`${fmt(total(answers))} answers, ${fmt(total(errors))} errors.`}</p>
    <${Bars} rows=${answers} />
    <p class="hint">Errors</p>
    <${Bars} rows=${errors} cls="error" />
    <div class="split">
      <table>
        <thead><tr><th>Quality, this week</th><th>Answers</th></tr></thead>
        <tbody>${an.quality.map((q) => html`<tr><td>${q.quality || '—'}</td><td>${fmt(q.n)}</td></tr>`)}</tbody>
      </table>
      <table>
        <thead><tr><th>Errors by route, this week</th><th>Count</th></tr></thead>
        <tbody>
          ${an.errors.length ? an.errors.map((e) => html`<tr><td><code>${e.route}</code></td><td>${fmt(e.n)}</td></tr>`) : html`<tr><td colspan="2" class="hint">None.</td></tr>`}
        </tbody>
      </table>
    </div>
  `;
}

/** The timelapse recorder's polls per day, by what each cost NUS (analytics.ts logPoll). */
function Timelapse({ an }) {
  if (!an) return html`<p class="hint">Needs ANALYTICS_TOKEN, as the answers do.</p>`;
  if (an.error || !an.timelapse) return null;
  const days = lastDays(14);
  const sum = (outcome) => an.timelapse.filter((r) => r.outcome === outcome).reduce((t, r) => t + Number(r.n), 0);
  const upstream = new Map(an.timelapse.filter((r) => r.outcome === 'upstream').map((r) => [String(r.day).slice(0, 10), Number(r.n)]));
  return html`
    <p class="hint">${`${fmt(sum('upstream'))} requests to NUS, ${fmt(sum('hit'))} answered from the cache, ${fmt(sum('stale') + sum('failed'))} failed, ${fmt(sum('skipped'))} skipped with the breaker open.`}</p>
    <${Bars} rows=${days.map((d) => ({ label: d.slice(5), n: upstream.get(d) ?? 0 }))} />
    <p class="hint">Requests to NUS per day. The only scheduled reads of the feed (CLAUDE.md, rule 2).</p>
  `;
}

function Dashboard({ s, note }) {
  const a = s.accounts ?? {};
  const pct = (n) => (a.total ? ` (${Math.round((n / a.total) * 100)}%)` : '');
  // Accounts in the apps: installs, how many finished setup, how many added an email.
  const ap = s.apps ?? {};
  const of = (n, d) => (d ? ` (${Math.round((n / d) * 100)}%)` : '');
  const byDay = new Map((s.signups ?? []).map((r) => [r.day, r.n]));
  const names = { android: 'Android', mac: 'Mac', ios: 'iPhone', unknown: 'Not seen since pairing' };
  const fb = s.feedback ?? { latest: [], last7d: 0 };
  return html`
    <p class="hint">${note || `As of ${when(s.now)} (Singapore time).`}</p>
    <section class="tiles">
      <${Tile} n=${fmt(a.total)} k="accounts" />
      <${Tile} n=${fmt(a.active1d)} k="active today" />
      <${Tile} n=${fmt(a.active7d)} k="active this week" />
      <${Tile} n=${fmt(a.new7d)} k=${`new this week · ${fmt(a.new30d)} this month`} />
      <${Tile} n=${fmt(a.withTimetable)} k=${`with a timetable${pct(a.withTimetable)}`} />
      <${Tile} n=${fmt(a.withHome)} k=${`with home stops${pct(a.withHome)}`} />
      <${Tile} n=${fmt(a.anonymous)} k=${`without an email${pct(a.anonymous)}`} />
    </section>
    <section class="tiles">
      <${Tile} n=${fmt(ap.installs30d)} k="app installs this month" />
      <${Tile} n=${fmt(ap.onboarded30d)} k=${`finished setup${of(ap.onboarded30d, ap.installs30d)}`} />
      <${Tile} n=${fmt(ap.addedEmail30d)} k=${`added an email this month · ${fmt(ap.addedEmail)} ever`} />
    </section>
    <div class="grid">
      <section class="card">
        <h2>Sign-ups, last 30 days</h2>
        <${Bars} rows=${lastDays(30).map((d) => ({ label: d.slice(5), n: byDay.get(d) ?? 0 }))} />
      </section>
      <section class="card">
        <h2>Devices</h2>
        <table>
          <thead><tr><th>App</th><th>Paired</th><th>Used this week</th></tr></thead>
          <tbody>
            ${s.devices?.length
              ? s.devices.map((d) => html`<tr><td>${names[d.platform] ?? d.platform}</td><td>${fmt(d.total)}</td><td>${fmt(d.active7)}</td></tr>`)
              : html`<tr><td colspan="3" class="hint">No paired devices yet.</td></tr>`}
          </tbody>
        </table>
        <p class="hint">${s.apiKeys ? `API keys: ${fmt(s.apiKeys.total)}, ${fmt(s.apiKeys.used7d)} used this week. Web sessions this week: ${fmt(a.webSessions7d)}.` : ''}</p>
        <h2>App versions this week</h2>
        <ul class="list">
          ${s.clients?.length ? s.clients.map((c) => html`<li><code>${c.client}</code>${` · ${fmt(c.n)}`}</li>`) : html`<li class="hint">No app has sent its version yet.</li>`}
        </ul>
      </section>
    </div>
    <div class="grid">
      <section class="card">
        <h2>Answers, last 14 days</h2>
        <${Analytics} an=${s.analytics} />
      </section>
      <section class="card">
        <h2>NUS feed</h2>
        <p>
          ${s.feed
            ? html`<strong class=${s.feed.up ? 'good' : 'bad'}>${s.feed.up ? 'Up' : 'Down'}</strong>${` since ${when(s.feed.since)}; last checked ${when(s.feed.checkedAt)}.`}`
            : 'No checks recorded yet.'}
        </p>
        <ul class="list">
          ${(s.incidents ?? []).map((i) => html`<li>${`${when(i.start)} → ${i.end ? when(i.end) : 'ongoing'} · ${i.cause === 'version' ? 'new uNivUS version' : 'feed failed'}`}</li>`)}
        </ul>
        <p class="hint"><a href="/status">Public status page</a></p>
      </section>
    </div>
    <section class="card">
      <h2>Timelapse recorder, last 14 days</h2>
      <${Timelapse} an=${s.analytics} />
      <p class="hint"><a href="/admin/timelapse/">Replay a day and export a video</a></p>
    </section>
    <section class="card">
      <h2>Reports <span class="hint">${`· ${fmt(fb.last7d)} this week`}</span></h2>
      <ul class="list reports">
        ${fb.latest.length
          ? fb.latest.map(
              (f) => html`
                <li>
                  <div class="meta">${`${when(f.created)} · ${f.email ?? 'no email'} · ${f.platform}${f.appVersion ? ` ${f.appVersion}` : ''}`}</div>
                  <div class="note">${f.note || '(no note)'}</div>
                  <div class="meta">${`Answer: ${f.answer}`}</div>
                  ${f.context && html`<details><summary>The answer they saw</summary><pre>${JSON.stringify(f.context, null, 2)}</pre></details>`}
                </li>
              `,
            )
          : html`<li class="hint">No reports yet.</li>`}
      </ul>
    </section>
  `;
}

function Unlock({ msg }) {
  const box = useRef(null);
  useEffect(() => box.current?.focus(), []);
  return html`
    <form
      class="card unlock"
      onSubmit=${(e) => {
        e.preventDefault();
        memory = box.current.value.trim();
        remember(memory);
        box.current.value = '';
        load();
      }}
    >
      <label for="token">Operator token</label>
      <p class="hint">The <code>HEALTH_TOKEN</code> secret. Kept in this tab only, until you close it.</p>
      <div class="row">
        <input id="token" ref=${box} type="password" autocomplete="off" required />
        <button type="submit" class="btn accent">Open</button>
      </div>
      <p class="hint" role="status">${msg}</p>
    </form>
  `;
}

function Admin() {
  const v = useStore(view);
  if (v.locked) return html`<${Unlock} msg=${v.msg} />`;
  if (!v.stats) return html`<p class="hint">${v.note}</p>`;
  return html`<${Dashboard} s=${v.stats} note=${v.note} />`;
}

function Nav() {
  const v = useStore(view);
  if (!v.stats) return null;
  return html`
    <button type="button" class="btn small ghost" onClick=${load}>Refresh</button>
    <button type="button" class="btn small ghost" onClick=${lock}>Lock</button>
  `;
}

render(html`<${Admin} />`, document.getElementById('admin'));
render(html`<${Nav} />`, document.getElementById('admin-nav'));
load();
