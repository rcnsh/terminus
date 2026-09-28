# termi**nus**

The next NUS shuttle to wherever you're going next. **https://terminus.rcn.sh**

terminus reads your NUSMods timetable and answers one question: which bus do I
catch, and will I make it? It knows teaching weeks and holidays, picks the stop
on the right side of the road, and says when walking is faster.

It's an independent student project, not affiliated with NUS.

| Path | What |
| --- | --- |
| [apps/api](apps/api) | Cloudflare Worker: the API, accounts (D1), the cron monitor, and the website. API docs at [/docs](https://terminus.rcn.sh/docs). |
| [apps/web](apps/web) | Landing page, account page, privacy and pairing pages. Static files served by the Worker. |
| [apps/android](apps/android) | Home-screen widgets (compact and with places) and a small app. |
| [apps/macos](apps/macos) | Menu bar app. |

## How it fits together

```
NUS shuttle feed ──(15 s cache per stop)──┐
NUSMods (timetables) ─────────────────────┤
MOM holidays, NUS calendar ───────────────┤
                                          ▼
                   Cloudflare Worker (apps/api)
                   ├─ /next, /trip, /arrivals   public answers
                   ├─ /me/*                     your plan, from your profile (D1)
                   ├─ /auth, /pair              email sign-in, device pairing
                   └─ cron                      feed monitor, cleanup
                          ▲            ▲             ▲
                   Android widget   Mac menu bar   Website
```

Every client shows the same `label` and `detail` strings from the API, plus a
`departsAt` clock time it counts down from itself, so no screen shows a stale
"4 min".

## Running it

```bash
npm install
npm test
node apps/api/scripts/dev-stub.mjs   # local API with fake buses
```

Self-hosting needs your own Cloudflare account (Workers, D1, KV, R2, Email
Sending) and the NUS feed configuration described in
[apps/api/README.md](apps/api/README.md). Releases are built and uploaded with
`scripts/release.sh`. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
