// The operator dashboard: /admin/stats, opened with a passkey (passkey.js),
// whose session is kept in this tab's sessionStorage only. Adding a passkey
// takes the HEALTH_TOKEN. English only: it's for the operator.

import { html, render, store, useRef, useState, useStore } from '/assets/ui.js';
import { addPasskey, passkeysWork, signIn } from '/admin/passkey.js';

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

/** Drops the token, from the tab and from this page. */
function forget() {
  remember(null);
  memory = null;
}

async function load() {
  const t = memory ?? token();
  if (!t) return view.set({ locked: true, msg: '', stats: null, note: '' });
  // Given up on after a while: a hung call would leave old stats up with no word of it.
  const res = await fetch('/api/admin/stats', { headers: { 'x-health-token': t }, cache: 'no-store', signal: AbortSignal.timeout?.(20_000) }).catch(() => null);
  if (!res) return view.set((v) => ({ ...v, note: "Couldn't reach terminus." }));
  if (res.status === 404) {
    forget();
    return view.set({ locked: true, msg: 'Signed out. Sign in again.', stats: null, note: '' });
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
  forget();
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
  // A request to NUS is one that got an answer (upstream), failed on the way
  // (error), or was one more inside a poll (retry: a fresh token, a second call).
  const REQUESTS = new Set(['upstream', 'error', 'retry']);
  const upstream = new Map();
  for (const r of an.timelapse) {
    if (!REQUESTS.has(r.outcome)) continue;
    const day = String(r.day).slice(0, 10);
    upstream.set(day, (upstream.get(day) ?? 0) + Number(r.n));
  }
  return html`
    <p class="hint">${`${fmt(sum('upstream') + sum('error') + sum('retry'))} requests to NUS (${fmt(sum('error'))} of them failed, ${fmt(sum('retry'))} retries), ${fmt(sum('hit'))} answered from the cache, ${fmt(sum('stale') + sum('failed'))} not asked after a failure, ${fmt(sum('skipped'))} skipped with the breaker open.`}</p>
    <${Bars} rows=${days.map((d) => ({ label: d.slice(5), n: upstream.get(d) ?? 0 }))} />
    <p class="hint">Requests to NUS per day. The only scheduled reads of the live buses (CLAUDE.md, rule 2).</p>
  `;
}

/** What each switch collects, in a line: the operator turns each on here (collect.ts). */
const COLLECT = [
  ['active', 'Active accounts', 'How many accounts used terminus each day, by app and version. Counted from the sessions already kept; only the totals are stored.'],
  ['eta', 'Arrival-time accuracy', 'The feed’s “in 4 min” against when the timelapse recorder saw the bus arrive. No user data. Needs the recorder on.'],
  ['errors', 'Crash reports', 'Crashes and errors from the apps and the website, with no account, device or address. Each app has a switch to stop sending them.'],
];

function Collect({ on }) {
  const [state, setState] = useState(on ?? {});
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const flip = async (name) => {
    setBusy(name);
    setMsg('');
    try {
      const res = await fetch('/api/admin/collect', {
        method: 'POST',
        headers: { 'x-health-token': memory ?? token(), 'content-type': 'application/json' },
        body: JSON.stringify({ name, on: !state[name] }),
      });
      if (!res.ok) throw new Error(`The switch answered ${res.status}.`);
      setState(await res.json());
    } catch (err) {
      setMsg(err.message);
    } finally {
      setBusy('');
    }
  };
  return html`
    <table>
      <tbody>
        ${COLLECT.map(
          ([name, title, what]) => html`<tr>
            <td><strong>${title}</strong><div class="hint">${what}</div></td>
            <td><strong class=${state[name] ? 'good' : ''}>${state[name] ? 'Collecting' : 'Off'}</strong></td>
            <td><button type="button" class="btn small" disabled=${busy === name} onClick=${() => flip(name)}>${state[name] ? 'Turn off' : 'Turn on'}</button></td>
          </tr>`,
        )}
      </tbody>
    </table>
    <p class="hint" role="status">${msg || 'Everything here is off until turned on. The cron counts and scores once a day, after midnight.'}</p>
  `;
}

const names = { android: 'Android', mac: 'Mac', ios: 'iPhone', web: 'Website', api: 'API keys', unknown: 'Not seen since pairing' };

/** The daily active counts (usage.ts): accounts a day for 30 days, then the latest day by app and version. */
function Active({ an }) {
  if (!an) return html`<p class="hint">Needs ANALYTICS_TOKEN, as the answers do.</p>`;
  if (an.error || !an.active) return null;
  if (!an.active.length) return html`<p class="hint">No days counted yet. Turn on Active accounts above; the first count comes after midnight.</p>`;
  const all = new Map(an.active.filter((r) => r.scope === 'all').map((r) => [r.day, Number(r.d1)]));
  const latest = an.active.reduce((d, r) => (r.day > d ? r.day : d), '');
  const on = (scope) => an.active.filter((r) => r.scope === scope && r.day === latest).sort((a, b) => b.d7 - a.d7);
  const rows = (scope, label) => html`
    <table>
      <thead><tr><th>${label}</th><th>Day</th><th>Week</th><th>Month</th></tr></thead>
      <tbody>${on(scope).map((r) => html`<tr><td>${scope === 'app' ? (names[r.name] ?? r.name) : html`<code>${r.name}</code>`}</td><td>${fmt(r.d1)}</td><td>${fmt(r.d7)}</td><td>${fmt(r.d30)}</td></tr>`)}</tbody>
    </table>
  `;
  return html`
    <${Bars} rows=${lastDays(30).map((d) => ({ label: d.slice(5), n: all.get(d) ?? 0 }))} />
    <p class="hint">${`Accounts that used terminus each day. Latest, ${latest}: the last 1, 7 and 30 days.`}</p>
    <div class="split">
      ${rows('app', 'App (accounts)')}
      ${rows('version', 'Version (devices)')}
    </div>
  `;
}

/** "+42 s" / "−1 min 5 s": how much later than said the bus came. */
const late = (s) => {
  if (s == null) return '—';
  const a = Math.abs(s);
  const text = a < 60 ? `${a} s` : `${Math.floor(a / 60)} min${a % 60 ? ` ${a % 60} s` : ''}`;
  return s === 0 ? '0 s' : `${s > 0 ? '+' : '−'}${text}`;
};
const pctOf = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);

