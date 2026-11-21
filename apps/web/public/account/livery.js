import { html } from '../assets/ui.js';

export const LIVERY = [
  ['A1', '#d32f2f'],
  ['A2', '#d9a000'],
  ['D1', '#ec4fa0'],
  ['D2', '#8e44c9'],
  ['K', '#2b9ad6'],
  ['R1', '#f57c1f'],
  ['R2', '#34a853'],
  ['P', '#8a939c'],
];

export function Livery({ mark = true }) {
  const u = 180 / 300;
  const rise = 100;
  const left = 180 - 60 * u + rise / 2;
  const right = left - rise;
  const strip = (from, to, color, key) =>
    html`<path key=${key} d=${`M0 ${left - from}L400 ${right - from}L400 ${right - to - 0.6}L0 ${left - to - 0.6}Z`} fill=${color} />`;
  const colours = LIVERY.filter(([svc]) => svc !== 'P').reverse();
  return html`
    <div class="livery" aria-hidden="true">
      <svg viewBox="0 0 400 180" preserveAspectRatio="none">
        <path d=${`M0 ${left - 0}L400 ${right}L400 ${right - 6 * u}L0 ${left - 6 * u}Z`} class="livery-accent" />
        ${colours.map(([svc, color], i) => strip((16 + 20 * i) * u, (36 + 20 * i) * u, color, svc))}
      </svg>
      ${mark && html`<img class="livery-mark" src="/assets/mark.svg" alt="" />`}
    </div>
  `;
}
