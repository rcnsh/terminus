# terminus website

HTML pages with Preact components, with no build step: pages import the
modules as they are written. The Worker in [`apps/api`](../api) serves
everything in `public/`.

| Page | What |
| --- | --- |
| [`/`](public/index.html) | Landing page |
| [`/account`](public/account) | Sign in, import your timetable, set home and places, pair devices. Shows a live preview of your widget |
| [`/app`](public/app) | The installed web app, with four tabs along the bottom: Now (the answer card and today), Buses (what's coming at a stop, and a service's line; `app/buses.js`), the campus map (`app/map.js`) and Settings, each of the last three loaded on first open |
| [`/pair`](public/pair) | Where a pairing QR code lands: opens the app, or shows the code |
| [`/privacy`](public/privacy) | Privacy summary; the full policy is at [`/privacy/policy`](public/privacy/policy). Each has a Chinese copy in `zh/` |
| [`/status`](public/status) | Whether NUS's live feed is answering, and recent outages |
| [`/admin`](public/admin) | Operator dashboard: usage, reports and errors. Asks for the `HEALTH_TOKEN` (`dev` with the stub) |
| [`/admin/timelapse`](public/admin/timelapse) | Replays a recorded day's buses on the map and exports it as a video |
| [`not-found/`](public/not-found) | The page a browser gets for an address the site doesn't have (still a 404) |

Components are written with htm's tagged templates and imported from
`public/assets/ui.js` (Preact, its hooks, `store()`/`useStore()` for state
several components share, and a few helpers):

```js
import { html, useState } from '/assets/ui.js';
import { t } from '/account/dom.js';

export function Saved({ label }) {
  const [open, setOpen] = useState(false);
  return html`<button class="btn" onClick=${() => setOpen(!open)}>${t('Saved as {0}', label)}</button>`;
}
```

The pages' own HTML is the frame (head, header, footer, the landing page's
text); each script draws into a placeholder in it. The account page and the
web app share Settings (`account/settings.js`), the card
(`account/preview.js`) and the profile (`account/profile.js`).

`public/assets/site.css` holds the colours and type shared by every page, and
`public/assets/shots/` has the screenshots. `public/vendor/` has Preact and
htm (`scripts/vendor-preact.sh`), MapLibre GL JS and the PMTiles reader
(`scripts/vendor-map.sh`), and Mediabunny for the timelapse's video export
(`scripts/vendor-mediabunny.sh`), copied from npm and never edited by hand.
`public/sw.js` keeps the app, and the map once opened, for offline; a test
fails if a module the app loads at startup isn't on its list.

## Run it

```bash
node apps/api/scripts/dev-stub.mjs   # from the repo root, then open http://localhost:8787
```

The stub serves these files straight from disk, so a reload shows your change.
Sign in as `you@u.nus.edu` with the code the stub prints. On the map, the stub
drives three fake buses round each route. For the map's labels, put the fonts
and icons in `dev/map/` (`scripts/map-tiles.sh --dry-run`, then copy
`build/map` there); without a map file the streets stay blank, but routes and
stops draw.
