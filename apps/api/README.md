# terminus API

The Cloudflare Worker behind terminus. It reads the NUS shuttle feed, works out
which bus you should catch, and serves the answer to every client. It also
serves the website in [`apps/web`](../web).

- **Answers:** `/api/me/next` (the widget's one call) and `/api/me/nearby`, plus the
  keyed routes `/api/next`, `/api/trip`, `/api/arrivals`, `/api/buses`, `/api/line`, `/api/campus` and
  `/api/stops/pairs` (an API key or a signed-in session). Docs at [terminus.run/docs](https://terminus.run/docs).
- **The campus map:** `/api/campus` (stops, and routes along the roads), `/api/buses`
  (a service's live buses) and `/map/*` (the street map, its style, fonts and
  icons from R2).
- **Accounts:** sign-in by emailed code or link, device pairing, profiles in D1.
- **Cron:** every 15 minutes, checks the NUS feed (and LTA DataMall, when set
  up) is up and emails if it isn't, keeps the academic calendar current, and
  does the housekeeping: old sign-in codes, unused anonymous accounts and the
  like.

## Run it

```bash
pnpm install
pnpm test                          # no network, no keys
pnpm typecheck
node scripts/dev-stub.mjs          # the Worker with fake buses on :8787
pnpm dev                           # cf dev against the live feed (needs .dev.vars)
```

The dev stub has a test account, `you@u.nus.edu`. Its sign-in code prints in
the terminal.

## Deploy

```bash
pnpm run deploy                    # D1 migrations, then cf deploy (not `pnpm deploy`, a pnpm built-in)
pnpm run deploy:beta               # the same for beta.terminus.run, with its own D1, KV and R2
```

The config is [`cloudflare.config.ts`](cloudflare.config.ts). The website
folder is set in [`wrangler.config.ts`](wrangler.config.ts).

## Where things are

| | |
| --- | --- |
| `src/` | The Worker. `index.ts` routes, `me.ts` has the account routes, `resolve.ts` picks the stop and bus |
| `test/` | Node's test runner. `golden.test.js` pins whole answers to `test/fixtures/answers` |
| `data/` | Stops, routes, venues and walking paths, bundled into the Worker |
| `migrations/` | D1 schema |
| `scripts/` | Dev stub, and scrapers that rebuild `data/` (`route_shapes.py` makes `data/shapes.json`, the routes along the roads) |
| [`docs/`](docs) | [How it works](docs/internals.md) in depth, and the [analytics](docs/analytics.md) schema |
