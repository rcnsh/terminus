// The shuttles' livery: the stripes down a bus's side, as on sign-in, the
// Android app's welcome and the pair page. Its own module so a page without
// the account's code (pair/) can draw it too; styled in site.css.
import { html } from '../assets/ui.js';

/**
 * The services' colours, for the livery: before sign-in there's no /campus to
 * ask, so they're here, mirroring the API's ROUTE_COLORS (src/campus.ts).
 * The landing page's driving shuttles wear them too (sky-page.js).
 */
export const LIVERY = [
  ['A1', '#e53935'], ['A2', '#d9a000'], ['D1', '#ec4fa0'], ['D2', '#8e44c9'],
  ['K', '#2b9ad6'], ['R1', '#f57c1f'], ['R2', '#34a853'], ['P', '#8a939c'],
];

/**
 * The stripes down a bus's side, rising to the right, as on the Android
 * app's welcome: one per service (P's grey would dull it), then a gap and a
 * thin line in the accent, with the mark sitting on the band. Drawn on a
 * 400 × 180 box stretched to the card, so a wide card gets a flatter band.
 */
export function Livery() {
  const u = 180 / 300;
  const rise = 100;
  // The band's lower edge, a fifth of the way up in the middle: the mark sits on it.
  const left = 180 - 60 * u + rise / 2;
  const right = left - rise;
  // Each strip overlaps the next by a little, so no hairline of the card shows between them.
  const strip = (from, to, color, key) => html`<path key=${key} d=${`M0 ${left - from}L400 ${right - from}L400 ${right - to - 0.6}L0 ${left - to - 0.6}Z`} fill=${color} />`;
  const colours = LIVERY.filter(([svc]) => svc !== 'P').reverse();
  return html`
    <div class="livery" aria-hidden="true">
      <svg viewBox="0 0 400 180" preserveAspectRatio="none">
        <path d=${`M0 ${left - 0}L400 ${right}L400 ${right - 6 * u}L0 ${left - 6 * u}Z`} class="livery-accent" />
        ${colours.map(([svc, color], i) => strip((16 + 20 * i) * u, (36 + 20 * i) * u, color, svc))}
      </svg>
      <img class="livery-mark" src="/assets/mark.svg" alt="" />
    </div>
  `;
}
