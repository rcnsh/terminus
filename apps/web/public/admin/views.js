// The dashboard's pages, one per section of the sidebar, each drawn from
// /api/admin/stats as admin.ts sends it (the shape is documented there).
// Every number the stats carry is on one of them; the overview repeats the
// headline ones and links to where the detail is.

import { html, useEffect, useMemo, useRef, useState } from '/assets/ui.js';
import { Chart, Diverge, Legend, Stack, compact } from '/admin/charts.js';
import {
  Card,
  Chips,
  Copy,
  Empty,
  Search,
  Segmented,
  S,
  Table,
  Tile,
  ago,
  dayLong,
  dayShort,
  dur,
  fmt,
  lastDays,
  late,
  pct,
  platform,
  share,
  when,
} from '/admin/parts.js';

const sum = (xs) => xs.reduce((t, x) => t + (Number(x) || 0), 0);
/** "1 report" / "3 reports". */
const plural = (n, one, many = `${one}s`) => `${fmt(n)} ${n === 1 ? one : many}`;
/** An Analytics Engine time ("2026-10-10 04:05:06", UTC) as ISO. */
const aeIso = (x) => (/[zZ]$|[+-]\d\d:?\d\d$/.test(String(x)) ? String(x) : `${String(x).replace(' ', 'T')}Z`);
const day = (r) => String(r.day).slice(0, 10);

const NEEDS_AE = html`<${Empty}>
  Not connected. Set the <code>ANALYTICS_TOKEN</code> secret (an API token with Account Analytics: Read) and <code>CF_ACCOUNT_ID</code> to see answers,
  their quality, errors, active accounts, crash reports and the recorder's polls.
<//>`;

/**
 * Everything the pages chart, worked out once per load: per-day series
 * with quiet days as zeros, and the week-on-week changes.
 */
export function derive(s) {
  const nowMs = Date.parse(s.now) || Date.now();
  const an = s.analytics && !s.analytics.error ? s.analytics : null;
  const d14 = lastDays(14, nowMs);
  const d30 = lastDays(30, nowMs);
  const perDay = (kind) => {
    const m = new Map((an?.daily ?? []).filter((r) => r.kind === kind).map((r) => [day(r), Number(r.n)]));
    return d14.map((d) => m.get(d) ?? 0);
  };
  const answers = perDay('answer');
  const errors = perDay('error');
  const rate = answers.map((n, i) => (n ? errors[i] / n : null));
  const week = (xs) => sum(xs.slice(7));
  const before = (xs) => sum(xs.slice(0, 7));
  const change = (a, b) => (b ? (a - b) / b : null);
  const signMap = new Map((s.signups ?? []).map((r) => [r.day, Number(r.n)]));
  const signups = d30.map((d) => signMap.get(d) ?? 0);
  const total = s.accounts?.total ?? 0;
  let run = total - sum(signups);
  const accountsRun = signups.map((n) => (run += n));
  const activeAll = new Map((an?.active ?? []).filter((r) => r.scope === 'all').map((r) => [r.day, Number(r.d1)]));
  const crashes = an?.appErrors ?? [];
  return {
    nowMs,
    an,
    d14,
    d30,
    answers,
    errors,
    rate,
    answers7: week(answers),
    answersChange: change(week(answers), before(answers)),
    errors7: week(errors),
    rate7: share(week(errors), week(answers)),
    rateChange: change(share(week(errors), week(answers)) ?? 0, share(before(errors), before(answers)) ?? 0),
    signups,
    accountsRun,
    active: d30.map((d) => activeAll.get(d) ?? null),
    crashes,
    crashReports: sum(crashes.map((e) => e.n)),
    crashFatal: sum(crashes.map((e) => e.fatal)),
  };
}

/** The sidebar's sections, in order: [id, title, what it holds]. */
export const SECTIONS = [
  ['overview', 'Overview', 'The headline numbers and anything that needs you.'],
  ['accounts', 'Accounts', 'Who uses terminus: sign-ups, setup, and active accounts by app and version.'],
  ['devices', 'Devices', 'Paired apps, the versions they run, API keys and web sessions.'],
  ['answers', 'Answers', 'Answers given per day, how sure they were, and the errors.'],
  ['arrivals', 'Arrival times', 'How close the feed’s “in 4 min” came to when the bus arrived.'],
  [
    'model',
    'Arrival model',
    'Our own arrival-time model, run in shadow beside the feed: how it would have done, day by day. It answers no one yet.',
  ],
  ['feed', 'Feed & recorder', 'The NUS feed’s health, its outages, and what the timelapse recorder asked of it.'],
  ['crashes', 'Crash reports', 'Crashes and errors from the apps and the website this week, by fingerprint.'],
  ['reports', 'Reports', '“This was wrong” reports and stop suggestions, newest first.'],
  ['collection', 'Collection', 'What’s collected. Everything is off until turned on here.'],
];

/* ---------------------------------------------------------------- Overview */

function attention(s, d) {
  const out = [];
  if (s.feed && !s.feed.up) out.push(['bad', `The NUS feed is down, since ${when(s.feed.since)}.`, '#/feed']);
  const open = (s.incidents ?? []).find((i) => !i.end);
  if (open && s.feed?.up) out.push(['warn', `An outage from ${when(open.start)} is still open.`, '#/feed']);
  if (!s.analytics) out.push(['info', 'Analytics Engine isn’t connected: answers, crashes and active accounts are missing.', '#/answers']);
  else if (s.analytics.error) out.push(['bad', `Analytics Engine: ${s.analytics.error}`, '#/answers']);
  if (d.rate7 != null && d.rate7 > 0.02) out.push(['warn', `${pct(d.rate7, 1)} of answers this week were errors.`, '#/answers']);
  if (d.crashFatal) out.push(['warn', `${plural(d.crashFatal, 'crash', 'crashes')} closed an app this week.`, '#/crashes']);
  else if (d.crashReports) out.push(['info', `${plural(d.crashReports, 'error report')} from the apps this week.`, '#/crashes']);
  if (s.feedback?.last7d) out.push(['info', `${plural(s.feedback.last7d, 'report')} from users this week.`, '#/reports']);
  if (s.eta?.error) out.push(['bad', `Arrival times: ${s.eta.error}`, '#/arrivals']);
  const off = SWITCHES.filter(([k]) => !s.collect?.[k]).map(([, t]) => t.toLowerCase());
  if (off.length) out.push(['info', `Not collecting ${off.join(', ')}.`, '#/collection']);
  return out;
}