/** How good the feed's arrival times were (eta.ts), over the days scored. */
function Eta({ eta }) {
  if (!eta) return html`<p class="hint">Needs the downloads bucket, where the recorder keeps its days.</p>`;
  if (eta.error) return html`<p class="bad">${eta.error}</p>`;
  if (!eta.days.length) return html`<p class="hint">No days scored yet. Turn on Arrival-time accuracy above; it needs the timelapse recorder on and ANALYTICS_TOKEN. A day is scored the night after.</p>`;
  const o = eta.overall;
  const head = html`<tr><th></th><th>Scored</th><th>Typical</th><th>Within 1 min</th><th>Over 2 min late</th><th>Over 1 min early</th></tr>`;
  const row = (label, r) => html`<tr><td>${label}</td><td>${fmt(r.n)}</td><td>${late(r.medianS)}</td><td>${pctOf(r.within1)}</td><td>${pctOf(r.late2)}</td><td>${pctOf(r.early1)}</td></tr>`;
  const matched = eta.days.reduce((t, d) => t + d.matched, 0);
  const predictions = eta.days.reduce((t, d) => t + d.predictions, 0);
  return html`
    <section class="tiles">
      <${Tile} n=${pctOf(o.within1)} k="within a minute of what it said" />
      <${Tile} n=${late(o.medianS)} k="typical error (+ is later than said)" />
      <${Tile} n=${pctOf(o.late2)} k="over 2 minutes late" />
    </section>
    <p class="hint">${`${fmt(matched)} of ${fmt(predictions)} predictions found their bus, over ${eta.days.length} day${eta.days.length === 1 ? '' : 's'}. Good to about 15 s either way.`}</p>
    <table>
      <thead>${head}</thead>
      <tbody>${eta.horizons.map((h) => row(`Said ${h.label}`, h))}</tbody>
    </table>
    <div class="split">
      <table>
        <thead><tr><th>Service</th><th>Scored</th><th>Typical</th><th>Within 1 min</th></tr></thead>
        <tbody>${eta.services.map((r) => html`<tr><td>${r.svc}</td><td>${fmt(r.n)}</td><td>${late(r.medianS)}</td><td>${pctOf(r.within1)}</td></tr>`)}</tbody>
      </table>
      <table>
        <thead><tr><th>Hour</th><th>Scored</th><th>Typical</th><th>Within 1 min</th></tr></thead>
        <tbody>${eta.hours.map((r) => html`<tr><td>${`${String(r.hour).padStart(2, '0')}:00`}</td><td>${fmt(r.n)}</td><td>${late(r.medianS)}</td><td>${pctOf(r.within1)}</td></tr>`)}</tbody>
      </table>
    </div>
  `;
}

