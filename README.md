# nusbus

The next NUS shuttle to wherever you're going next.

| Path | What |
| --- | --- |
| [apps/api](apps/api) | Cloudflare Worker at https://nusbus.rcn.sh. The docs are at `/`. |
| [apps/web](apps/web) | Account page at `/account`, served by the api Worker |
| [apps/android](apps/android) | Home-screen widget and a small app for pairing, saved places, search and nearby departures |
| apps/macos | Menu bar app (planned) |

```bash
npm install
```

```bash
npm test
```

```bash
npm run deploy
```

See [apps/api/README.md](apps/api/README.md) for how the API works.
