// The dashboard's Arrival model section: the arrival-time model run in
// shadow (src/etashadow.ts), which answers no one. Each day is answered
// by a model built only from the 28 days before it, every way the model
// can answer, against when the bus came. docs/eta-model.md says what the
// numbers must show before it answers anyone: the blend beating the feed's
// MAE and p90 at every horizon, on most days.

import { html, useState } from '/assets/ui.js';
import { Chart, Legend } from '/admin/charts.js';
import { Card, Empty, S, Segmented, Table, Tile, dayLong, dayShort, fmt, pct } from '/admin/parts.js';

/** Every way of answering, in the model's order, with what each is. */
export const METHODS = [
  ['feed', 'Feed', 'The feed’s time, as users see it now.'],
  ['corrected', 'Corrected feed', 'The feed’s time plus its usual error for that service and horizon.'],
  ['history', 'History', 'Segment times alone, from the bus’s last stop.'],
  ['gated', 'History, gated', 'History, but the feed’s time at a layover or for a held bus.'],
  ['recent', 'With buses ahead', 'Gated history, using the buses that just drove each segment.'],
  ['blend', 'Blend', 'The corrected feed and history, weighted per horizon: what would ship.'],
];
const LABEL = Object.fromEntries(METHODS.map(([k, l]) => [k, l]));
/** The chart's lines: five colours, so raw history (far off beyond 2 minutes) is in the tables only. */
const CHARTED = ['feed', 'corrected', 'gated', 'recent', 'blend'];
const METRICS = [
  ['mae', 'Mean error'],
  ['p90', '90th percentile'],
  ['bias', 'Signed'],
];
/** Days scored before the numbers are worth reading (docs/eta-model.md). */
const READ_FROM = 7;

const secs = (s) => (s == null ? '—' : `${Math.round(s)} s`);
const signed = (s) => (s == null ? '—' : s === 0 ? '0 s' : `${s > 0 ? '+' : '−'}${Math.abs(Math.round(s))} s`);
const show = (metric) => (metric === 'bias' ? signed : secs);

/** [method]'s [metric] over [days], weighted by how many questions each scored: [mean, questions]. */
function pooled(days, method, metric, h = null) {
  let sum = 0;
  let n = 0;
  for (const d of days) {
    const st = h == null ? d.overall?.[method] : d.horizons?.[h]?.stats?.[method];
    if (!st?.n || st[metric] == null) continue;
    sum += st.n * st[metric];
    n += st.n;
  }
  return [n ? sum / n : null, n];
}

/** Of the days both were scored at horizon [h], how many the blend erred less than the feed by [metric]. */
function wins(days, h, metric) {
  let won = 0;
  let of = 0;
  for (const d of days) {
    const st = d.horizons?.[h]?.stats;
    if (!st?.blend?.n || st.blend[metric] == null || st.feed?.[metric] == null) continue;
    of++;
    if (st.blend[metric] < st.feed[metric]) won++;
  }
  return [won, of];
}

/** What a horizon's record says so far, in a word. */
function verdict(mae, p90, scored) {
  if (scored < READ_FROM) return ['wait', 'Too early'];
  const most = (x) => x[1] && x[0] / x[1] > 0.5;
  if (most(mae) && most(p90)) return ['good', 'Blend ahead'];
  if (most(mae) || most(p90)) return ['warn', 'Mixed'];
  return ['bad', 'Feed ahead'];
}

