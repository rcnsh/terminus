# terminus website

Plain HTML, CSS and JavaScript, with no build step. The Worker in
[`apps/api`](../api) serves everything in `public/`.

| Page | What |
| --- | --- |
| [`/`](public/index.html) | Landing page |
| [`/account`](public/account) | Sign in, import your timetable, set home and places, pair devices. Shows a live preview of your widget |
| [`/app`](public/app) | The installed web app: Now (the answer card and today) and the campus map (`app/map.js`, loaded on first open), with a bar along the bottom |
| [`/pair`](public/pair) | Where a pairing QR code lands: opens the app, or shows the code |
| [`/privacy`](public/privacy) | Privacy notice |
| [`/status`](public/status) | Whether NUS's live feed is answering, and recent outages |
| [`/admin`](public/admin) | Operator dashboard: usage, reports and errors. Asks for the `HEALTH_TOKEN` (`dev` with the stub) |

`public/assets/site.css` holds the colours and type shared by every page, and
`public/assets/shots/` has the screenshots. `public/vendor/` has MapLibre GL JS
and the PMTiles reader, copied from npm by `scripts/vendor-map.sh` (never
edited by hand). `public/sw.js` keeps the app, and the map once opened, for
offline.

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
