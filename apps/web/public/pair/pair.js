// The page a pairing QR code opens on a phone without terminus: the code,
// as the account page showed it. Only ever displayed, never sent anywhere.

import { html, render } from '/assets/ui.js';

const code = (new URLSearchParams(location.search).get('code') || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 6);
const Code = () => html`${code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : '------'}`;

const box = document.getElementById('code');
box.replaceChildren();
render(html`<${Code} />`, box);
