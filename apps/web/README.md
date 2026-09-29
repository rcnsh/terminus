# terminus website

Plain HTML, CSS and JavaScript, with no build step. The Worker in
[`apps/api`](../api) serves everything in `public/`.

| Page | What |
| --- | --- |
| [`/`](public/index.html) | Landing page |
| [`/account`](public/account) | Sign in, import your timetable, set home and places, pair devices. Shows a live preview of your widget |
| [`/pair`](public/pair) | Where a pairing QR code lands: opens the app, or shows the code |
| [`/privacy`](public/privacy) | Privacy notice |

`public/assets/site.css` holds the colours and type shared by every page, and
`public/assets/shots/` has the screenshots.

## Run it

```bash
node apps/api/scripts/dev-stub.mjs   # from the repo root, then open http://localhost:8787
```

The stub serves these files straight from disk, so a reload shows your change.
Sign in as `you@u.nus.edu` with the link the stub prints.