export function Model({ s }) {
  const m = s.model;
  const [metric, setMetric] = useState('mae');
  const [picked, setPicked] = useState(null);
  if (!m) return html`<${Empty}>Needs the downloads bucket, where the model keeps its days.<//>`;
  if (m.error) return html`<${Empty}><span class="bad">${m.error}</span><//>`;
  const days = m.days ?? [];
  const scored = days.filter((d) => d.coverage > 0 && d.overall?.blend?.n);
  const latest = days.at(-1);
  const historyDays = latest?.built?.days ?? 0;
  const status = html`
    <${Card}>
      <div class="model-status">
        <div class=${`status ${m.on ? 'good' : ''}`}>
          <i></i>
          <div>
            <b>${m.on ? 'In shadow' : 'Off'}</b>
            <span>
              ${
                m.on
                  ? 'It answers every day’s questions beside the feed, and no one sees its times: users get the feed’s.'
                  : html`Set the <code>ETA_MODEL</code> var to <code>shadow</code> to run it. Nobody would see its times.`
              }
            </span>
            ${
              !s.collect?.eta &&
              html`<span class="bad">It also needs <a href="#/collection">Arrival-time accuracy</a> on: the feed’s scored errors are its input.</span>`
            }
          </div>
        </div>
        <div class="warmup">
          <div class="funnel-h"><span>History it learns from</span><b>${`${historyDays} of ${m.historyDays} days`}</b></div>
          <div class="funnel-bar"><i style=${{ width: `${Math.min(100, (historyDays / m.historyDays) * 100)}%`, background: 'var(--s1)' }}></i></div>
          <p class="hint">
            ${`Each day is answered by a model built only from the ${m.historyDays} days before it. Read the numbers from about a week in; judge after about four weeks, at least 500 matched questions a day.`}
          </p>
        </div>
      </div>
    <//>
  `;
  if (!days.length)
    return html`${status}<${Empty}>No day answered yet. The cron answers the newest closed day each night, after the feed’s times are scored.<//>`;

  const [blendMae] = pooled(scored, 'blend', 'mae');
  const [feedMae, questions] = pooled(scored, 'feed', 'mae');
  const gain = blendMae != null && feedMae ? (feedMae - blendMae) / feedMae : null;
  const warming = !scored.length;
  const pickedDay = days.find((d) => d.date === picked) ?? scored.at(-1) ?? latest;
  const horizons = (pickedDay.horizons ?? []).map((x) => x.label);
  const rowsFor = (keys) =>
    days.map((d) => ({
      label: dayLong(d.date),
      short: dayShort(d.date),
      values: keys.map((k) => d.overall?.[k]?.[metric] ?? null),
      note: d.coverage ? `${pct(d.coverage)} of ${fmt(d.cases)} questions scored` : 'No history yet: nothing scored',
    }));

  return html`
    ${status}
    <div class="tiles">
      <${Tile} k="Days answered" n=${days.length} sub=${`${fmt(scored.length)} with history to score`} />
      <${Tile} k="Questions scored" n=${questions} sub=${`of ${fmt(days.reduce((t, d) => t + (d.cases ?? 0), 0))} that found their bus`} />
      <${Tile} k="Coverage, latest day" n=${latest.coverage ?? null} show=${(x) => pct(x)} sub="history could answer" />
      <${Tile} k="Feed, mean error" n=${feedMae == null ? null : Math.round(feedMae)} show=${(x) => `${Math.round(x)} s`} sub="on the days scored" />
      <${Tile}
        k="Blend, mean error"
        n=${blendMae == null ? null : Math.round(blendMae)}
        show=${(x) => `${Math.round(x)} s`}
        delta=${gain == null ? null : -gain}
        upGood=${false}
        sub="against the feed"
        tone=${gain == null ? '' : gain > 0 ? 'good' : 'bad'}
      />
    </div>
    ${
      warming
        ? html`<${Empty}>
          No day has had history to answer with yet, so there's nothing to compare. Each day's model is built only from the segment times of the
          days before it, and the first days have none: the feed and the corrected feed are scored only where history can answer too. Coverage
          grows as days build up.
        <//>`
        : html`
    <${Card}
      title="Blend against the feed, by how far ahead"
      sub=${`The test before it answers anyone: the blend erring less than the feed, by mean and by 90th percentile, at every horizon on most days. Too early until ${READ_FROM} days are scored.`}
    >
      <${Table}
        cols=${[
          { key: 'label', label: 'Said' },
          { key: 'feed', label: 'Feed', num: true, fmt: (v) => secs(v) },
          {
            key: 'blend',
            label: 'Blend',
            num: true,
            fmt: (v, r) =>
              html`<span class=${r.blend != null && r.feed != null ? (r.blend < r.feed ? 'good' : 'bad') : ''}>${secs(v)}</span>`,
          },
          {
            key: 'mae',
            label: 'Days ahead, mean',
            num: true,
            sort: (r) => r.mae[0] / (r.mae[1] || 1),
            fmt: (v) => (v[1] ? `${v[0]} of ${v[1]}` : '—'),
          },
          {
            key: 'p90',
            label: 'Days ahead, p90',
            num: true,
            sort: (r) => r.p90[0] / (r.p90[1] || 1),
            fmt: (v) => (v[1] ? `${v[0]} of ${v[1]}` : '—'),
          },
          { key: 'verdict', label: 'So far', cell: (r) => html`<span class=${`tag ${r.verdict[0]}`}>${r.verdict[1]}</span>` },
        ]}
        rows=${horizons.map((label, h) => {
          const mae = wins(scored, h, 'mae');
          const p90 = wins(scored, h, 'p90');
          return {
            key: label,
            label,
            feed: pooled(scored, 'feed', 'mae', h)[0],
            blend: pooled(scored, 'blend', 'mae', h)[0],
            mae,
            p90,
            verdict: verdict(mae, p90, Math.min(mae[1], p90[1])),
          };
        })}
      />
      <p class="hint chart-note">Feed and Blend are mean errors over every scored day, weighted by questions.</p>
    <//>
    <${Card}
      title="Error per day, every way"
      sub="Each line is one way of answering the same questions (those history could answer). Lower is better; signed is the bus coming later than said."
      tools=${html`<${Segmented} label="Measure" value=${metric} options=${METRICS} onChange=${setMetric} />`}
    >
      <${Chart}
        line
        fromZero=${false}
        rows=${rowsFor(CHARTED)}
        series=${CHARTED.map((k, i) => ({ name: LABEL[k], color: S(i) }))}
        fmt=${show(metric)}
        yfmt=${(x) => `${x} s`}
        picked=${days.indexOf(pickedDay)}
        onPick=${(i) => setPicked(days[i].date)}
        pickNote="Click for this day by horizon"
      />
    <//>`
    }
    <div class="grid two">
      <${Card} title="Coverage per day" sub="The share of questions history could answer: it grows as days build up.">
        <${Chart}
          line
          whole=${false}
          max=${1}
          height=${180}
          rows=${days.map((d) => ({
            label: dayLong(d.date),
            short: dayShort(d.date),
            values: [d.coverage],
            note: `Built from ${d.built?.days ?? 0} days, ${fmt(d.built?.pairs ?? 0)} stop pairs`,
          }))}
          series=${[{ name: 'Coverage', color: 'var(--s1)' }]}
          fmt=${(x) => pct(x)}
          yfmt=${(x) => pct(x)}
        />
      <//>
      ${
        !warming &&
        html`
      <${Card} title=${`Weight on history, ${dayLong(pickedDay.date)}`} sub="Per horizon, how much the blend leans on history over the corrected feed; fitted on the days before. 0 is the feed alone.">
        <ul class="weights">
          ${(pickedDay.weights ?? []).map(
            (w, i) => html`<li>
              <span>${horizons[i] ?? `Horizon ${i + 1}`}</span>
              <span class="funnel-bar"><i style=${{ width: `${w * 100}%`, background: 'var(--s5)' }}></i></span>
              <b>${w.toFixed(1)}</b>
            </li>`,
          )}
        </ul>
      <//>`
      }
    </div>
    ${
      !warming &&
      html`
    <${Card}
      title=${`${dayLong(pickedDay.date)}, by how far ahead`}
      sub=${
        pickedDay.coverage
          ? `${fmt(pickedDay.overall?.feed?.n ?? 0)} questions scored (${pct(pickedDay.coverage)} of ${fmt(pickedDay.cases)}), from ${fmt(pickedDay.predictions)} predictions. The best of each row is marked.`
          : `No history to answer with yet: ${fmt(pickedDay.cases)} questions found their bus, none could be scored.`
      }
      tools=${html`<${Segmented} label="Measure" value=${metric} options=${METRICS} onChange=${setMetric} />`}
    >
      <${DayTable} day=${pickedDay} metric=${metric} />
      <details class="more-table">
        <summary>What each way is</summary>
        <${Legend} series=${METHODS.map(([k, l]) => ({ name: `${l}: ${METHODS.find((x) => x[0] === k)[2]}`, color: CHARTED.includes(k) ? S(CHARTED.indexOf(k)) : 'var(--faint)' }))} />
      </details>
    <//>`
    }
    <${Card} title="Every day">
      <${Table}
        cols=${[
          { key: 'date', label: 'Day', fmt: (v) => dayLong(v) },
          {
            key: 'built',
            label: 'Built from',
            num: true,
            sort: (r) => r.built?.days ?? 0,
            fmt: (v) => `${v?.days ?? 0} ${v?.days === 1 ? 'day' : 'days'}`,
          },
          { key: 'predictions', label: 'Predictions', num: true },
          { key: 'cases', label: 'Found their bus', num: true },
          { key: 'coverage', label: 'Coverage', num: true, meter: true, fmt: (v) => pct(v) },
          { key: 'feed', label: 'Feed', num: true, sort: (r) => r.overall?.feed?.mae ?? null, fmt: (_, r) => secs(r.overall?.feed?.mae) },
          {
            key: 'blend',
            label: 'Blend',
            num: true,
            sort: (r) => r.overall?.blend?.mae ?? null,
            fmt: (_, r) => secs(r.overall?.blend?.mae),
          },
          {
            key: 'diff',
            label: 'Blend − feed',
            num: true,
            sort: (r) => diff(r),
            fmt: (_, r) => {
              const x = diff(r);
              return x == null ? '—' : html`<span class=${x < 0 ? 'good' : x > 0 ? 'bad' : ''}>${signed(x)}</span>`;
            },
          },
        ]}
        rows=${days.map((d) => ({ ...d, key: d.date }))}
        sort=${{ key: 'date', dir: 'desc' }}
        onRow=${(r) => setPicked(r.date)}
        isActive=${(r) => r.date === pickedDay.date}
      />
    <//>
  `;
}

const diff = (d) => (d.overall?.blend?.mae != null && d.overall?.feed?.mae != null ? d.overall.blend.mae - d.overall.feed.mae : null);

/** One day, every way, overall and at each horizon: the [metric] and how many were scored. */
function DayTable({ day, metric }) {
  const rows = [{ label: 'All', stats: day.overall }, ...(day.horizons ?? []).map((x) => ({ label: x.label, stats: x.stats }))];
  const fmtv = show(metric);
  return html`<div class="table-wrap">
    <table class="data">
      <thead>
        <tr>
          <th><span class="th">Said</span></th>
          <th class="num"><span class="th">Scored</span></th>
          ${METHODS.map(([, l]) => html`<th class="num"><span class="th">${l}</span></th>`)}
        </tr>
      </thead>
      <tbody>
        ${rows.map((r) => {
          const vals = METHODS.map(([k]) => r.stats?.[k]?.[metric] ?? null);
          const best =
            metric === 'bias' ? Math.min(...vals.filter((v) => v != null).map(Math.abs)) : Math.min(...vals.filter((v) => v != null));
          return html`<tr>
            <td>${r.label}</td>
            <td class="num">${fmt(r.stats?.feed?.n ?? 0)}</td>
            ${vals.map((v) => {
              const top = v != null && (metric === 'bias' ? Math.abs(v) : v) === best;
              return html`<td class=${`num ${top ? 'best' : ''}`}>${fmtv(v)}</td>`;
            })}
          </tr>`;
        })}
      </tbody>
    </table>
  </div>`;
}
