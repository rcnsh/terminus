# terminus

terminus tells an NUS student which shuttle bus to catch, from which stop,
and when to leave, or that walking is faster. These are the words for that
world, shared by the server, the four clients, the copy and the docs. The
Chinese for each user-facing word is in the glossary at the top of
`apps/api/src/i18n.ts`.

## The network

**Shuttle**:
NUS's free campus bus.
_Avoid_: internal shuttle bus, ISB, free bus

**Public bus**:
A paid Singapore bus (95, 151, …) that calls at campus stops; only considered when the user turns public buses on.
_Avoid_: LTA bus, SBS bus

**Fare**:
What a public bus costs; a public bus is only worth suggesting when it beats the shuttle by enough to pay it.

**Stop**:
A place where buses call, known by its code (COM3, UHALL-OPP).
_Avoid_: station, bus stop code, pickup point

**Opposite stop**:
The stop across the road from another, served by the same services in the other direction.
_Avoid_: twin, pair, Opp stop

**Partner stop**:
A nearby stop that does the job of an opposite stop where there isn't one across the road (PGP and PGPR).
_Avoid_: twin, nearby pair

**Shelter**:
One physical stop served by both shuttles and public buses, known by its shuttle code.

**Service**:
A named bus line that runs a fixed sequence of stops: A1, D2, K, or a public 151.
_Avoid_: route (for the line itself), line, bus number

**Route**:
The ordered stops a service calls at; a two-way public service has one route per direction.
_Avoid_: path, sequence

**Route line**:
The road a service's route follows, as drawn on the map.
_Avoid_: shape, polyline, line

**Terminal**:
The stop where a service's run begins or ends (Kent Ridge Bus Terminal, COM3).
_Avoid_: terminus, end stop

**Loop**:
A service whose route ends where it starts.

**Run**:
One bus's trip along a service's route from terminal to terminal.
_Avoid_: lap, pass

**Hop**:
One step from a stop to the next along a route; the unit of riding time.

**Stretch**:
The piece of a route between two consecutive stops.
_Avoid_: section, segment

**Headway**:
The usual gap between buses of a service.
_Avoid_: frequency, interval

**Operating hours**:
When a service runs on a given kind of day (weekday, Saturday, Sunday).
_Avoid_: service hours, window, opening

**Holiday hours**:
The Sunday hours that services keep on a public holiday or an NUS day off.

## Buses and times

**Feed**:
A live source of bus times and positions: NUS's for shuttles, LTA DataMall's for public buses.
_Avoid_: FMS, proxy, upstream

**Bus**:
One vehicle the feed reports, known to users by its plate.

**Track**:
Where along its route a bus was last placed; a new position only counts if the bus could have driven there since.
_Avoid_: trail, history

**Fix**:
One position reading for a bus from the feed.
_Avoid_: ping, reading

**Departure**:
When a bus leaves the stop you'd catch it from.
_Avoid_: arrival, ETA, board time

