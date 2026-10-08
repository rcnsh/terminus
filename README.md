<a href="https://terminus.rcn.sh">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/readme/banner-dark.webp">
    <img alt="terminus. Know when to run. Your timetable in, one answer out: which shuttle, from which stop, and when to leave. Or when walking is faster." src=".github/readme/banner-light.webp" width="100%">
  </picture>
</a>

<p align="center">
  <a href="https://terminus.rcn.sh/download/android"><img alt="Get it for Android" src="https://img.shields.io/badge/Get_it_for-Android-fb923c?style=for-the-badge&logo=android&logoColor=white&labelColor=1c1917"></a>
  <a href="https://terminus.rcn.sh/download/mac"><img alt="Download for Mac" src="https://img.shields.io/badge/Download_for-Mac-fb923c?style=for-the-badge&logo=apple&logoColor=white&labelColor=1c1917"></a>
  <a href="https://terminus.rcn.sh/account"><img alt="Open on the web" src="https://img.shields.io/badge/Open_on_the-web-fb923c?style=for-the-badge&logo=googlechrome&logoColor=white&labelColor=1c1917"></a>
</p>

<p align="center">
  <sub>Free · Android 12+ · macOS 14+ on Apple silicon · <a href="https://terminus.rcn.sh">terminus.rcn.sh</a> · <a href="https://terminus.rcn.sh/docs">API docs</a></sub>
</p>

<br>

terminus reads your NUSMods timetable and answers one question: **which bus do I
catch, and will I make it?** It knows teaching weeks and holidays, picks the stop
on the right side of the road, and says when walking is faster. On your home
screen, in your menu bar and on the web.

## On your phone, your Mac and the web

The same answer on your phone, your Mac and the web, in light or dark.

<table>
  <tr>
    <td width="56%" valign="top">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="apps/web/public/assets/shots/widget-dark.webp">
        <img alt="The Android home-screen widget: leave by 9:39 AM for GEA1000, with the trip drawn as a line from you to PGP to UTown, and buttons for favourites." src="apps/web/public/assets/shots/widget-light.webp" width="100%">
      </picture>
      <h3>On your home screen</h3>
      A widget that keeps itself up to date, with your saved places one tap away, or a live notification, and a heads-up before you need to leave.
    </td>
    <td width="44%" valign="top">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="apps/web/public/assets/shots/mac-dark.webp">
        <img alt="The Mac menu bar app: leave by 9:41 for CS2030 at 10:00, catch the 9:45 D2 at PGP." src="apps/web/public/assets/shots/mac-light.webp" width="100%">
      </picture>
      <h3>In your menu bar</h3>
      When to leave, in the menu bar. Click it for the rest.
    </td>
  </tr>
  <tr>
    <td width="56%" valign="top">
      <h3>In the app, and on the web</h3>
      Now has the card for your next class, the trip drawn as a line, and the rest of today below it. The same in any browser, with your timetable and settings: add it to your home screen for the app, with notifications when it's time to leave.
    </td>
    <td width="44%" valign="top">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="apps/web/public/assets/shots/app-dark.webp">
        <img alt="Now in the Android app: leave in 12 minutes, by 9:39 AM, for GEA1000 @ UTown at 10:00 AM, walking 3 minutes to PGP for the R2 and arriving 9:52 AM, with today's classes below." src="apps/web/public/assets/shots/app-light.webp" width="100%">
      </picture>
    </td>
  </tr>
</table>

## What it knows

<table>
  <tr>
    <td width="33%" valign="top">
      <h3>Your timetable</h3>
      Import from NUSMods once a semester; the week before the next one starts, it reminds you. It knows teaching weeks, recess, exams and public holidays, and sends you home in long gaps.
    </td>
    <td width="33%" valign="top">
      <h3>The right time</h3>
      The latest bus that still gets you there, walks along campus paths at your pace, and a bus earlier when yours is usually busy.
    </td>
    <td width="33%" valign="top">
      <h3>The right stop</h3>
      The one going your way, even when the stop across the road is closer. Inside your hall, only the stops you can walk to.
    </td>
  </tr>
</table>

