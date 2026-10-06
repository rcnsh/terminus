// The page a pairing QR code opens on a phone without terminus: the code,
// as the account page showed it, on six split-flap tiles like a departure
// board's (dark in light and dark, as the boards are). Only ever displayed,
// never sent anywhere.

import { html, render } from '/assets/ui.js';

const code = (new URLSearchParams(location.search).get('code') || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 6);
const Code = () =>
  code.length === 6
    ? html`<span class="flaps" role="img" aria-label=${`${code.slice(0, 3)} ${code.slice(3)}`}>${[...code].map((c, i) => html`<span class="flap" key=${i}>${c}</span>`)}</span>`
    : html`<span class="flaps" aria-hidden="true">${[0, 1, 2, 3, 4, 5].map((i) => html`<span class="flap empty" key=${i}></span>`)}</span>`;

const box = document.getElementById('code');
box.replaceChildren();
render(html`<${Code} />`, box);