export function Overview({ s, d }) {
  const a = s.accounts ?? {};
  const items = attention(s, d);
  const eta = s.eta && !s.eta.error && s.eta.days?.length ? s.eta.overall : null;
  return html`
    <div class="tiles">
      <${Tile} k="Accounts" n=${a.total} sub=${`+${fmt(a.new7d)} this week`} spark=${d.accountsRun} href="#/accounts" />
      <${Tile} k="Active today" n=${a.active1d} sub=${`${fmt(a.active7d)} this week`} spark=${d.an ? d.active : null} href="#/accounts" />
      <${Tile}
        k="Answers, last 7 days"
        n=${d.an ? d.answers7 : null}
        delta=${d.answersChange}
        sub=${d.an ? 'vs the week before' : null}
        spark=${d.an ? d.answers : null}
        href="#/answers"
      />
      <${Tile}
        k="Error rate, last 7 days"
        n=${d.an ? d.rate7 : null}
        show=${(x) => pct(x, 2)}
        delta=${d.an ? d.rateChange : null}
        upGood=${false}
        sub=${d.an ? 'vs the week before' : null}
        spark=${d.an ? d.rate.map((x) => x ?? 0) : null}
        sparkColor="var(--bad)"
        href="#/answers"
      />
      <${Tile}
        k="NUS feed"
        n=${s.feed ? (s.feed.up ? 'Up' : 'Down') : '—'}
        tone=${s.feed ? (s.feed.up ? 'good' : 'bad') : ''}
        sub=${s.feed ? `for ${dur(d.nowMs - Date.parse(s.feed.since))} · checked ${ago(s.feed.checkedAt, d.nowMs)}` : 'No checks recorded yet'}
        href="#/feed"
      />
      <${Tile}
        k="Arrival times within 1 min"
        n=${eta?.within1 ?? null}
        show=${(x) => pct(x)}
        sub=${eta ? `typically ${late(eta.medianS)}` : 'None scored yet'}
        href="#/arrivals"
      />
      <${Tile}
        k="Crash reports this week"
        n=${d.an ? d.crashReports : null}
        tone=${d.crashFatal ? 'bad' : ''}
        sub=${d.an ? `${fmt(d.crashFatal)} closed the app · ${plural(d.crashes.length, 'kind')}` : ''}
        href="#/crashes"
      />
      <${Tile} k="Reports this week" n=${s.feedback?.last7d ?? 0} sub=${`${fmt(s.feedback?.latest?.length ?? 0)} kept`} href="#/reports" />
    </div>
    <div class="grid two">
      <${Card} title="Needs a look">
        <ul class="attention">
          ${
            items.length
              ? items.map(([tone, text, href]) => html`<li class=${tone}><a href=${href}><i></i><span>${text}</span><b>→</b></a></li>`)
              : html`<li class="good"><span><i></i>Nothing needs you.</span></li>`
          }
        </ul>
      <//>
      <${Card} title="Sign-ups, last 30 days" sub=${`${fmt(sum(d.signups))} in 30 days`}>
        <${Chart}
          height=${180}
          rows=${d.d30.map((x, i) => ({ label: dayLong(x), short: dayShort(x), values: [d.signups[i]] }))}
          series=${[{ name: 'Sign-ups', color: 'var(--accent-bright)' }]}
        />
      <//>
    </div>
    ${
      d.an &&
      html`<${Card} title="Answers, last 14 days" sub="Errors and the error rate are in each day’s readout." tools=${html`<a class="btn small ghost" href="#/answers">Details</a>`}>
      <${Chart}
        height=${220}
        rows=${d.d14.map((x, i) => ({
          label: dayLong(x),
          short: dayShort(x),
          values: [d.answers[i]],
          note: `${fmt(d.errors[i])} errors · ${pct(d.rate[i], 2)}`,
        }))}
        series=${[{ name: 'Answers', color: 'var(--s1)' }]}
      />
    <//>`
    }
    <div class="grid two">
      <${Card} title="Latest reports" tools=${html`<a class="btn small ghost" href="#/reports">All reports</a>`}>
        ${
          (s.feedback?.latest ?? []).length
            ? html`<ul class="mini">
              ${s.feedback.latest.slice(0, 4).map(
                (f) => html`<li><a href=${`#/reports?open=${encodeURIComponent(f.id)}`}>
                  <b>${f.reason ?? 'Other'}</b><span>${f.note || f.answer}</span><time>${ago(f.created, d.nowMs)}</time>
                </a></li>`,
              )}
            </ul>`
            : html`<${Empty}>No reports yet.<//>`
        }
      <//>
      <${Card} title="Top crashes this week" tools=${html`<a class="btn small ghost" href="#/crashes">All crashes</a>`}>
        ${
          !d.an
            ? NEEDS_AE
            : d.crashes.length
              ? html`<ul class="mini">
                ${d.crashes.slice(0, 4).map(
                  (e) => html`<li><a href=${`#/crashes?open=${encodeURIComponent(e.fingerprint)}`}>
                    <b>${e.type}</b><span>${`${platform(e.platform)} · ${e.message}`}</span><time>${`× ${fmt(e.n)}`}</time>
                  </a></li>`,
                )}
              </ul>`
              : html`<${Empty}>No reports this week.<//>`
        }
      <//>
    </div>
  `;
}

/* ---------------------------------------------------------------- Accounts */

function Funnel({ steps }) {
  const first = steps[0]?.[1] || 0;
  return html`<ol class="funnel">
    ${steps.map(
      ([label, n, sub], i) => html`<li>
        <div class="funnel-h"><span>${label}</span><b>${fmt(n)}</b><em>${i ? pct(share(n, first)) : ''}</em></div>
        <div class="funnel-bar"><i style=${{ width: `${first ? Math.max(1, (n / first) * 100) : 0}%`, background: S(i) }}></i></div>
        ${sub && html`<p class="hint">${sub}</p>`}
      </li>`,
    )}
  </ol>`;
}

const METRICS = [
  ['d1', 'Day'],
  ['d7', 'Week'],
  ['d30', 'Month'],
];

function ActiveAccounts({ d }) {
  const [metric, setMetric] = useState('d1');
  const [by, setBy] = useState('all');
  const [picked, setPicked] = useState(null);
  const rows = d.an?.active ?? [];
  const latest = rows.reduce((x, r) => (r.day > x ? r.day : x), '');
  const shownDay = picked ?? latest;
  const apps = useMemo(() => {
    const totals = new Map();
    for (const r of rows) if (r.scope === 'app') totals.set(r.name, (totals.get(r.name) ?? 0) + Number(r.d1));
    return [...totals.keys()].sort((x, y) => totals.get(y) - totals.get(x));
  }, [rows]);
  if (!d.an) return html`<${Card} title="Active accounts">${NEEDS_AE}<//>`;
  if (!rows.length)
    return html`<${Card} title="Active accounts"><${Empty}>No days counted yet. Turn on <a href="#/collection">Active accounts</a>; the first count comes after midnight.<//><//>`;
  const at = (scope, name, dd) => rows.find((r) => r.scope === scope && r.name === name && r.day === dd);
  const series = by === 'all' ? [{ name: 'All accounts', color: 'var(--s1)' }] : apps.map((n, i) => ({ name: platform(n), color: S(i) }));
  const chartRows = d.d30.map((dd) => ({
    key: dd,
    label: dayLong(dd),
    short: dayShort(dd),
    values: by === 'all' ? [at('all', 'all', dd)?.[metric] ?? null] : apps.map((n) => at('app', n, dd)?.[metric] ?? null),
  }));
  const on = (scope) =>
    rows
      .filter((r) => r.scope === scope && r.day === shownDay)
      .map((r) => ({ ...r, key: r.name, d1: Number(r.d1), d7: Number(r.d7), d30: Number(r.d30) }));
  const cols = (first) => [first, ...METRICS.map(([k, l]) => ({ key: k, label: l === 'Day' ? 'Day' : l, num: true, meter: k === metric }))];
  const pickedIndex = d.d30.indexOf(shownDay);
  return html`
    <${Card}
      title="Active accounts, last 30 days"
      sub=${`Accounts that used terminus in the ${metric === 'd1' ? 'day' : metric === 'd7' ? '7 days' : '30 days'} to each date. Counted after midnight, so today is empty.`}
      tools=${html`<${Segmented} label="Window" value=${metric} options=${METRICS} onChange=${setMetric} />
        <${Segmented}
          label="Split"
          value=${by}
          options=${[
            ['all', 'Total'],
            ['app', 'By app'],
          ]}
          onChange=${setBy}
        />`}
    >
      <${Chart}
        rows=${chartRows}
        series=${series}
        stacked=${by === 'app'}
        picked=${pickedIndex >= 0 ? pickedIndex : null}
        onPick=${(i) => rows.some((r) => r.day === d.d30[i]) && setPicked(d.d30[i])}
        pickNote="Click for this day’s apps and versions"
      />
      <div class="grid two inner">
        <${Table}
          caption=${`By app, ${dayLong(shownDay)}`}
          cols=${cols({ key: 'name', label: 'App', fmt: (v) => platform(v) })}
          rows=${on('app')}
          sort=${{ key: metric, dir: 'desc' }}
        />
        <${Table}
          caption=${`By version (devices), ${dayLong(shownDay)}`}
          cols=${cols({ key: 'name', label: 'Version', cell: (r) => html`<code>${r.name}</code>` })}
          rows=${on('version')}
          sort=${{ key: metric, dir: 'desc' }}
          limit=${8}
        />
      </div>
      ${picked && picked !== latest && html`<button type="button" class="more" onClick=${() => setPicked(null)}>Back to the latest day</button>`}
    <//>
  `;
}

