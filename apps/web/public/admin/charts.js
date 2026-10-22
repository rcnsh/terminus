// The dashboard's charts, drawn as SVG by Preact: columns (stacked or not)
// and lines with a hover and keyboard readout, sparklines, and the small
// bars that sit in table cells. Colours come from admin.css (--s1 … --s5 for
// series, in a fixed order, so a series keeps its colour when others hide).

import { html, useEffect, useRef, useState } from '/assets/ui.js';

const num = (n) => Number(n ?? 0).toLocaleString('en-SG');
const compactFmt = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
export const compact = (n) => compactFmt.format(n);

/** Round steps from 0 up past [max]: 0, 500, 1000, … */
export function ticks(max, count = 4, whole = true) {
  if (!(max > 0)) return [0, 1];
  const raw = whole ? Math.max(1, max / count) : max / count;
  const p = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw);
  const top = Math.ceil(max / step - 1e-9) * step;
  return Array.from({ length: Math.round(top / step) + 1 }, (_, i) => +(i * step).toPrecision(12));
}

/** The element's width, following it as the window changes. */
function useWidth(ref, initial = 640) {
  const [w, setW] = useState(initial);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    setW(el.clientWidth || initial);
    const ro = new ResizeObserver(([e]) => setW(Math.round(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return w;
}

/** A column from [yBase] up to [yTop], its top corners rounded. */
function bar(x, w, yTop, yBase, round) {
  const h = yBase - yTop;
  if (!(h > 0.4)) return '';
  const r = round ? Math.min(4, w / 2, h) : 0;
  return `M${x},${yBase}V${yTop + r}Q${x},${yTop} ${x + r},${yTop}H${x + w - r}Q${x + w},${yTop} ${x + w},${yTop + r}V${yBase}Z`;
}

/** The series' names, each with its colour; a click hides or shows one. */
export function Legend({ series, hidden, onToggle, line }) {
  return html`<div class="legend">
    ${series.map(
      (s, i) => html`<button
        type="button"
        class=${`key ${hidden?.has(i) ? 'off' : ''}`}
        aria-pressed=${!hidden?.has(i)}
        onClick=${() => onToggle?.(i)}
        disabled=${!onToggle}
      >
        <i class=${line ? 'line' : ''} style=${{ background: s.color }}></i>${s.name}
      </button>`,
    )}
  </div>`;
}

/**
 * Columns, or lines, over [rows] ({ label, short, values: [per series] }).
 * Hovering, or the arrow keys once focused, reads out every series at that
 * place; a click (or Enter) picks it, when [onPick] is given.
 */
export function Chart({
  rows,
  series,
  stacked = false,
  line = false,
  height = 220,
  fmt = num,
  yfmt = compact,
  max: fixedMax,
  picked = null,
  onPick,
  note,
  pickNote,
  whole = true,
  legend = series.length > 1,
}) {
  const box = useRef(null);
  const w = useWidth(box);
  const [hover, setHover] = useState(null);
  const [hidden, setHidden] = useState(() => new Set());
  const toggle = (i) =>
    setHidden((h) => {
      const next = new Set(h);
      if (next.has(i)) next.delete(i);
      else if (next.size < series.length - 1) next.add(i);
      return next;
    });
  const shown = series.map((_, i) => !hidden.has(i));
  const vals = (r) => r.values.map((v, i) => (shown[i] ? (v ?? 0) : 0));
  const tops = rows.map((r) => (stacked ? vals(r).reduce((a, b) => a + b, 0) : Math.max(0, ...vals(r))));
  const ys = ticks(fixedMax ?? Math.max(0, ...tops), 4, whole);
  const top = ys.at(-1) || 1;
  const M = { l: Math.max(28, 9 * Math.max(...ys.map((t) => yfmt(t).length)) + 4), r: 6, t: 10, b: 24 };
  const iw = Math.max(20, w - M.l - M.r);
  const ih = height - M.t - M.b;
  const base = M.t + ih;
  const y = (v) => base - (Math.min(v, top) / top) * ih;
  const band = iw / Math.max(1, rows.length);
  const cx = (i) => M.l + band * i + band / 2;
  const bw = Math.max(2, Math.min(24, band - 2, band * 0.72));
  const every = Math.max(1, Math.ceil(52 / band));
  const at = hover ?? picked;

  const move = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const i = Math.floor((e.clientX - r.left - M.l) / band);
    setHover(i >= 0 && i < rows.length ? i : null);
  };
  const key = (e) => {
    const i = hover ?? picked ?? rows.length - 1;
    if (e.key === 'ArrowLeft') setHover(Math.max(0, i - 1));
    else if (e.key === 'ArrowRight') setHover(Math.min(rows.length - 1, i + 1));
    else if ((e.key === 'Enter' || e.key === ' ') && onPick) onPick(i);
    else if (e.key === 'Escape') setHover(null);
    else return;
    e.preventDefault();
  };

  const marks = [];
  if (line) {
    series.forEach((s, si) => {
      if (!shown[si]) return;
      const pts = rows.map((r, i) => (r.values[si] == null ? null : [cx(i), y(r.values[si])]));
      let d = '';
      let pen = false;
      for (const p of pts) {
        if (!p) {
          pen = false;
          continue;
        }
        d += `${pen ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`;
        pen = true;
      }
      const first = pts.findIndex(Boolean);
      const last = pts.findLastIndex(Boolean);
      if (series.length === 1 && first >= 0 && pts.slice(first, last + 1).every(Boolean))
        marks.push(html`<path class="wash" d=${`${d}L${pts[last][0]},${base}L${pts[first][0]},${base}Z`} style=${{ fill: s.color }} />`);
      marks.push(html`<path class="stroke" d=${d} style=${{ stroke: s.color }} />`);
      if (at != null && pts[at])
        marks.push(html`<circle class="dot" cx=${pts[at][0]} cy=${pts[at][1]} r="4.5" style=${{ fill: s.color }} />`);
    });
  } else {
    rows.forEach((r, i) => {
      const x = cx(i) - bw / 2;
      const dim = hover != null && hover !== i ? ' dim' : '';
      if (stacked) {
        let acc = 0;
        const v = vals(r);
        const lastOn = v.findLastIndex((n) => n > 0);
        v.forEach((n, si) => {
          if (!n) return;
          const yb = y(acc) - (acc > 0 ? 2 : 0);
          acc += n;
          marks.push(html`<path class=${`col${dim}`} d=${bar(x, bw, y(acc), yb, si === lastOn)} style=${{ fill: series[si].color }} />`);
        });
      } else {
        const v = vals(r);
        const n = shown.filter(Boolean).length;
        const sw = n > 1 ? Math.max(2, (bw - 2 * (n - 1)) / n) : bw;
        let k = 0;
        v.forEach((n2, si) => {
          if (!shown[si]) return;
          marks.push(
            html`<path class=${`col${dim}`} d=${bar(x + k * (sw + 2), sw, y(n2), base, true)} style=${{ fill: series[si].color }} />`,
          );
          k++;
        });
      }
    });
  }

  const tipRow = hover != null ? rows[hover] : null;
  const tipLeft = hover != null ? Math.min(Math.max(cx(hover), 90), w - 90) : 0;
  return html`
    <div class="chart">
      ${legend && html`<${Legend} series=${series} hidden=${hidden} onToggle=${toggle} line=${line} />`}
      <div
        class="plot"
        ref=${box}
        tabindex="0"
        role="img"
        aria-label=${`${series.map((s) => s.name).join(', ')}: ${rows.length} points, ${rows[0]?.label ?? ''} to ${rows.at(-1)?.label ?? ''}. Arrow keys read each.`}
        onPointerMove=${move}
        onPointerLeave=${() => setHover(null)}
        onClick=${() => onPick && hover != null && onPick(hover)}
        onKeyDown=${key}
        onBlur=${() => setHover(null)}
        style=${{ height: `${height}px`, cursor: onPick ? 'pointer' : 'crosshair' }}
      >
        <svg width=${w} height=${height} aria-hidden="true">
          ${ys.map(
            (t) => html`<g key=${`y${t}`}>
              <line class="gl" x1=${M.l} x2=${w - M.r} y1=${y(t)} y2=${y(t)} />
              <text class="tick" x=${M.l - 6} y=${y(t) + 4} text-anchor="end">${yfmt(t)}</text>
            </g>`,
          )}
          ${hover != null && html`<rect class="band" x=${M.l + band * hover} y=${M.t} width=${band} height=${ih} />`}
          ${picked != null && html`<rect class="picked" x=${cx(picked) - band / 2} y=${M.t} width=${band} height=${ih} />`}
          <g class=${line ? 'lines' : 'bars'} style=${{ transformOrigin: `0 ${base}px` }}>${marks}</g>
          ${rows.map((r, i) =>
            (rows.length - 1 - i) % every === 0
              ? html`<text key=${`x${i}`} class=${`tick ${at === i ? 'on' : ''}`} x=${cx(i)} y=${height - 6} text-anchor="middle">${r.short}</text>`
              : null,
          )}
        </svg>
        ${
          tipRow &&
          html`<div class="tip" style=${{ left: `${tipLeft}px` }}>
          <div class="tip-h">${tipRow.label}</div>
          ${series.map((s, si) =>
            shown[si]
              ? html`<div class="tip-r"><i style=${{ background: s.color }}></i><b>${tipRow.values[si] == null ? '—' : fmt(tipRow.values[si])}</b><span>${s.name}</span></div>`
              : null,
          )}
          ${tipRow.note && html`<div class="tip-n">${tipRow.note}</div>`}
          ${pickNote && html`<div class="tip-n">${pickNote}</div>`}
        </div>`
        }
      </div>
      ${note && html`<p class="hint chart-note">${note}</p>`}
    </div>
  `;
}

/** A small trend line for a tile, scaled to its own range. */
export function Spark({ values, color = 'var(--accent-bright)' }) {
  const v = values.map((n) => Number(n ?? 0));
  if (v.length < 2) return null;
  const max = Math.max(...v);
  const min = Math.min(0, ...v);
  const span = max - min || 1;
  const pts = v.map((n, i) => `${((i / (v.length - 1)) * 100).toFixed(2)},${(30 - ((n - min) / span) * 28).toFixed(2)}`);
  return html`<svg class="spark" viewBox="0 0 100 32" preserveAspectRatio="none" aria-hidden="true">
    <path class="wash" d=${`M0,32L${pts.join('L')}L100,32Z`} style=${{ fill: color }} />
    <path class="stroke" d=${`M${pts.join('L')}`} style=${{ stroke: color }} />
  </svg>`;
}

/** A bar for a table cell: [n] against [max]. */
export const Meter = ({ n, max, color }) =>
  html`<span class="meter" aria-hidden="true"><i style=${{ width: `${max > 0 ? Math.max(1.5, (n / max) * 100) : 0}%`, background: color }}></i></span>`;

/** A bar either side of zero, for an error that can be early or late: [n] against ±[max]. */
export const Diverge = ({ n, max }) => {
  const share = max > 0 && n != null ? Math.min(1, Math.abs(n) / max) * 50 : 0;
  return html`<span class="diverge" aria-hidden="true"><i class=${n > 0 ? 'late' : 'early'} style=${{
    width: `${share}%`,
    left: n > 0 ? '50%' : `${50 - share}%`,
  }}></i></span>`;
};

/** Shares of one whole, side by side in one bar ([parts]: { name, n, color }). */
export function Stack({ parts }) {
  const total = parts.reduce((t, p) => t + p.n, 0) || 1;
  const [hover, setHover] = useState(null);
  return html`<div class="stack" onPointerLeave=${() => setHover(null)}>
    ${parts.map(
      (p, i) => html`<span
        class=${hover != null && hover !== i ? 'dim' : ''}
        style=${{ flexGrow: p.n, background: p.color }}
        title=${`${p.name}: ${num(p.n)} (${Math.round((p.n / total) * 100)}%)`}
        onPointerEnter=${() => setHover(i)}
      ></span>`,
    )}
  </div>`;
}