### And a map of campus

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="apps/web/public/assets/shots/map-dark.webp">
  <img alt="The campus map with D2 picked: its purple line, its stops and three buses on it, over a street map of NUS." src="apps/web/public/assets/shots/map-light.webp" width="100%">
</picture>

On Android, the web and the Mac (in a window of its own): every bus route in its colour, on a quiet street map. Tap a service to see its line and its buses moving live; tap a stop for what's coming, the services that call there, and a way to go there. It works offline after the first look.

## Set up in two minutes

**On Android:** install the app and tap **Get started**. It asks where you live, for your NUSMods timetable (paste the share link, or tap Share in NUSMods and pick terminus) and how fast you walk. No account or email needed; add an email later in Settings to keep your setup and use it on other devices.

**On the web or a Mac:**

1. **Sign in** at [terminus.rcn.sh/account](https://terminus.rcn.sh/account) with a code or link sent to your email. No password.
2. **Import** your NUSMods share link and pick your home stop.
3. **Install** the Mac menu bar app and sign in with the same email: approve it from the link we email you, on any device, by choosing the number the Mac shows. Or pair it with a code from the account page or the Android app's Settings.

It updates through the day and goes quiet in the evening. The app has four tabs: **Now** (the card and your places), **Buses** (what's coming at the stop nearest you and the ones you pin, and where a service's buses are along its line), **Map** and **Settings**.

<details>
<summary><b>Installing outside the app stores</b></summary>
<br>

- **Android:** open the downloaded file and allow your browser to install apps when asked. Play Protect may ask you to confirm, since it isn't from the Play Store.
- **Mac:** open the disk image and drag terminus to Applications.

</details>

## How it fits together

```
NUS shuttle feed ────────┐
LTA DataMall (optional) ─┤
NUSMods timetables ──────┤
NUS calendar, holidays ──┼──▶ Cloudflare Worker (apps/api)
OpenStreetMap paths ─────┤          │
Protomaps street map ────┘          │
                                    ├──▶ Android widget
                                    ├──▶ Mac menu bar
                                    └──▶ Website
```

The Worker does all the thinking, and caches the NUS feed for 15 seconds per stop. Every client shows the same ready-made card
from `/me/next` (when to leave, which bus, when you arrive) and only counts
down the clock itself, so no screen ever shows a stale "4 min".

| Path | What |
| --- | --- |
| [`apps/api`](apps/api) | Cloudflare Worker: the API, accounts (D1), the cron monitor, and the website. API docs at [/docs](https://terminus.rcn.sh/docs). |
| [`apps/web`](apps/web) | Landing page, account page, the web app (Now, Buses, the campus map, Settings), privacy and pairing pages. HTML and Preact components with no build step, served by the Worker. |
| [`apps/android`](apps/android) | Home-screen widgets (compact and with places) and the app: Now, Buses, the campus map, Settings. |
| [`apps/macos`](apps/macos) | Menu bar app, with the campus map in a window. |

## Running it

```bash
pnpm install
pnpm check                            # tests and typecheck
node apps/api/scripts/dev-stub.mjs    # local API with fake buses on :8787
```

Self-hosting needs your own Cloudflare account (Workers, D1, KV, R2, Durable
Objects, Analytics Engine, Workers rate limiting, Email Sending) and the NUS feed configuration described in
[apps/api/docs/internals.md](apps/api/docs/internals.md). Releases run on a
Mac with `scripts/release.sh`: the tests, the Android build as one APK per CPU
type, the signed Mac app and the appcast installed Macs update from, the
uploads, the tag and the GitHub release. The campus map's street map goes onto R2 with the
**map tiles** workflow (or `scripts/map-tiles.sh`). See [CONTRIBUTING.md](CONTRIBUTING.md).

<br>

<p align="center">
  <sub>An independent student project, not affiliated with NUS. Bus times come from NUS's shuttle feed.<br>
  Use terminus in line with the <a href="https://nus.edu.sg/registrar/docs/info/registration-guides/aup-form.pdf">NUS Acceptable Use Policy for IT Resources</a>.<br>
  Walking routes, bus route lines and the street map use map data © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, the street map through <a href="https://protomaps.com">Protomaps</a>. <a href="LICENSE">MIT licensed</a>.</sub>
</p>
