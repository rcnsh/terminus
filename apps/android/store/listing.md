# Google Play listing

What goes into Play Console. The images are in this folder. Redraw the icon
and feature graphic with `swift apps/android/store/render.swift apps/android/store`.
The phone screenshots are in `screenshots/`: 1080×1920, taken on the emulator
against `apps/api/scripts/dev-stub.mjs` (fake buses and a test account, no real data).

## App name (30 characters max)

NUS is left out of the name, so it doesn't look like an official NUS app. The descriptions say it's for NUS and that it isn't affiliated.

```
terminus: campus bus planner
```

## Short description (80 characters max)

```
When to leave for class, and which campus bus to catch, from your timetable.
```

## Full description (4000 characters max)

```
terminus tells you when to leave for your next class, and which campus bus to catch to get there on time.

Import your NUSMods timetable once. From then on, terminus works out the whole trip: the walk to the stop, the live arrival of the bus, the ride, and the walk to your classroom. Instead of a list of arrival times, you get one answer: "Leave by 9:38 · catch the 9:41 D2 at PGP · arrive 9:52, 3 min early".

ONE ANSWER, ON YOUR HOME SCREEN
• The widget shows when to leave for your next class, with one-tap buttons for the places you go most.
• A heads-up five minutes before you need to set off.
• Late? It says so, and offers the quickest way there.
• If the bus you'd wait for is often packed at that stop and time, it aims one bus earlier.

IT FOLLOWS YOUR TRIP
• When your bus leaves, the notification asks "On the 9:41 D2?". Tap On it, Missed it or Not going, or ignore it: no answer counts as on it.
• On it: your arrival comes from that bus's live position.
• Missed it: the next way there, straight away.
• Not going: that class is dropped for today, on every device.

IT LEARNS, AND ASKS FIRST
• Keep missing the bus to one class? It offers to leave one bus earlier for it.
• Skipping a class every week? It offers to stop reminders for it.
Nothing changes unless you say yes, and every choice can be undone.

ALSO
• Nearby: every bus at the stops around you, live.
• Search any building, stop or room on campus.
• Today: your classes, when to leave for each, and the trip home.
• Works with the terminus menu bar app for Mac and the website: sign in with your email and they all show the same trip.

PRIVATE BY DESIGN
• No sign-up: the app makes an account of its own. Adding an email is optional, and only needed to use terminus on another device.
• Your location is only used while the app is open, to find the nearest stop, and is never stored.
• No ads, no tracking, no analytics SDK.
• Delete your account and everything with it from Settings, or clear just your trip history. With an email added, export it all from the account page.

terminus is an independent app. It is not made by, endorsed by or affiliated with the National University of Singapore. Bus times come from NUS's public shuttle feed.
```

## Category and contact

- Category: Maps & Navigation. Tags: public transport, commute.
- Email: the developer address on the Play account.
- Website: https://terminus.rcn.sh
- Privacy policy: https://terminus.rcn.sh/privacy

## Content and policy answers

- **Ads:** no.
- **App access:** everything works without special access. Reviewer note:
  "No sign-in needed: a fresh install makes its own account. Setup asks where you live and for a NUSMods timetable link; any public NUSMods share link works, or tap "I'll do this later" (or "Skip setup"). Bus times are live for NUS campus shuttles in Singapore time. Location is optional. 'Add an email' is optional and unlocks nothing extra on the phone."
- **Advertising ID:** no. The app doesn't declare `AD_ID`.
- **Target audience:** 18 and over (university students). Not designed for children.
- **Foreground service (special use):** "Shows the user's next campus bus and a countdown in an ongoing notification during a trip the user started, only while the user has turned it on. None of the typed foreground service types fit a transit countdown, and it runs only from time to leave until arrival."
- **Exact alarms:** `SCHEDULE_EXACT_ALARM` needs no declaration. The user allows it under "Alarms & reminders".
- **Location:** foreground only (`ACCESS_FINE_LOCATION` and `ACCESS_COARSE_LOCATION`). There is no background location, so no declaration is needed.
- **Data safety:** see `PLAN.md` phase 4 and the answers already given in Play Console.
  - Location is precise, collected only while in use, ephemeral, and optional.
  - Email is optional. User IDs, app interactions and user-generated content are required.
  - Device IDs are the push token.
  - Nothing is shared. Data is encrypted in transit, and deletion is available.