export function Accounts({ s, d }) {
  const a = s.accounts ?? {};
  const ap = s.apps ?? {};
  const [cumulative, setCumulative] = useState(false);
  return html`
    <div class="tiles">
      <${Tile} k="Accounts" n=${a.total} spark=${d.accountsRun} />
      <${Tile} k="New this week" n=${a.new7d} sub=${`${fmt(a.new30d)} this month`} />
      <${Tile} k="Active today" n=${a.active1d} sub=${pct(share(a.active1d, a.total)) + ' of accounts'} />
      <${Tile} k="Active this week" n=${a.active7d} sub=${pct(share(a.active7d, a.total)) + ' of accounts'} />
      <${Tile} k="With a timetable" n=${a.withTimetable} sub=${pct(share(a.withTimetable, a.total)) + ' of accounts'} />
      <${Tile} k="With home stops" n=${a.withHome} sub=${pct(share(a.withHome, a.total)) + ' of accounts'} />
      <${Tile} k="Without an email" n=${a.anonymous} sub=${pct(share(a.anonymous, a.total)) + ' of accounts'} />
      <${Tile} k="Web sessions this week" n=${a.webSessions7d} />
    </div>
    <div class="grid two">
      <${Card} title="Sign-ups, last 30 days" tools=${html`<${Segmented}
          label="Show"
          value=${cumulative}
          options=${[
            [false, 'Per day'],
            [true, 'Accounts'],
          ]}
          onChange=${setCumulative}
        />`}>
        <${Chart}
          line=${cumulative}
          rows=${d.d30.map((x, i) => ({
            label: dayLong(x),
            short: dayShort(x),
            values: [cumulative ? d.accountsRun[i] : d.signups[i]],
            note: cumulative ? `+${fmt(d.signups[i])} that day` : null,
          }))}
          series=${[{ name: cumulative ? 'Accounts' : 'Sign-ups', color: 'var(--accent-bright)' }]}
          note=${`${fmt(sum(d.signups))} sign-ups in 30 days, ${fmt(a.new7d)} in the last 7.`}
        />
      <//>
      <${Card} title="New app installs, last 30 days" sub="An app’s first launch makes an account; these are the ones that went on.">
        <${Funnel}
          steps=${[
            ['Installed', ap.installs30d],
            ['Finished setup', ap.onboarded30d],
            ['Added an email', ap.addedEmail30d, `${fmt(ap.addedEmail)} accounts have added an email ever.`],
          ]}
        />
      <//>
    </div>
    <${ActiveAccounts} d=${d} />
  `;
}

