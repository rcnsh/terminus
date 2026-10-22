// The dashboard's pieces besides charts: how numbers and times are written,
// tiles, sortable tables, and the small controls (segmented switches, filter
// chips, a search box). English only, as the dashboard is.

import { html, useEffect, useMemo, useRef, useState } from '/assets/ui.js';
import { Meter, Spark } from '/admin/charts.js';

export const TZ = { timeZone: 'Asia/Singapore' };
export const DAY = 86_400_000;

export const fmt = (n) => Number(n ?? 0).toLocaleString('en-SG');
/** "40%" of a share from 0 to 1; [digits] after the point. */
export const pct = (x, digits = 0) => (x == null || Number.isNaN(x) ? '—' : `${(x * 100).toFixed(digits)}%`);
/** [n] as a share of [d], or null without a [d]. */
export const share = (n, d) => (d ? n / d : null);
export const when = (iso) =>
  new Date(iso).toLocaleString('en-SG', { ...TZ, day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
/** "Wed 22 Oct" for a YYYY-MM-DD day. */
export const dayLong = (d) =>
  new Date(`${d}T12:00:00+08:00`).toLocaleDateString('en-SG', { ...TZ, weekday: 'short', day: 'numeric', month: 'short' });
/** "22 Oct". */
export const dayShort = (d) => new Date(`${d}T12:00:00+08:00`).toLocaleDateString('en-SG', { ...TZ, day: 'numeric', month: 'short' });

/** "2 d 3 h", "14 min", "40 s": how long [ms] is, to its two largest units. */
export function dur(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h${m % 60 ? ` ${m % 60} min` : ''}`;
  const d = Math.floor(h / 24);
  return `${d} d${h % 24 ? ` ${h % 24} h` : ''}`;
}
/** "3 min ago" for a time in the past. */
export const ago = (iso, now = Date.now()) => {
  const ms = now - new Date(iso).getTime();
  return ms < 45_000 ? 'just now' : `${dur(ms)} ago`;
};

/** Every Singapore day from [days] ago to today, so quiet days show as gaps. */
export function lastDays(days, nowMs = Date.now()) {
  const out = [];
  for (let i = days - 1; i >= 0; i--) out.push(new Date(nowMs - i * DAY).toLocaleDateString('en-CA', TZ));
  return out;
}

/** "+42 s" / "−1 min 5 s": how much later than said the bus came. */
export const late = (s) => {
  if (s == null) return '—';
  const a = Math.abs(s);
  const text = a < 60 ? `${a} s` : `${Math.floor(a / 60)} min${a % 60 ? ` ${a % 60} s` : ''}`;
  return s === 0 ? '0 s' : `${s > 0 ? '+' : '−'}${text}`;
};

export const PLATFORMS = {
  android: 'Android',
  mac: 'Mac',
  ios: 'iPhone',
  web: 'Website',
  api: 'API keys',
  unknown: 'Not seen since pairing',
};
export const platform = (p) => PLATFORMS[p] ?? p;

/** A series colour, by its place in a fixed order (admin.css). */
export const S = (i) => `var(--s${(i % 5) + 1})`;

const still = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** [target], counted up to from where it was over half a second. */
export function useCount(target) {
  const [v, setV] = useState(target);
  const from = useRef(0);
  useEffect(() => {
    if (typeof target !== 'number' || still()) {
      setV(target);
      from.current = target;
      return undefined;
    }
    const start = performance.now();
    const a = typeof from.current === 'number' ? from.current : 0;
    let raf = 0;
    const step = (t) => {
      const k = Math.min(1, (t - start) / 550);
      const e = 1 - (1 - k) ** 3;
      setV(a + (target - a) * e);
      if (k < 1) raf = requestAnimationFrame(step);
      else from.current = target;
    };
    raf = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(raf);
      from.current = target;
    };
  }, [target]);
  return v;
}

/**
 * A number with what it is, and optionally a line under it, a change since
 * an earlier period (with whether up is good), a trend and a place it links to.
 */
export function Tile({ n, show = fmt, k, sub, delta, upGood = true, spark, sparkColor, href, tone }) {
  const counted = typeof n === 'number';
  const v = useCount(counted ? n : 0);
  const body = html`
    <div class="k">${k}</div>
    <div class=${`n ${tone ?? ''}`}>${counted ? show(Number.isInteger(n) ? Math.round(v) : v) : (n ?? '—')}</div>
    ${
      (sub || delta != null) &&
      html`<div class="sub">
      ${delta != null && Number.isFinite(delta) && html`<span class=${`delta ${delta === 0 ? '' : delta > 0 === upGood ? 'up' : 'down'}`}>${delta > 0 ? '▲' : delta < 0 ? '▼' : '■'} ${pct(Math.abs(delta))}</span>`}
      ${sub}
    </div>`
    }
    ${spark && html`<${Spark} values=${spark} color=${sparkColor} />`}
  `;
  return href ? html`<a class="tile link" href=${href}>${body}</a>` : html`<div class="tile">${body}</div>`;
}

/**
 * A table that sorts by any column (a click on its heading; again to turn it
 * round). [cols]: { key, label, num, fmt, sort, cell, meter }. A meter column
 * draws a bar against the column's largest value. Past [limit] rows, a button
 * shows the rest.
 */
export function Table({ cols, rows, sort: initial, empty = 'None.', limit = 0, onRow, isActive, caption }) {
  const [sort, setSort] = useState(initial ?? null);
  const [all, setAll] = useState(false);
  const sorted = useMemo(() => {
    if (!sort) return rows;
    const c = cols.find((x) => x.key === sort.key);
    const val = c?.sort ?? ((r) => r[sort.key]);
    return [...rows].sort((a, b) => {
      const x = val(a);
      const y = val(b);
      const d =
        x == null ? 1 : y == null ? -1 : typeof x === 'number' ? x - y : String(x).localeCompare(String(y), 'en', { numeric: true });
      return sort.dir === 'asc' ? d : -d;
    });
  }, [rows, sort, cols]);
  const max = useMemo(
    () => Object.fromEntries(cols.filter((c) => c.meter).map((c) => [c.key, Math.max(0, ...rows.map((r) => Number(r[c.key]) || 0))])),
    [rows, cols],
  );
  const shown = limit && !all ? sorted.slice(0, limit) : sorted;
  const click = (c) =>
    setSort((s) =>
      s?.key === c.key ? { key: c.key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key: c.key, dir: c.num ? 'desc' : 'asc' },
    );
  return html`
    <div class="table-wrap">
      <table class="data">
        ${caption && html`<caption>${caption}</caption>`}
        <thead>
          <tr>
            ${cols.map(
              (
                c,
              ) => html`<th class=${c.num ? 'num' : ''} aria-sort=${sort?.key === c.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                <button type="button" onClick=${() => click(c)}>
                  ${c.label}<span class="arrow">${sort?.key === c.key ? (sort.dir === 'asc' ? '↑' : '↓') : '↕'}</span>
                </button>
              </th>`,
            )}
          </tr>
        </thead>
        <tbody>
          ${
            shown.length
              ? shown.map(
                  (r, i) => html`<tr
                  key=${r.key ?? i}
                  class=${`${onRow ? 'pick' : ''} ${isActive?.(r) ? 'active' : ''}`}
                  onClick=${onRow && (() => onRow(r))}
                >
                  ${cols.map(
                    (c) => html`<td class=${c.num ? 'num' : ''}>
                      ${
                        c.meter
                          ? html`<span class="with-meter"><span>${(c.fmt ?? fmt)(r[c.key], r)}</span><${Meter} n=${Number(r[c.key]) || 0} max=${max[c.key]} color=${c.meter === true ? undefined : c.meter} /></span>`
                          : c.cell
                            ? c.cell(r)
                            : (c.fmt ?? ((v) => (c.num ? fmt(v) : (v ?? '—'))))(r[c.key], r)
                      }
                    </td>`,
                  )}
                </tr>`,
                )
              : html`<tr><td colspan=${cols.length} class="hint">${empty}</td></tr>`
          }
        </tbody>
      </table>
      ${
        limit && rows.length > limit
          ? html`<button type="button" class="more" onClick=${() => setAll(!all)}>${all ? 'Show fewer' : `Show all ${rows.length}`}</button>`
          : null
      }
    </div>
  `;
}

/** A row of mutually exclusive choices ([options]: [value, label]). */
export function Segmented({ value, options, onChange, label }) {
  return html`<div class="seg" role="radiogroup" aria-label=${label}>
    ${options.map(
      ([v, l]) =>
        html`<button type="button" role="radio" aria-checked=${v === value} class=${v === value ? 'on' : ''} onClick=${() => onChange(v)}>${l}</button>`,
    )}
  </div>`;
}

/** Filter chips, each with its count ([options]: [value, label, count]); '' is all. */
export function Chips({ value, options, onChange, label }) {
  return html`<div class="chips" role="radiogroup" aria-label=${label}>
    ${options.map(
      ([
        v,
        l,
        n,
      ]) => html`<button type="button" role="radio" aria-checked=${v === value} class=${v === value ? 'on' : ''} onClick=${() => onChange(v)}>
        ${l}${n != null && html`<span class="count">${fmt(n)}</span>`}
      </button>`,
    )}
  </div>`;
}

/** A search box; "/" anywhere on the page jumps to it (admin.js). */
export function Search({ value, onChange, placeholder }) {
  return html`<label class="search">
    <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="9" cy="9" r="5.5" /><path d="M13 13l4 4" /></svg>
    <input type="search" data-search value=${value} placeholder=${placeholder} aria-label=${placeholder} onInput=${(e) => onChange(e.currentTarget.value)} />
    <kbd>/</kbd>
  </label>`;
}

/** A card with a heading, an optional line under it, and controls on the right. */
export const Card = ({ title, sub, tools, children, wide, id }) => html`
  <section class=${`card panel ${wide ? 'wide' : ''}`} id=${id}>
    ${
      (title || tools) &&
      html`<header class="panel-h">
      <div>${title && html`<h2>${title}</h2>`}${sub && html`<p class="hint">${sub}</p>`}</div>
      ${tools && html`<div class="tools">${tools}</div>`}
    </header>`
    }
    ${children}
  </section>
`;

/** What to do when a part has nothing to show, in a box rather than a blank. */
export const Empty = ({ children }) => html`<div class="empty">${children}</div>`;

/** Copies [text], saying so on the button for a moment. */
export function Copy({ text, label = 'Copy' }) {
  const [done, setDone] = useState(false);
  return html`<button
    type="button"
    class="btn small ghost copy"
    onClick=${async (e) => {
      e.stopPropagation();
      try {
        await navigator.clipboard.writeText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1400);
      } catch {
        // Without clipboard access the text is still there to select.
      }
    }}
  >
    ${done ? 'Copied' : label}
  </button>`;
}