**Arrival**:
When you reach your destination.
_Avoid_: reach time (and never for a bus reaching your stop: that's a departure)

**Leave-by**:
The latest time to set off on foot to catch the chosen bus; once it passes the card says "Leave now".
_Avoid_: leave time, departure

**Quality**:
How a time was found, from most to least sure: live, stale, estimate, no live data; or ended.
_Avoid_: confidence (that's how sure the stop choice is), accuracy

**Live**:
A time for a real bus the feed reported just now.

**Stale**:
A live time from a feed answer that has aged a few minutes.
_Avoid_: old, cached

**Estimate**:
A time not taken from any bus in the feed: a shuttle time guessed from the headway, shown with "~".
_Avoid_: scheduled, timetable estimate, guess

**Timetabled**:
A public bus time from LTA's timetable rather than a tracked bus; as sure as an estimate, never live.
_Avoid_: scheduled, unmonitored

**No live data**:
The feed couldn't be reached at all, so no time is shown.
_Avoid_: unknown, offline

**Ended**:
No bus is left to catch: the services have stopped for the day.

**Crowding**:
How full a bus is: Seats, Busy or Packed.
_Avoid_: load, capacity, crowd level, full

## Answers

**Answer**:
The server's worked-out reply to "which bus, from where, when?" for one destination.
_Avoid_: result, response, tile

**Card**:
An answer worded once for every client to show as is; clients only count down its clock.
_Avoid_: tile, widget content

**Option**:
One way to make the trip: a stop, a service and its departure, or walking.
_Avoid_: candidate, choice, alternative

**Change**:
Getting off one bus and onto another to complete a trip; a trip has at most one.
_Avoid_: transfer, connection, interchange

**Journey**:
The card's step-by-step view of a trip: walk, bus, change, arrive.
_Avoid_: itinerary, route, steps

**Heading**:
The line above the card saying what it's about ("Next class · COM3", "Long gap · Home").
_Avoid_: title, kicker

**Glance**:
The few characters of the card shown where space is tiny: the menu bar, a widget, a notification.
_Avoid_: summary, short label

**Walk**:
Going the whole way on foot; recommended only when it clearly beats the bus.

**Board**:
A stop's list of upcoming departures, one row per service.
_Avoid_: departures, arrivals board, timetable

**Catch**:
To get on a bus.
_Avoid_: board (the verb), take

**Nearby**:
The boards of the stops closest to where you are.
_Avoid_: around me, near you

**Pinned stop**:
A stop whose board the user keeps at the top of Buses.
_Avoid_: saved stop, favourite stop

## Your day

**Timetable**:
A user's weekly classes, imported from NUSMods or typed in.
_Avoid_: schedule, NUSMods import

**Class**:
Any weekly timetable entry, a lesson or anything else typed in (Gym, Tuesdays 18:00); terminus gets you there by its start.
_Avoid_: lesson, module, trip, usual time

**Favourite**:
A saved destination for one-tap trips, with no time attached.
_Avoid_: saved place, place, bookmark

**Home stop**:
One of up to three stops the user boards at near where they live.
_Avoid_: home, home address

**Destination**:
Anywhere a trip can go: a stop, a building, a room, a landmark or a residence.
_Avoid_: target, place, to

**Building**:
A campus building with its own stops and the paths out of it.
_Avoid_: venue

**Room**:
A teaching room inside a building, as NUSMods names it (AS1-0201).
_Avoid_: venue, location

**Landmark**:
A named place on campus that isn't a building or room, such as a food court.

**Residence**:
A hall, residential college or hostel.
_Avoid_: hostel, dorm

**Day**:
The hours a user is about, from day start to day end; outside them terminus is at rest.

**Long gap**:
A gap between two classes long enough that the user is sent home in between.
_Avoid_: break, gap-home

**Free day**:
A day with no classes left to get to.
_Avoid_: rest day, day off

**Rest**:
The time outside a user's day, when the card doesn't plan a trip.
_Avoid_: free, idle

**Trip**:
One journey today to a class, a favourite or home, followed from planning to arrival.
_Avoid_: journey (that's the card's steps), class, ride

**Plan**:
The bus a trip is about, the same on every device, settled by the leave-by.
_Avoid_: booking, choice, boarded

**Next trip**:
The trip the planner picks for right now from the day: the next class, a long gap, or home.
_Avoid_: plan, next, destination choice

**Rider**:
Whom the planner plans for: their profile, today's trip signals and what their trips suggest (`Rider` in next.ts).
_Avoid_: user, session, context

**Ask**:
What a request wants of the planner: where it is, a favourite or stop instead of the day's trip, and its clock (`Ask` in next.ts).
_Avoid_: query, request, params

**Phase**:
Where a trip stands: due, heading, waiting, riding, missed or arrived; idle before any of them.
_Avoid_: state, stage, status

**Due**:
The phase just before the leave-by: "Time to get going".

**Heading** (phase):
On the way to the stop: "On your way". Not to be confused with the card's heading line.

**Waiting**:
At the plan's stop before its bus comes: "At the stop".

**Riding**:
On the plan's bus: "On the bus".
_Avoid_: boarded, on board

**Missed**:
The plan's bus left without the user on it.

**Gone**:
The plan's bus has left and nothing says whether the user caught it.

**Step**:
Moving a trip to the bus before or after the one shown ("Earlier bus", "Later bus"); "Best bus" goes back to the server's own.
_Avoid_: skip (that's Not going), shift, snooze

**Not going**:
The user's choice to skip one trip today.
_Avoid_: skip, cancel, not going today

**Not on campus**:
The user's choice to skip every trip left today; undone with "Back on campus".
_Avoid_: away, skip day

**Outcome**:
How a trip went, kept a few weeks: caught, missed, not going or arrived.
_Avoid_: result, history entry

**Suggestion**:
An offer the server makes from past outcomes, such as "Leave one bus earlier" or turning reminders off for a class.
_Avoid_: tip, recommendation

**Leave reminder**:
The notification that it's time to set off.
_Avoid_: leave alert, heads-up

## Calendar

**Semester**:
One of NUS's academic periods: Semester 1, Semester 2 and the two Special Terms.
_Avoid_: term

**Teaching week**:
A week of classes in a semester.
_Avoid_: instructional week

**Recess week**, **Reading week**, **Exams**, **Vacation**:
The other kinds of week in the academic calendar.

**Day off**:
A public holiday or an NUS-only day off such as a Well-Being Day; services keep holiday hours.
_Avoid_: holiday (alone), PH

## Accounts

**Account**:
Everything terminus keeps for one person: their profile, devices and trip history.
_Avoid_: user (in copy), person

**Anonymous account**:
An account with no email, made when an app first opens or a browser chooses to go without one.
_Avoid_: guest, anon user

**Profile**:
An account's saved choices: timetable, favourites, home stops, walking pace and the like.
_Avoid_: settings (that's the screen), setup (that's the first run), preferences

**Setup**:
The first-run steps that fill in a new profile.
_Avoid_: onboarding

**Device**:
An app signed in to an account.
_Avoid_: client, install, phone

**Sign-in code**:
The short code in a sign-in email, typed to sign in.
_Avoid_: OTP, verification code, magic code

**Sign-in link**:
The link in a sign-in email that signs in by being opened.
_Avoid_: magic link

**App sign-in**:
An app's sign-in that the user approves from the email by typing the number the app shows.
_Avoid_: device login, login request

**Pairing**:
Adding a device to an account from one already signed in, with a pairing code.
_Avoid_: linking, pair (for stops)

**Pairing code**:
The short-lived code a signed-in device shows to let another join.
_Avoid_: sign-in code

**API key**:
A long-lived key an account makes to call the API from its own scripts.
_Avoid_: token, secret

## Operating terminus

**Operator**:
The person running terminus.
_Avoid_: admin, owner

**Timelapse**:
A recording of every shuttle's positions over one service day, replayed on the map.

**Feedback report**:
A user's "This was wrong" report about an answer, sent to the operator.
_Avoid_: bug report, complaint

**Crash report**:
An app's report of its own failure, kept with no account on it.
_Avoid_: error report