/* ----------------------------------------------------------------- Devices */

export function Devices({ s }) {
  const devices = (s.devices ?? []).map((x) => ({ ...x, key: x.platform, share: share(x.active7, x.total) }));
  const clients = (s.clients ?? []).map((c) => {
    const [p, v] = String(c.client).split('/');
    return { key: c.client, client: c.client, platform: v ? p : '', version: v ?? c.client, n: Number(c.n) };
  });
  const [plat, setPlat] = useState('');
  const platforms = [...new Set(clients.map((c) => c.platform))];
  const byPlat = new Map(platforms.map((p) => [p, sum(clients.filter((c) => c.platform === p).map((c) => c.n))]));
  const shown = clients.filter((c) => !plat || c.platform === plat).map((c) => ({ ...c, share: share(c.n, byPlat.get(c.platform)) }));
  const paired = sum(devices.map((x) => x.total));
  const used = sum(devices.map((x) => x.active7));
  return html`
    <div class="tiles">
      <${Tile} k="Paired devices" n=${paired} />
      <${Tile} k="Used this week" n=${used} sub=${`${pct(share(used, paired))} of paired`} />
      <${Tile} k="API keys" n=${s.apiKeys?.total ?? 0} sub=${`${fmt(s.apiKeys?.used7d ?? 0)} used this week`} />
      <${Tile} k="Web sessions this week" n=${s.accounts?.webSessions7d ?? 0} />
    </div>
    <div class="grid two">
      <${Card} title="Devices by app">
        ${
          devices.length > 1 &&
          html`<${Stack} parts=${devices.map((x, i) => ({ name: platform(x.platform), n: x.total, color: S(i) }))} />
          <${Legend} series=${devices.map((x, i) => ({ name: platform(x.platform), color: S(i) }))} />`
        }
        <${Table}
          cols=${[
            { key: 'platform', label: 'App', fmt: (v) => platform(v) },
            { key: 'total', label: 'Paired', num: true, meter: true },
            { key: 'active7', label: 'Used this week', num: true, meter: true },
            { key: 'share', label: 'Share used', num: true, fmt: (v) => pct(v) },
          ]}
          rows=${devices}
          sort=${{ key: 'total', dir: 'desc' }}
          empty="No paired devices yet."
        />
      <//>
      <${Card}
        title="App versions this week"
        sub="From the version each device sends, for devices seen in the last 7 days (the top 20)."
        tools=${
          platforms.length > 1 &&
          html`<${Chips}
          label="App"
          value=${plat}
          onChange=${setPlat}
          options=${[['', 'All', clients.length], ...platforms.map((p) => [p, platform(p), clients.filter((c) => c.platform === p).length])]}
        />`
        }
      >
        <${Table}
          cols=${[
            { key: 'platform', label: 'App', fmt: (v) => platform(v) || '—' },
            { key: 'version', label: 'Version', cell: (r) => html`<code>${r.version}</code>` },
            { key: 'n', label: 'Devices', num: true, meter: true },
            { key: 'share', label: 'Of the app', num: true, fmt: (v) => pct(v) },
          ]}
          rows=${shown}
          sort=${{ key: 'n', dir: 'desc' }}
          empty="No app has sent its version yet."
        />
      <//>
    </div>
  `;
}

/* ----------------------------------------------------------------- Answers */

const QUALITY = {
  live: 'Live: from the feed',
  scheduled: 'Scheduled: a headway guess',
  ended: 'Ended: no more buses today',
  stale: 'Stale: an older live answer',
  unknown: 'Unknown',
};