/** An Analytics Engine time ("2026-10-10 04:05:06", UTC) as ISO. */
const aeIso = (x) => (/[zZ]$|[+-]\d\d:?\d\d$/.test(String(x)) ? String(x) : `${String(x).replace(' ', 'T')}Z`);

/** The week's crash and error reports by fingerprint (apperrors.ts). */
function AppErrors({ an }) {
  if (!an) return html`<p class="hint">Needs ANALYTICS_TOKEN, as the answers do.</p>`;
  if (an.error || !an.appErrors) return null;
  if (!an.appErrors.length) return html`<p class="hint">No reports this week.</p>`;
  return html`
    <ul class="list reports">
      ${an.appErrors.map(
        (e) => html`<li key=${e.fingerprint}>
          <div class="meta">${`${names[e.platform] ?? e.platform} · ${fmt(e.n)} report${e.n === 1 ? '' : 's'}${e.fatal ? `, ${fmt(e.fatal)} crashed the app` : ''} · last ${when(aeIso(e.last))}`}</div>
          <div class="note"><b>${e.type}</b>${e.message ? `: ${e.message}` : ''}</div>
          <div class="meta">${e.versions.map((v) => `${v.version}${v.os ? ` on ${v.os}` : ''} × ${fmt(v.n)}`).join(' · ')}</div>
          ${e.stack && html`<details><summary>Stack</summary><pre>${e.stack}</pre></details>`}
        </li>`,
      )}
    </ul>
  `;
}

function Dashboard({ s, note }) {
  const a = s.accounts ?? {};
  /** " (40%)": `n` as a share of `d`, or nothing without a `d`. */
  const of = (n, d) => (d ? ` (${Math.round((n / d) * 100)}%)` : '');
  const pct = (n) => of(n, a.total);
  // Accounts in the apps: installs, how many finished setup, how many added an email.
  const ap = s.apps ?? {};
  const byDay = new Map((s.signups ?? []).map((r) => [r.day, r.n]));
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
      <h2>What’s collected</h2>
      <${Collect} on=${s.collect} />
    </section>
    <section class="card">
      <h2>Active accounts, last 30 days</h2>
      <${Active} an=${s.analytics} />
    </section>
    <section class="card">
      <h2>Arrival times, last 14 days</h2>
      <${Eta} eta=${s.eta} />
    </section>
    <section class="card">
      <h2>Crash reports, this week</h2>
      <${AppErrors} an=${s.analytics} />
    </section>
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
                  <div class="meta">${`${when(f.created)} · ${f.email ?? (f.replyTo ? `reply to ${f.replyTo} (not checked)` : 'no email')} · ${f.platform}${f.appVersion ? ` ${f.appVersion}` : ''}`}</div>
                  ${f.reason && html`<div class="note"><b>${f.reason}</b></div>`}
                  ${(f.note || !f.reason) && html`<div class="note">${f.note || '(no note)'}</div>`}
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

/** Keeps the session and opens the dashboard; or says what went wrong. */
async function unlockWith(get, setBusy) {
  setBusy(true);
  view.set((v) => ({ ...v, msg: '' }));
  try {
    memory = await get();
    remember(memory);
    await load();
  } catch (err) {
    view.set((v) => ({ ...v, msg: err.message }));
  } finally {
    setBusy(false);
  }
}

function Unlock({ msg }) {
  const box = useRef(null);
  const [busy, setBusy] = useState(false);
  if (!passkeysWork()) return html`<p class="card hint">This browser can’t use passkeys. Open the dashboard in a current Chrome, Safari or Firefox.</p>`;
  return html`
    <div class="card unlock">
      <button type="button" class="btn accent" disabled=${busy} onClick=${() => unlockWith(signIn, setBusy)}>Sign in with a passkey</button>
      <p class="hint" role="status">${msg}</p>
      <form
        class="add"
        onSubmit=${(e) => {
          e.preventDefault();
          const token = box.current.value.trim();
          box.current.value = '';
          unlockWith(() => addPasskey(token, navigator.userAgentData?.platform || navigator.platform || ''), setBusy);
        }}
      >
        <label for="token">Add a passkey on this device</label>
        <p class="hint">Needs the <code>HEALTH_TOKEN</code> secret, once. It isn’t kept.</p>
        <div class="row">
          <input id="token" ref=${box} type="password" autocomplete="off" placeholder="Operator token" required />
          <button type="submit" class="btn" disabled=${busy}>Add passkey</button>
        </div>
      </form>
    </div>
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