export function Answers({ s, d }) {
  const [show, setShow] = useState('answers');
  if (!s.analytics) return NEEDS_AE;
  if (s.analytics.error) return html`<${Empty}><span class="bad">${`Analytics Engine: ${s.analytics.error}`}</span><//>`;
  const quality = (d.an.quality ?? []).map((q) => ({ key: q.quality || '—', quality: q.quality || '—', n: Number(q.n) }));
  const qTotal = sum(quality.map((q) => q.n));
  const live = quality.find((q) => q.quality === 'live')?.n ?? 0;
  const routes = (d.an.errors ?? []).map((e) => ({ key: e.route, route: e.route, n: Number(e.n) }));
  const total = sum(d.answers);
  const errs = sum(d.errors);
  const rows = d.d14.map((x, i) => ({
    label: dayLong(x),
    short: dayShort(x),
    values: show === 'answers' ? [d.answers[i]] : show === 'errors' ? [d.errors[i]] : [d.rate[i]],
    note:
      show === 'answers'
        ? `${fmt(d.errors[i])} errors · ${pct(d.rate[i], 2)}`
        : show === 'errors'
          ? `of ${fmt(d.answers[i])} answers · ${pct(d.rate[i], 2)}`
          : `${fmt(d.errors[i])} errors of ${fmt(d.answers[i])}`,
  }));
  return html`
    <div class="tiles">
      <${Tile} k="Answers, 14 days" n=${total} sub=${`${fmt(Math.round(total / 14))} a day`} spark=${d.answers} />
      <${Tile} k="Last 7 days" n=${d.answers7} delta=${d.answersChange} sub="vs the week before" />
      <${Tile} k="Errors, 14 days" n=${errs} spark=${d.errors} sparkColor="var(--bad)" />
      <${Tile} k="Error rate, 7 days" n=${d.rate7} show=${(x) => pct(x, 2)} delta=${d.rateChange} upGood=${false} sub="vs the week before" />
      <${Tile} k="Live this week" n=${share(live, qTotal)} show=${(x) => pct(x, 1)} sub=${`${fmt(live)} of ${fmt(qTotal)} answers`} />
    </div>
    <${Card}
      title="Per day, last 14 days"
      sub="Days are in UTC, as Analytics Engine counts them."
      tools=${html`<${Segmented}
        label="Show"
        value=${show}
        onChange=${setShow}
        options=${[
          ['answers', 'Answers'],
          ['errors', 'Errors'],
          ['rate', 'Error rate'],
        ]}
      />`}
    >
      <${Chart}
        rows=${rows}
        line=${show === 'rate'}
        whole=${show !== 'rate'}
        fmt=${show === 'rate' ? (x) => pct(x, 2) : fmt}
        yfmt=${show === 'rate' ? (x) => pct(x, x < 0.01 ? 1 : 0) : compact}
        series=${[{ name: show === 'answers' ? 'Answers' : show === 'errors' ? 'Errors' : 'Error rate', color: show === 'answers' ? 'var(--s1)' : 'var(--bad)' }]}
      />
    <//>
    <div class="grid two">
      <${Card} title="How sure, this week" sub="Each answer says how sure it is; a guess is never labelled live.">
        <${Stack} parts=${quality.map((q, i) => ({ name: q.quality, n: q.n, color: S(i) }))} />
        <${Legend} series=${quality.map((q, i) => ({ name: q.quality, color: S(i) }))} />
        <${Table}
          cols=${[
            { key: 'quality', label: 'Quality', fmt: (v) => QUALITY[v] ?? v },
            { key: 'n', label: 'Answers', num: true, meter: true },
            { key: 'share', label: 'Share', num: true, sort: (r) => r.n, fmt: (_, r) => pct(share(r.n, qTotal), 1) },
          ]}
          rows=${quality}
          sort=${{ key: 'n', dir: 'desc' }}
        />
      <//>
      <${Card} title="Errors by route, this week" sub="The ten routes with the most.">
        <${Table}
          cols=${[
            { key: 'route', label: 'Route', cell: (r) => html`<code>${r.route}</code>` },
            { key: 'n', label: 'Errors', num: true, meter: 'var(--bad)' },
            { key: 'share', label: 'Of errors', num: true, sort: (r) => r.n, fmt: (_, r) => pct(share(r.n, sum(routes.map((x) => x.n)))) },
          ]}
          rows=${routes}
          sort=${{ key: 'n', dir: 'desc' }}
          empty="No errors this week."
        />
      <//>
    </div>
  `;
}

/* ----------------------------------------------------------- Arrival times */

const statCols = (first, max) => [
  first,
  { key: 'n', label: 'Scored', num: true, meter: true },
  {
    key: 'medianS',
    label: 'Typical',
    num: true,
    cell: (r) => html`<span class="with-meter"><span>${late(r.medianS)}</span><${Diverge} n=${r.medianS} max=${max} /></span>`,
  },
  { key: 'within1', label: 'Within 1 min', num: true, fmt: (v) => pct(v) },
  { key: 'late2', label: 'Over 2 min late', num: true, fmt: (v) => pct(v) },
  { key: 'early1', label: 'Over 1 min early', num: true, fmt: (v) => pct(v) },
];

export function Arrivals({ s }) {
  const eta = s.eta;
  const [hourShow, setHourShow] = useState('shares');
  if (!eta) return html`<${Empty}>Needs the downloads bucket, where the recorder keeps its days.<//>`;
  if (eta.error) return html`<${Empty}><span class="bad">${eta.error}</span><//>`;
  if (!eta.days.length)
    return html`<${Empty}>No days scored yet. Turn on <a href="#/collection">Arrival-time accuracy</a>; it needs the timelapse recorder on and ANALYTICS_TOKEN. A day is scored the night after.<//>`;
  const o = eta.overall;
  const matched = sum(eta.days.map((x) => x.matched));
  const predictions = sum(eta.days.map((x) => x.predictions));
  const all = [...eta.horizons, ...eta.services, ...eta.hours];
  const max = Math.max(60, ...all.map((r) => Math.abs(r.medianS ?? 0)));
  const days = [...eta.days]
    .sort((x, y) => x.date.localeCompare(y.date))
    .map((x) => ({ ...x, key: x.date, share: share(x.matched, x.predictions) }));
  const hours = eta.hours.map((r) => ({ ...r, key: r.hour, label: `${String(r.hour).padStart(2, '0')}:00` }));
  return html`
    <div class="tiles">
      <${Tile} k="Within a minute" n=${o.within1} show=${(x) => pct(x)} sub="of what the feed said" />
      <${Tile} k="Typical error" n=${late(o.medianS)} sub="+ is later than said" />
      <${Tile} k="Over 2 minutes late" n=${o.late2} show=${(x) => pct(x)} />
      <${Tile} k="Over a minute early" n=${o.early1} show=${(x) => pct(x)} />
      <${Tile} k="Predictions matched" n=${share(matched, predictions)} show=${(x) => pct(x)} sub=${`≈${compact(matched)} of ≈${compact(predictions)}`} />
      <${Tile} k="Days scored" n=${eta.days.length} sub="of the last 14" />
    </div>
    <p class="hint lead">${`Estimates: busy days are sampled. Good to about 15 s either way. Scored ${plural(o.n, 'prediction')} in all.`}</p>
    <${Card} title="By how far ahead it said" sub="Further ahead is less sure.">
      <${Table} cols=${statCols({ key: 'label', label: 'Said', fmt: (v) => v }, max)} rows=${eta.horizons.map((h) => ({ ...h, key: h.label }))} />
    <//>
    <${Card}
      title="By hour of the day"
      tools=${html`<${Segmented}
        label="Show"
        value=${hourShow}
        onChange=${setHourShow}
        options=${[
          ['shares', 'Shares'],
          ['scored', 'Scored'],
        ]}
      />`}
    >
      <${Chart}
        line=${hourShow === 'shares'}
        whole=${hourShow !== 'shares'}
        max=${hourShow === 'shares' ? 1 : undefined}
        rows=${hours.map((r) => ({
          label: `${r.label} to ${String((r.hour + 1) % 24).padStart(2, '0')}:00`,
          short: r.label,
          values: hourShow === 'shares' ? [r.within1, r.late2, r.early1] : [r.n],
          note: `Typically ${late(r.medianS)} · ${fmt(r.n)} scored`,
        }))}
        series=${
          hourShow === 'shares'
            ? [
                { name: 'Within 1 min', color: 'var(--s1)' },
                { name: 'Over 2 min late', color: 'var(--s2)' },
                { name: 'Over 1 min early', color: 'var(--s3)' },
              ]
            : [{ name: 'Scored', color: 'var(--s1)' }]
        }
        fmt=${hourShow === 'shares' ? (x) => pct(x) : fmt}
        yfmt=${hourShow === 'shares' ? (x) => pct(x) : compact}
      />
      <details class="more-table">
        <summary>Every hour as a table</summary>
        <${Table} cols=${statCols({ key: 'label', label: 'Hour', sort: (r) => r.hour }, max)} rows=${hours} sort=${{ key: 'label', dir: 'asc' }} />
      </details>
    <//>
    <${Card} title="By service">
      <${Table} cols=${statCols({ key: 'svc', label: 'Service' }, max)} rows=${eta.services.map((r) => ({ ...r, key: r.svc }))} sort=${{ key: 'svc', dir: 'asc' }} />
    <//>
    <div class="grid two">
      <${Card}
        title="Matched per day"
        sub="Predictions that found their bus, of all read."
      >
        <${Chart}
          height=${200}
          rows=${days.map((x) => ({ label: dayLong(x.date), short: dayShort(x.date), values: [x.matched, x.predictions - x.matched], note: `${pct(x.share)} matched` }))}
          series=${[
            { name: 'Matched', color: 'var(--s1)' },
            { name: 'Not matched', color: 'var(--s4)' },
          ]}
          stacked
          fmt=${(v) => `≈${fmt(v)}`}
        />
      <//>
      <${Card} title="Days scored" sub="How many of the feed’s predictions found their bus.">
        <${Table}
          cols=${[
            { key: 'date', label: 'Day', fmt: (v) => dayLong(v), sort: (r) => r.date },
            { key: 'predictions', label: 'Predictions', num: true, fmt: (v) => `≈${fmt(v)}` },
            { key: 'matched', label: 'Matched', num: true, meter: true, fmt: (v) => `≈${fmt(v)}` },
            { key: 'share', label: 'Share', num: true, fmt: (v) => pct(v) },
          ]}
          rows=${days}
          sort=${{ key: 'date', dir: 'desc' }}
        />
      <//>
    </div>
  `;
}

/* -------------------------------------------------------- Feed & recorder */

/** The recorder's poll outcomes (analytics.ts logPoll), grouped as the chart shows them. */
const OUTCOMES = [
  ['Asked NUS', ['upstream'], 'A request that got an answer.'],
  ['Failed or retried', ['error', 'retry'], 'A request that failed, or one more inside a poll (a fresh token, a second call).'],
  ['From the cache', ['hit'], 'Answered from the 5 s cache: no request.'],
  ['Not asked', ['stale', 'failed', 'skipped'], 'After a recent failure, or with the breaker open.'],
];

function Recorder({ s, d }) {
  if (!s.analytics) return NEEDS_AE;
  if (s.analytics.error || !d.an.timelapse) return null;
  const by = new Map();
  for (const r of d.an.timelapse) {
    const k = `${day(r)} ${r.outcome}`;
    by.set(k, (by.get(k) ?? 0) + Number(r.n));
  }
  const n = (dd, outcome) => by.get(`${dd} ${outcome}`) ?? 0;
  const total = (outcome) => sum(d.d14.map((dd) => n(dd, outcome)));
  const requests = total('upstream') + total('error') + total('retry');
  const polls = requests + total('hit') + total('stale') + total('failed') + total('skipped');
  const table = d.d14.map((dd) => ({
    key: dd,
    day: dd,
    requests: n(dd, 'upstream') + n(dd, 'error') + n(dd, 'retry'),
    error: n(dd, 'error'),
    retry: n(dd, 'retry'),
    hit: n(dd, 'hit'),
    notAsked: n(dd, 'stale') + n(dd, 'failed'),
    skipped: n(dd, 'skipped'),
  }));
  return html`
    <div class="tiles">
      <${Tile} k="Requests to NUS, 14 days" n=${requests} sub=${`${fmt(Math.round(requests / 14))} a day`} spark=${table.map((r) => r.requests)} />
      <${Tile} k="Failed" n=${total('error')} tone=${total('error') ? 'bad' : ''} sub=${`${pct(share(total('error'), requests), 1)} of requests`} />
      <${Tile} k="Retries" n=${total('retry')} />
      <${Tile} k="From the cache" n=${total('hit')} sub=${`${pct(share(total('hit'), polls))} of polls`} />
      <${Tile} k="Not asked after a failure" n=${total('stale') + total('failed')} />
      <${Tile} k="Skipped, breaker open" n=${total('skipped')} />
    </div>
    <${Card}
      title="What each poll did, last 14 days"
      sub="The only scheduled reads of the live buses (CLAUDE.md, rule 2): every 30 s per service, 06:30 to 00:30, at most 17,280 polls a day."
      tools=${html`<a class="btn small ghost" href="/admin/timelapse/">Replay a day</a>`}
    >
      <${Chart}
        stacked
        rows=${d.d14.map((dd) => ({
          label: dayLong(dd),
          short: dayShort(dd),
          values: OUTCOMES.map(([, keys]) => sum(keys.map((k) => n(dd, k)))),
        }))}
        series=${OUTCOMES.map(([name], i) => ({ name, color: S(i) }))}
        note=${OUTCOMES.map(([name, , what]) => `${name}: ${what}`).join(' ')}
      />
      <details class="more-table">
        <summary>Every day as a table</summary>
        <${Table}
          cols=${[
            { key: 'day', label: 'Day', fmt: (v) => dayLong(v) },
            { key: 'requests', label: 'Requests to NUS', num: true, meter: true },
            { key: 'error', label: 'Failed', num: true },
            { key: 'retry', label: 'Retries', num: true },
            { key: 'hit', label: 'From the cache', num: true },
            { key: 'notAsked', label: 'Not asked', num: true },
            { key: 'skipped', label: 'Skipped', num: true },
          ]}
          rows=${table}
          sort=${{ key: 'day', dir: 'desc' }}
        />
      </details>
    <//>
  `;
}

export function Feed({ s, d }) {
  const incidents = (s.incidents ?? []).map((i) => ({
    ...i,
    key: i.start,
    length: (i.end ? Date.parse(i.end) : d.nowMs) - Date.parse(i.start),
  }));
  return html`
    <div class="grid two">
      <${Card} title="NUS feed">
        ${
          s.feed
            ? html`<div class=${`status ${s.feed.up ? 'good' : 'bad'}`}>
              <i></i>
              <div>
                <b>${s.feed.up ? 'Up' : 'Down'}</b>
                <span>${`for ${dur(d.nowMs - Date.parse(s.feed.since))}, since ${when(s.feed.since)}`}</span>
                <span class="hint">${`Last checked ${when(s.feed.checkedAt)} (${ago(s.feed.checkedAt, d.nowMs)}) by the 15-minute cron.`}</span>
              </div>
            </div>`
            : html`<${Empty}>No checks recorded yet.<//>`
        }
        <p class="hint"><a href="/status">Public status page</a></p>
      <//>
      <${Card} title="Outages" sub="The latest five, as the status page shows them.">
        <${Table}
          cols=${[
            { key: 'start', label: 'From', fmt: (v) => when(v) },
            { key: 'end', label: 'To', fmt: (v) => (v ? when(v) : html`<strong class="bad">ongoing</strong>`) },
            { key: 'length', label: 'Lasted', num: true, fmt: (v) => dur(v) },
            { key: 'cause', label: 'Cause', fmt: (v) => (v === 'version' ? 'New uNivUS version' : 'Feed failed') },
          ]}
          rows=${incidents}
          sort=${{ key: 'start', dir: 'desc' }}
          empty="None recorded."
        />
      <//>
    </div>
    <h2 class="section-h">Timelapse recorder</h2>
    <${Recorder} s=${s} d=${d} />
  `;
}

/* ----------------------------------------------------------- Crash reports */

/** A list item that opens to show more, and opens by itself when linked to. */
function Item({ open, children, summary }) {
  const ref = useRef(null);
  useEffect(() => {
    if (open) ref.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [open]);
  return html`<li ref=${ref}>
    <details class=${`item ${open ? 'linked' : ''}`} open=${open}>
      <summary>${summary}</summary>
      <div class="item-body">${children}</div>
    </details>
  </li>`;
}

const matches = (q, ...fields) =>
  !q ||
  fields.some((f) =>
    String(f ?? '')
      .toLowerCase()
      .includes(q),
  );

export function Crashes({ s, d, query }) {
  const [plat, setPlat] = useState('');
  const [q, setQ] = useState('');
  const [order, setOrder] = useState('n');
  if (!s.analytics) return NEEDS_AE;
  if (s.analytics.error) return html`<${Empty}><span class="bad">${`Analytics Engine: ${s.analytics.error}`}</span><//>`;
  const all = d.crashes;
  if (!all.length)
    return html`<${Empty}>No reports this week. Crash reports come in when <a href="#/collection">collecting them</a> is on.<//>`;
  const platforms = [...new Set(all.map((e) => e.platform))];
  const needle = q.trim().toLowerCase();
  const shown = all
    .filter(
      (e) =>
        (!plat || e.platform === plat) && matches(needle, e.type, e.message, e.stack, ...e.versions.map((v) => `${v.version} ${v.os}`)),
    )
    .sort((x, y) =>
      order === 'last' ? aeIso(y.last).localeCompare(aeIso(x.last)) : order === 'fatal' ? y.fatal - x.fatal || y.n - x.n : y.n - x.n,
    );
  return html`
    <div class="tiles">
      <${Tile} k="Reports this week" n=${d.crashReports} />
      <${Tile} k="Closed the app" n=${d.crashFatal} tone=${d.crashFatal ? 'bad' : ''} />
      <${Tile} k="Kinds" n=${all.length} sub="by fingerprint (the top 25)" />
      ${platforms.map((p) => html`<${Tile} k=${platform(p)} n=${sum(all.filter((e) => e.platform === p).map((e) => e.n))} sub="reports" />`)}
    </div>
    <div class="toolbar">
      <${Search} value=${q} onChange=${setQ} placeholder="Search type, message, stack, version" />
      <${Chips}
        label="App"
        value=${plat}
        onChange=${setPlat}
        options=${[['', 'All', all.length], ...platforms.map((p) => [p, platform(p), all.filter((e) => e.platform === p).length])]}
      />
      <${Segmented}
        label="Order"
        value=${order}
        onChange=${setOrder}
        options=${[
          ['n', 'Most reports'],
          ['fatal', 'Most crashes'],
          ['last', 'Latest'],
        ]}
      />
    </div>
    ${
      shown.length
        ? html`<ul class="items">
          ${shown.map((e) => {
            const vmax = Math.max(1, ...e.versions.map((v) => v.n));
            return html`<${Item}
              key=${e.fingerprint}
              open=${query.open === e.fingerprint}
              summary=${html`
                <div class="item-main">
                  <div class="meta"><span class="tag">${platform(e.platform)}</span>${`last ${ago(aeIso(e.last), d.nowMs)} · ${when(aeIso(e.last))}`}</div>
                  <div class="title"><b>${e.type}</b>${e.message ? `: ${e.message}` : ''}</div>
                </div>
                <div class="item-count">
                  <b>${fmt(e.n)}</b><span>${e.n === 1 ? 'report' : 'reports'}</span>
                  ${e.fatal ? html`<span class="tag bad">${`${fmt(e.fatal)} crashed`}</span>` : null}
                </div>
              `}
            >
              <div class="versions">
                ${e.versions.map(
                  (v) =>
                    html`<div class="version"><span><code>${v.version}</code>${v.os ? ` on ${v.os}` : ''}</span><span class="with-meter"><span>${`× ${fmt(v.n)}`}</span><span class="meter"><i style=${{ width: `${(v.n / vmax) * 100}%` }}></i></span></span></div>`,
                )}
              </div>
              ${
                e.stack &&
                html`<div class="pre-h"><span class="hint">Stack</span><${Copy} text=${`${e.type}: ${e.message}\n${e.stack}`} label="Copy" /></div>
                <pre>${e.stack}</pre>`
              }
              <p class="hint">Fingerprint <code>${e.fingerprint}</code></p>
            <//>`;
          })}
        </ul>`
        : html`<${Empty}>Nothing matches.<//>`
    }
  `;
}

/* ----------------------------------------------------------------- Reports */

export function Reports({ s, d, query }) {
  const fb = s.feedback ?? { latest: [], last7d: 0 };
  const [reason, setReason] = useState('');
  const [plat, setPlat] = useState('');
  const [q, setQ] = useState('');
  const all = fb.latest;
  if (!all.length) return html`<${Empty}>No reports yet.<//>`;
  const reasons = [...new Set(all.map((f) => f.reason ?? 'Other'))];
  const platforms = [...new Set(all.map((f) => f.platform))];
  const needle = q.trim().toLowerCase();
  const shown = all.filter(
    (f) =>
      (!reason || (f.reason ?? 'Other') === reason) &&
      (!plat || f.platform === plat) &&
      matches(needle, f.note, f.reason, f.answer, f.email, f.replyTo, f.appVersion),
  );
  const perDay = new Map();
  for (const f of all) {
    const k = new Date(f.created).toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' });
    perDay.set(k, (perDay.get(k) ?? 0) + 1);
  }
  return html`
    <div class="tiles">
      <${Tile} k="This week" n=${fb.last7d} />
      <${Tile} k="Kept here" n=${all.length} sub="the latest 25" />
      <${Tile} k="Can be answered" n=${all.filter((f) => f.email || f.replyTo).length} sub="with an email to reply to" />
      <${Tile} k="Stop suggestions" n=${all.filter((f) => f.context?.venue).length} sub="a better stop for a building" />
    </div>
    <${Card} title="Reports per day" sub="Of the ones kept here.">
      <${Chart}
        height=${150}
        rows=${d.d30.map((x) => ({ label: dayLong(x), short: dayShort(x), values: [perDay.get(x) ?? 0] }))}
        series=${[{ name: 'Reports', color: 'var(--accent-bright)' }]}
      />
    <//>
    <div class="toolbar">
      <${Search} value=${q} onChange=${setQ} placeholder="Search note, answer, email, version" />
      <${Chips} label="Reason" value=${reason} onChange=${setReason} options=${[['', 'All', all.length], ...reasons.map((r) => [r, r, all.filter((f) => (f.reason ?? 'Other') === r).length])]} />
      ${
        platforms.length > 1 &&
        html`<${Chips} label="App" value=${plat} onChange=${setPlat} options=${[['', 'Any app'], ...platforms.map((p) => [p, platform(p), all.filter((f) => f.platform === p).length])]} />`
      }
    </div>
    ${
      shown.length
        ? html`<ul class="items">
          ${shown.map((f) => {
            const to = f.email ?? f.replyTo;
            return html`<${Item}
              key=${f.id}
              open=${query.open === f.id}
              summary=${html`
                <div class="item-main">
                  <div class="meta">
                    <span class="tag">${`${platform(f.platform)}${f.appVersion ? ` ${f.appVersion}` : ''}`}</span>${`${when(f.created)} · ${ago(f.created, d.nowMs)}`}
                  </div>
                  <div class="title"><b>${f.reason ?? 'Other'}</b>${f.note ? html`<span class="note">${f.note}</span>` : !f.reason ? html`<span class="hint">(no note)</span>` : null}</div>
                </div>
              `}
            >
              <dl class="facts">
                <dt>Answer</dt>
                <dd>${f.answer}</dd>
                <dt>From</dt>
                <dd>
                  ${to ? html`<a href=${`mailto:${to}`}>${to}</a>` : 'No email'}
                  ${!f.email && f.replyTo ? html` <span class="hint">(reply-to, not checked)</span>` : null}
                </dd>
                <dt>Kind</dt>
                <dd>${f.kind}</dd>
              </dl>
              ${
                f.context &&
                html`<div class="pre-h"><span class="hint">The answer they saw</span><${Copy} text=${JSON.stringify(f.context, null, 2)} label="Copy JSON" /></div>
                <pre>${JSON.stringify(f.context, null, 2)}</pre>`
              }
            <//>`;
          })}
        </ul>`
        : html`<${Empty}>Nothing matches.<//>`
    }
  `;
}

/* -------------------------------------------------------------- Collection */

/** What each switch collects, in a line: the operator turns each on here (collect.ts). */
export const SWITCHES = [
  [
    'active',
    'Active accounts',
    'How many accounts used terminus each day, by app and version. Counted from the sessions already kept; only the totals are stored.',
  ],
  [
    'eta',
    'Arrival-time accuracy',
    'The feed’s “in 4 min” against when the timelapse recorder saw the bus arrive. No user data. Needs the recorder on.',
  ],
  [
    'errors',
    'Crash reports',
    'Crashes and errors from the apps and the website, with no account, device or address. Each app has a switch to stop sending them.',
  ],
];

export function Collection({ s, flip }) {
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const go = async (name) => {
    setBusy(name);
    setMsg('');
    try {
      await flip(name, !s.collect?.[name]);
    } catch (err) {
      setMsg(err.message);
    } finally {
      setBusy('');
    }
  };
  return html`
    <${Card}>
      <ul class="switches">
        ${SWITCHES.map(([name, title, what]) => {
          const on = Boolean(s.collect?.[name]);
          return html`<li>
            <div>
              <b>${title}</b>
              <p class="hint">${what}</p>
            </div>
            <span class=${`state ${on ? 'good' : ''}`}>${on ? 'Collecting' : 'Off'}</span>
            <button
              type="button"
              role="switch"
              class="switch"
              aria-checked=${on}
              aria-label=${title}
              disabled=${busy === name}
              onClick=${() => go(name)}
            ><i></i></button>
          </li>`;
        })}
      </ul>
      <p class="hint" role="status">${msg || 'The cron counts and scores once a day, after midnight.'}</p>
    <//>
  `;
}
