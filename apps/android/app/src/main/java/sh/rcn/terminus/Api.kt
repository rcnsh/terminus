package sh.rcn.terminus

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.asExecutor
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import androidx.core.content.edit
import androidx.core.net.toUri
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

data class Place(val key: String, val label: String)

/** `/me/next`. label and detail are display-ready; show them verbatim. */
data class NextAnswer(
    val label: String,
    val detail: String,
    val alt: String?,
    val stopName: String,
    val quality: String,
    val asOf: String,
    val mode: String,
    val destLabel: String?,
    val why: String?,
    val places: List<Place>,
    /** When the bus leaves, epoch ms. Clients count down from this. */
    val departsAtMs: Long?,
    /** For a class: "on-time" | "tight" | "late", and its display text. */
    val timingStatus: String?,
    val timingText: String?,
    /** Planned answers: when the plan changes by itself (a class starts, the day ends). */
    val refreshAtMs: Long? = null,
    /** Already at the destination: no bus, no countdown. */
    val arrived: Boolean = false,
    /** The latest time to set off, epoch ms; for a class, the latest that's still on time. */
    val leaveAtMs: Long? = null,
    /** Rests on a headway, not a live time: shown with a "~". */
    val leaveEstimated: Boolean = false,
    /** Why leave-by is earlier than it could be ("D2 is often busy…"). Shown verbatim. */
    val leaveNote: String? = null,
    /** For a class, when it starts, epoch ms. */
    val classAtMs: Long? = null,
    /** Display-ready text from the server; null only in an answer cached before 1.3.6. */
    val card: Card? = null,
    /** The user's walking speed (m/s, from their pace), for walk times the app works out itself. */
    val walkSpeedMs: Double? = null,
) {
    /** The server's card (card.ts): every line below is worded there, once. */
    val isClassPlan: Boolean get() = card?.kind == "class"

    /** No classes today (or none left): nothing to catch, said plainly. */
    val isFree: Boolean get() = mode == "free"

    /** The trip's phase, when one is in progress ("On your way"). */
    val phaseText: String? get() = card?.phaseText

    /** "Leave by ~09:38", or "Leave now" once it has passed: the only part that ticks.
     *  At the stop it's the bus to wait for ("D2 at 09:41"), as the server says it. */
    fun leaveHeadline(now: Long): String? {
        val at = leaveAtMs ?: return null
        if (card?.phase == "waiting") return card.leaveBy
        return if (now >= at) L.s(R.string.leave_now) else card?.leaveBy
    }

    /** Class: "Catch the ~09:41 D2 at PGP", or "Walk there". */
    val catchHow: String? get() = card?.catch
    /** Class: "Arrive ~09:55 · 3 min early". */
    val catchArrive: String? get() = card?.arrive
    /** Class: both on one line, for the widget and notifications. */
    val catchLine: String? get() = card?.catchLine
    /** Whether the leave-by trip misses the class start. */
    val leaveLate: Boolean get() = card?.late ?: false
    /** The headline bus, when it's not the one to wait for. */
    val goNowLine: String? get() = card?.goNow
    /** "Crowding: low" / "Crowding: medium" / "Crowding: high". */
    val crowdText: String? get() = card?.crowd?.takeUnless { detail.contains(it, ignoreCase = true) }
    /** "Timetable estimate", "Live times are a few minutes old", "No live data". */
    val qualityText: String? get() = card?.quality

    /** Other trips: "Leave by 09:38 · catch the 09:41 D2 at PGP". */
    fun leaveText(now: Long): String? {
        val head = leaveHeadline(now) ?: return null
        return card?.leaveVia?.let { "$head · $it" } ?: head
    }

    /** The headline, as the server words it (card.title): "D2 · 09:42", "A1 · ~09:11", or the label. */
    val title: String get() = card?.title ?: label

    /** [title], or for an older server without it, "D2 · 09:42" from the label and departure time;
     *  anything but a live time gets a "~". */
    fun clockLabel(format: (Long) -> String): String {
        card?.title?.let { return it }
        val at = departsAtMs ?: return label
        if (quality == "unknown" || quality == "ended") return label
        return "${label.substringBefore(" · ")} · ${if (quality != "live") L.s(R.string.approx, format(at)) else format(at)}"
    }

    companion object {
        fun parse(o: JSONObject): NextAnswer = parsing { parseOrThrow(o) }

        private fun parseOrThrow(o: JSONObject): NextAnswer {
            val dest = o.optJSONObject("dest")
            val places = o.optJSONArray("places") ?: JSONArray()
            return NextAnswer(
                label = o.getString("label"),
                detail = o.optStringOrNull("detail").orEmpty(),
                alt = o.optStringOrNull("alt"),
                stopName = o.optJSONObject("stop")?.optStringOrNull("name").orEmpty(),
                quality = o.optString("quality", "unknown"),
                asOf = o.optStringOrNull("asOf").orEmpty(),
                mode = o.optString("mode", "trip"),
                destLabel = dest?.optStringOrNull("label"),
                why = dest?.optStringOrNull("why"),
                places = (0 until places.length()).mapNotNull {
                    val p = places.optJSONObject(it) ?: return@mapNotNull null
                    Place(p.optStringOrNull("key") ?: return@mapNotNull null, p.optStringOrNull("label") ?: return@mapNotNull null)
                },
                departsAtMs = o.optStringOrNull("departsAt")?.let(::parseInstant),
                refreshAtMs = o.optStringOrNull("refreshAt")?.let(::parseInstant),
                arrived = o.optBoolean("arrived", false),
                leaveAtMs = o.optJSONObject("leave")?.optStringOrNull("at")?.let(::parseInstant),
                leaveEstimated = o.optJSONObject("leave")?.optBoolean("estimated", false) ?: false,
                leaveNote = o.optJSONObject("leave")?.optStringOrNull("note"),
                classAtMs = o.optJSONObject("timing")?.optStringOrNull("classAt")?.let(::parseInstant),
                timingStatus = o.optJSONObject("timing")?.optStringOrNull("status"),
                timingText = o.optJSONObject("timing")?.optStringOrNull("text"),
                card = o.optJSONObject("card")?.let { lenient { Card.parse(it) } },
                walkSpeedMs = o.optDouble("walkSpeedMs").takeIf { it.isFinite() && it > 0 },
            )
        }
    }
}

/** `card` in /me/next (apps/api/src/card.ts). Lines are shown verbatim. */
data class Card(
    val kind: String,
    /** Dim from this instant, epoch ms. */
    val staleAtMs: Long?,
    val crowd: String?,
    val quality: String?,
    val leaveBy: String?,
    val leaveVia: String?,
    val catch: String?,
    val arrive: String?,
    val catchLine: String?,
    val late: Boolean,
    val goNow: String?,
    val note: String?,
    val estimate: String?,
    /** v2: where the trip is: idle, due, heading, waiting, riding, missed, arrived. */
    val phase: String = "idle",
    /** "On your way", above the answer. Null when idle. */
    val phaseText: String? = null,
    /** 12 characters: a tile or a glance. */
    val glance: String? = null,
    /** One line: a collapsed notification, a compact widget. */
    val line: String? = null,
    /** Buttons the server decided to show; tapping one sends it to /me/signal. */
    val actions: List<CardAction> = emptyList(),
    /** "Last D2 from UTown in 18 min". */
    val warning: String? = null,
    /** When this card changes by itself: refresh then. */
    val nextChangeAtMs: Long? = null,
    /** False when the user turned reminders off for this class: no leave notification. */
    val remind: Boolean = true,
    /** "Leave one bus earlier for CS2030?", accepted or turned down with /me/choice. */
    val suggestion: Suggestion? = null,
    /** On the bus: the stops from boarding to getting off, for a progress bar. */
    val ride: Ride? = null,
    /** The planned bus has left and nothing says whether you're on it: [line]
     *  says so and gives the next way there. Notified with that, never "Leave now". */
    val gone: Boolean = false,
    /** Where to walk to now (the bus's stop, or the destination on foot), for walking directions. */
    val walkTo: WalkTo? = null,
    /** "NUS's live bus times have been down since 9:14 AM", above the answer. */
    val notice: String? = null,
    /** The trip as steps, for the card styles that draw it. */
    val journey: Journey? = null,
    /** Done for today, no classes, home: the next class, for its own card. */
    val upcoming: Upcoming? = null,
    /** The headline: "R2 · 09:06", "A1 · ~09:11", "On the R2"; the label when there's no time. */
    val title: String? = null,
    /** Above the headline: "Next class · GEA1000 @ UTown", "Heading home"; null with no destination. */
    val heading: String? = null,
    /** When to send the leave reminder, epoch ms; null: no reminder for this trip. */
    val remindAtMs: Long? = null,
) {
    companion object {
        fun parse(o: JSONObject) = Card(
            kind = o.optString("kind", "trip"),
            staleAtMs = o.optStringOrNull("staleAt")?.let(::parseInstant),
            crowd = o.optStringOrNull("crowd"),
            quality = o.optStringOrNull("quality"),
            leaveBy = o.optStringOrNull("leaveBy"),
            leaveVia = o.optStringOrNull("leaveVia"),
            catch = o.optStringOrNull("catch"),
            arrive = o.optStringOrNull("arrive"),
            catchLine = o.optStringOrNull("catchLine"),
            late = o.optBoolean("late", false),
            goNow = o.optStringOrNull("goNow"),
            note = o.optStringOrNull("note"),
            estimate = o.optStringOrNull("estimate"),
            phase = o.optString("phase", "idle"),
            phaseText = o.optStringOrNull("phaseText"),
            glance = o.optStringOrNull("glance"),
            line = o.optStringOrNull("line"),
            actions = o.optJSONArray("actions")?.let { a ->
                (0 until a.length()).mapNotNull { i -> a.optJSONObject(i)?.let { lenient { CardAction.parse(it) } } }
            }.orEmpty(),
            warning = o.optStringOrNull("warning"),
            notice = o.optStringOrNull("notice"),
            nextChangeAtMs = o.optStringOrNull("nextChangeAt")?.let(::parseInstant),
            remind = o.optBoolean("remind", true),
            suggestion = o.optJSONObject("suggestion")?.let { lenient { Suggestion.parse(it) } },
            ride = o.optJSONObject("ride")?.let { lenient { Ride.parse(it) } },
            gone = o.optBoolean("gone", false),
            walkTo = o.optJSONObject("walkTo")?.let { lenient { WalkTo.parse(it) } },
            journey = o.optJSONObject("journey")?.let { lenient { Journey.parse(it) } },
            upcoming = o.optJSONObject("upcoming")?.let { lenient { Upcoming.parse(it) } },
            title = o.optStringOrNull("title"),
            heading = o.optStringOrNull("heading"),
            remindAtMs = o.optStringOrNull("remindAt")?.let(::parseInstant),
        )
    }
}

/**
 * One part of the card, read on its own: a malformed one (a field missing or
 * the wrong type) is left out, and the rest of the answer still shows.
 */
private inline fun <T> lenient(parse: () -> T?): T? = try {
    parse()
} catch (_: org.json.JSONException) {
    null
}

/**
 * A reply read whole: one that isn't the shape this version reads (a field
 * missing or the wrong type) is a [ParseError], "unexpected response", and
 * not taken for the network failing ("Offline").
 */
internal inline fun <T> parsing(read: () -> T): T = try {
    read()
} catch (e: org.json.JSONException) {
    throw ParseError(e.message ?: "unexpected answer")
}

/**
 * `card.upcoming`: the next class, worded on the server, from the timetable
 * alone: when ("Tomorrow · Tue"), what ("CS2030 at 10:00"), where ("At COM1
 * · get off at COM 3"), and why today has none when it's a break.
 */
data class Upcoming(val whenText: String, val title: String, val where: String, val off: String?) {
    companion object {
        fun parse(o: JSONObject): Upcoming? = Upcoming(
            o.optStringOrNull("when").orEmpty(),
            o.optStringOrNull("title") ?: return null,
            o.optStringOrNull("where").orEmpty(),
            o.optStringOrNull("off"),
        )
    }
}

/**
 * The ride, from boarding to getting off. Where the bus is comes from the
 * clock: stops are taken as evenly spaced between the board and arrival times
 * (the arrival is live when the server knows the bus's plate).
 */
data class Ride(
    val svc: String,
    val stops: List<String>,
    val boardMs: Long,
    val arriveMs: Long,
    /** The bus you change to where this one drops you; [stops] is this bus's alone. */
    val change: RideChange? = null,
) {
    /** 0 to 1 along the ride. */
    fun progress(now: Long): Float = ((now - boardMs).toFloat() / (arriveMs - boardMs)).coerceIn(0f, 1f)

    /** How many stops have been passed; the last is where you get off. */
    fun passed(now: Long): Int = (progress(now) * (stops.size - 1)).toInt()

    /** The stop the bus is heading for next, or null once it's there. */
    fun nextStop(now: Long): String? = stops.getOrNull(passed(now) + 1)

    /** Stops left before getting off, the next one included. */
    fun stopsLeft(now: Long): Int = (stops.size - 1 - passed(now)).coerceAtLeast(0)

    companion object {
        /** Null without its times, or with fewer than two stops: there's no bar to draw. */
        fun parse(o: JSONObject): Ride? {
            val svc = o.optStringOrNull("svc") ?: return null
            val stops = o.optJSONArray("stops") ?: return null
            val names = (0 until stops.length()).map { stops.optJSONObject(it)?.optStringOrNull("name") ?: return null }
            val board = o.optStringOrNull("board")?.let(::parseInstant) ?: return null
            val arrive = o.optStringOrNull("arrive")?.let(::parseInstant) ?: return null
            val change = o.optJSONObject("change")?.let { lenient { RideChange.parse(it) } }
            return Ride(svc, names, board, arrive, change).takeIf { names.size >= 2 && arrive > board }
        }
    }

    /**
     * "Next: Opp NUSS · 3 stops to go", the same in the notification and the
     * widget. Nearing the stop to change at, the second bus too ("· Then P
     * at 09:42 from Kent Vale"); before that the line has no room for it.
     * Without [withChange] for a screen that shows the change on a line of its own.
     */
    fun nextText(now: Long, withChange: Boolean = true): String {
        val next = nextStop(now)
        val left = stopsLeft(now)
        val text = when {
            next == null || left == 0 -> L.s(R.string.getting_off_at, stops.last())
            left == 1 -> L.s(R.string.next_where_off, stops.last())
            else -> L.s(R.string.next_stops_to_go, next, left)
        }
        return if (withChange && change != null && left <= 1) "$text · ${change.text}" else text
    }
}

/** `ride.change`: the second bus of a trip that changes, worded on the server ("Then P from Kent Vale at 9:42"). */
data class RideChange(val svc: String, val color: Long, val stop: String, val board: String?, val text: String) {
    companion object {
        fun parse(o: JSONObject): RideChange? = RideChange(
            svc = o.optStringOrNull("svc") ?: return null,
            color = parseColor(o.optStringOrNull("color")),
            stop = o.optStringOrNull("stop").orEmpty(),
            board = o.optStringOrNull("board"),
            text = o.optStringOrNull("text") ?: return null,
        )
    }
}

/**
 * `card.journey`: the trip as steps (walk to the stop, take the bus, get
 * there), worded on the server; on foot the whole way, the walk alone, with
 * no [bus]. The app draws it in the card style chosen in Settings ›
 * Appearance ([CardStyle]); only the countdowns tick here.
 */
data class Journey(
    /** When to set off ("4:01 PM"); null when it's now. */
    val leave: String?,
    /** The walk to the stop ("3 min"); null at the stop. On foot, the whole walk there. */
    val walk: String?,
    /** The bus to catch; null on foot. */
    val bus: JourneyBus?,
    /** When the bus leaves, epoch ms, to count down to; null on foot. */
    val boardAtMs: Long?,
    /** Time on the bus ("8 min"); null on foot. */
    val ride: String?,
    /** Where to get off, when it's across the road from the destination. */
    val off: String?,
    /** Where you're going ("GEA1000 @ UTown") and the stop you get off at ("UTown"). */
    val to: String,
    val toStop: String,
    /** When you get there: to the room or building itself when there's a `walkEnd`. */
    val arrive: String?,
    /** The walk from `toStop` on to where you're going ("2 min"): a class's room, a building searched for. */
    val walkEnd: String? = null,
    /** When the bus gets to `toStop`; `arrive` when there's no `walkEnd`. */
    val arriveStop: String? = arrive,
    /** A class: "3 min early". */
    val slack: String?,
    val live: Boolean,
    val backup: JourneyBus?,
    /** On foot: why not a bus ("D1 would be 16 min"). */
    val why: String? = null,
    /** The server's words for the card, each null from an older server (JourneyText words them then). */
    val text: JourneyWords = JourneyWords(),
    /** A change of bus on the way: [bus] is the first, this the second. */
    val change: JourneyChange? = null,
) {
    /** Where you're going, short enough for the end of a line: "GEA1000", not "GEA1000 @ UTown". */
    val place: String get() = text.place ?: to.substringBefore(" @ ")

    companion object {
        fun parse(o: JSONObject): Journey? {
            val bus = o.optJSONObject("bus")?.let(JourneyBus::parse)
            // A bus that can't be read isn't a walk: no journey rather than the wrong one.
            if (bus == null && !o.isNull("bus")) return null
            val board = o.optStringOrNull("boardAt")?.let(::parseInstant)
            // A bus needs its time to count down to; on foot there's neither.
            if (bus != null && board == null) return null
            if (bus == null && o.optStringOrNull("walk") == null) return null
            return Journey(
                leave = o.optStringOrNull("leave"),
                walk = o.optStringOrNull("walk"),
                bus = bus,
                boardAtMs = board?.takeIf { bus != null },
                ride = o.optStringOrNull("ride")?.takeIf { bus != null },
                off = o.optStringOrNull("off"),
                to = o.optStringOrNull("to").orEmpty(),
                toStop = o.optStringOrNull("toStop").orEmpty(),
                arrive = o.optStringOrNull("arrive"),
                walkEnd = o.optStringOrNull("walkEnd"),
                arriveStop = o.optStringOrNull("arriveStop") ?: o.optStringOrNull("arrive"),
                slack = o.optStringOrNull("slack"),
                live = o.optBoolean("live", false),
                backup = o.optJSONObject("backup")?.let(JourneyBus::parse),
                why = o.optStringOrNull("why"),
                text = JourneyWords(
                    title = o.optStringOrNull("title"),
                    place = o.optStringOrNull("place"),
                    by = o.optStringOrNull("byText"),
                    walk = o.optStringOrNull("walkText"),
                    ride = o.optStringOrNull("rideText"),
                    walkEnd = o.optStringOrNull("walkEndText"),
                    arrive = o.optStringOrNull("arriveText"),
                    arriveWhere = o.optStringOrNull("arriveWhere"),
                    backup = o.optStringOrNull("backupText"),
                    summary = o.optStringOrNull("summary"),
                ),
                // A change that can't be read leaves the first bus, whose words name the change.
                change = o.optJSONObject("change")?.takeIf { bus != null }?.let { lenient { JourneyChange.parse(it) } },
            )
        }
    }
}

/**
 * `card.journey`'s words: "To GEA1000 @ UTown · starts 10:00", "by ~09:36",
 * "5 min walk", "10 min ride · off at Opp NUSS", "Arrive ~09:51 · 9 min
 * early", "at UTown", "Or go now: R2 at 09:06 from PGP", and [summary], the
 * trip in one line for a widget.
 */
data class JourneyWords(
    val title: String? = null,
    val place: String? = null,
    val by: String? = null,
    val walk: String? = null,
    val ride: String? = null,
    val walkEnd: String? = null,
    val arrive: String? = null,
    val arriveWhere: String? = null,
    val backup: String? = null,
    val summary: String? = null,
)

/**
 * `journey.change`: where the first bus drops you ([from]) and the second
 * goes from ([stop], across the road when [walk] is set), the wait, the
 * second bus and the rides on each, worded on the server.
 */
data class JourneyChange(
    val from: String,
    val stop: String,
    /** When the first bus gets to [from]. */
    val reach: String,
    val walk: String?,
    val wait: String?,
    val bus: JourneyBus,
    val boardAtMs: Long,
    /** Time on the second bus, and on the first ("6 min", "8 min"). */
    val ride: String,
    val firstRide: String,
    /** "8 min ride · off at Kent Vale", "Change at Kent Vale · 3 min wait", "6 min ride". */
    val firstRideText: String,
    val changeText: String,
    val rideText: String,
) {
    companion object {
        fun parse(o: JSONObject): JourneyChange? = JourneyChange(
            from = o.optStringOrNull("from") ?: return null,
            stop = o.optStringOrNull("stop") ?: return null,
            reach = o.optStringOrNull("reach").orEmpty(),
            walk = o.optStringOrNull("walk"),
            wait = o.optStringOrNull("wait"),
            bus = o.optJSONObject("bus")?.let(JourneyBus::parse) ?: return null,
            boardAtMs = o.optStringOrNull("boardAt")?.let(::parseInstant) ?: return null,
            ride = o.optStringOrNull("ride").orEmpty(),
            firstRide = o.optStringOrNull("firstRide").orEmpty(),
            firstRideText = o.optStringOrNull("firstRideText").orEmpty(),
            changeText = o.optStringOrNull("changeText") ?: return null,
            rideText = o.optStringOrNull("rideText").orEmpty(),
        )
    }
}

/** A bus in the journey: its service, colour (as painted on the bus, ARGB), stop and time. */
/** `paid`: a public bus, with a fare, unlike the free shuttle. */
data class JourneyBus(val svc: String, val color: Long, val stop: String, val board: String, val paid: Boolean = false) {
    companion object {
        fun parse(o: JSONObject): JourneyBus? {
            val svc = o.optStringOrNull("svc") ?: return null
            return JourneyBus(svc, parseColor(o.optStringOrNull("color")), o.optStringOrNull("stop").orEmpty(), o.optStringOrNull("board").orEmpty(), o.optBoolean("paid", false))
        }
    }
}

/** A stop to walk to, and where it is. */
data class WalkTo(val name: String, val lat: Double, val lon: Double) {
    companion object {
        fun parse(o: JSONObject): WalkTo? {
            val lat = o.optDouble("lat").takeIf { it.isFinite() } ?: return null
            val lon = o.optDouble("lon").takeIf { it.isFinite() } ?: return null
            return WalkTo(o.optStringOrNull("name") ?: return null, lat, lon)
        }
    }

    /** Walking directions there in the phone's maps app (Google Maps opens it; a browser otherwise). */
    fun mapsUri(): android.net.Uri =
        "https://www.google.com/maps/dir/?api=1&destination=$lat,$lon&travelmode=walking".toUri()
}


/** Something terminus learned and offers to change; `id` goes back to /me/choice. */
data class Suggestion(val id: String, val text: String, val accept: String, val dismiss: String) {
    companion object {
        fun parse(o: JSONObject): Suggestion? = Suggestion(
            o.optStringOrNull("id") ?: return null,
            o.optStringOrNull("text") ?: return null,
            o.optStringOrNull("accept") ?: return null,
            o.optStringOrNull("dismiss") ?: return null,
        )
    }
}

/** A class you chose to leave a bus earlier for (`earlier`) or get no reminders for (`quiet`). */
data class TripChoice(val trip: String, val pref: String, val label: String?)

/** A button on the card: `id` is the signal to send, `trip` which trip it's about. */
data class CardAction(val id: String, val label: String, val trip: String) {
    companion object {
        fun parse(o: JSONObject): CardAction? = CardAction(
            o.optStringOrNull("id") ?: return null,
            o.optStringOrNull("label") ?: return null,
            o.optStringOrNull("trip") ?: return null,
        )
    }
}

/** `/me/day`: today's timeline. */
data class DayItem(
    val kind: String,
    val key: String,
    val label: String,
    /** done | now | next | later | skipped */
    val status: String,
    val fromName: String?,
    val toName: String,
    val startsAtMs: Long,
    val endsAtMs: Long?,
    val leaveAtMs: Long?,
    val leaveEstimated: Boolean,
    val svc: String?,
    /** Where to catch it: the bus's stop, which may not be where you set off from. */
    val leaveStop: String? = null,
    val timingText: String?,
    val timingStatus: String?,
    /** On the bus to it: "On the D2 · off at UTown · arrive 9:52", worded by [DayTimeline]. */
    val onBus: OnBus? = null,
    /** Can be taken off today (swiped away): anything not done yet. */
    val removable: Boolean = false,
    /** The server's line under it: "Leave by ~09:36 · R2 from PGP", "Not going"; null when done or from an older server. */
    val line: String? = null,
    /** The server's name for it: the class, or "Home, from UTown"; null from an older server. */
    val title: String? = null,
)

data class OnBus(val svc: String, val off: String?, val arriveMs: Long?)

/** `date` is the SGT day it's for (YYYY-MM-DD): a plan kept for offline is only used that day. */
data class DayPlan(val items: List<DayItem>, val note: String?, val date: String? = null) {
    companion object {
        fun parse(o: JSONObject): DayPlan = parsing {
            val a = o.optJSONArray("items") ?: JSONArray()
            DayPlan(
                items = (0 until a.length()).map {
                    val x = a.getJSONObject(it)
                    val leave = x.optJSONObject("leave")
                    val timing = x.optJSONObject("timing")
                    val bus = x.optJSONObject("onBus")
                    DayItem(
                        kind = x.optString("kind"),
                        key = x.optString("key"),
                        label = x.optString("label"),
                        status = x.optString("status"),
                        fromName = x.optStringOrNull("fromName"),
                        toName = x.optString("toName"),
                        startsAtMs = parseInstant(x.optString("startsAt")) ?: 0,
                        endsAtMs = x.optStringOrNull("endsAt")?.let(::parseInstant),
                        leaveAtMs = leave?.optStringOrNull("at")?.let(::parseInstant),
                        leaveEstimated = leave?.optBoolean("estimated", false) ?: false,
                        svc = leave?.optStringOrNull("svc"),
                        leaveStop = leave?.optStringOrNull("stop"),
                        timingText = timing?.optStringOrNull("text"),
                        timingStatus = timing?.optStringOrNull("status"),
                        onBus = bus?.let { OnBus(it.optString("svc"), it.optStringOrNull("off"), it.optStringOrNull("arrive")?.let(::parseInstant)) },
                        removable = x.optBoolean("removable", false),
                        line = x.optStringOrNull("line"),
                        title = x.optStringOrNull("title"),
                    )
                },
                note = o.optStringOrNull("note"),
                date = o.optStringOrNull("date"),
            )
        }
    }
}

/**
 * A service at a stop and its next bus. `color` (#rrggbb), the service's
 * colour. `paid`: a public bus, with a fare. `later`: the buses after the
 * next one the feed knows, soonest first: every later time there is, so
 * nothing else is guessed. `towards`: the next stop's name, then where the
 * route ends (one entry when they're the same). `crowd`: the next bus's
 * (low, medium, high). `endsAtMs`: when the service stops for the day.
 * An older server leaves the newer fields out: empty, or null.
 */
data class BoardRow(
    val svc: String,
    val etaS: Int?,
    val quality: String,
    val color: String? = null,
    val paid: Boolean = false,
    val later: List<LaterBus> = emptyList(),
    val towards: List<String> = emptyList(),
    val crowd: String? = null,
    val endsAtMs: Long? = null,
    /** The route ends at this stop: the server gave `towards` and it's empty. An older server gives none. */
    val endsHere: Boolean = false,
    /** False: a service that calls here but isn't running now (asked for with `stopped=1`). */
    val running: Boolean = true,
    /** Why it isn't: "ended" (done for today), "notYet" (later today), "noService" (not today). */
    val stopped: String? = null,
    /** When it next starts; null when none was found. */
    val resumesAtMs: Long? = null,
    /** The server's words: "4 min", "now", "~6 min"; null without a time, or from an older server. */
    val eta: String? = null,
    /** "then 12, ~20, 25 min"; null with no later buses, or from an older server. */
    val laterText: String? = null,
    /** "to Central Library, Kent Vale", "Ends here"; null from an older server. */
    val toText: String? = null,
)

/** A bus after the next one, with its own quality: a timetabled one stays a guess. [eta] is the server's "12 min". */
data class LaterBus(val etaS: Int, val quality: String, val eta: String? = null)

private fun parseLater(r: JSONObject): List<LaterBus> {
    val a = r.optJSONArray("later") ?: return emptyList()
    return (0 until a.length()).mapNotNull { k ->
        val b = a.optJSONObject(k) ?: return@mapNotNull null
        if (b.isNull("etaS")) null else LaterBus(b.optInt("etaS"), b.optString("quality"), b.optStringOrNull("eta"))
    }
}

/** One board row, wherever a board appears (/arrivals, /me/nearby, /line). */
fun parseBoardRow(r: JSONObject): BoardRow = BoardRow(
    svc = r.getString("svc"),
    etaS = if (!r.has("etaS") || r.isNull("etaS")) null else r.optInt("etaS"),
    quality = r.optString("quality"),
    color = r.optStringOrNull("color")?.ifEmpty { null },
    paid = r.optBoolean("paid", false),
    later = parseLater(r),
    towards = r.optJSONArray("towards").stringList().filter { it.isNotBlank() },
    crowd = r.optStringOrNull("crowd")?.takeIf { it in CROWDS },
    endsAtMs = r.optStringOrNull("endsAt")?.let(::parseInstant),
    running = r.optBoolean("running", true),
    stopped = r.optStringOrNull("stopped")?.takeIf { it in STOPPED },
    resumesAtMs = r.optStringOrNull("resumesAt")?.let(::parseInstant),
    endsHere = r.optJSONArray("towards")?.let { a -> (0 until a.length()).none { a.optString(it).isNotBlank() } } ?: false,
    eta = r.optStringOrNull("eta")?.ifEmpty { null },
    laterText = r.optStringOrNull("laterText")?.ifEmpty { null },
    toText = r.optStringOrNull("toText")?.ifEmpty { null },
)

private val CROWDS = setOf("low", "medium", "high")
internal val STOPPED = setOf("ended", "notYet", "noService")

data class NearbyStop(
    val code: String,
    val name: String,
    val walkS: Int,
    val available: Boolean,
    val board: List<BoardRow>,
    /** The stop across the road, if it has one. */
    val opposite: String? = null,
    /** Metres away as the crow flies; null from an older server. */
    val distM: Int? = null,
    /** The full name, where [name] is short; null from an older server. */
    val longName: String? = null,
    /** [opposite] is across the road; false when the two are only near each other (PGP and PGP Foyer). */
    val oppositeAcross: Boolean = true,
    /** [opposite]'s full name; null from an older server. */
    val oppositeName: String? = null,
)

data class Destination(
    val code: String,
    val label: String,
    val stopCode: String,
    val kind: String,
    /** Metres on foot from the stop; null for a stop. */
    val walkM: Int? = null,
    /** Other names people search for, lower case ("soc", "mrt"). */
    val aliases: List<String> = emptyList(),
    /** A landmark's every stop; the router takes the quicker. */
    val stops: List<String> = emptyList(),
    /** What a landmark is ("Food court"). */
    val detail: String? = null,
)

/** The destination search, by the rules every client shares ([SearchRank], search.json). */
fun rankDestinations(all: List<Destination>, query: String, max: Int = SearchRank.MAX): List<Destination> =
    SearchRank.rank(all, query, max) { SearchRank.Key(it.kind, it.code, it.label, it.aliases) }

/** What the user asked for: the planned trip, a saved place, or any stop/venue. */
sealed interface Target {
    data object Plan : Target
    data class SavedPlace(val key: String) : Target
    data class Code(val code: String, val label: String) : Target
}

/** The server said no. [message] is a sentence to show: the API's own errors are lowercase phrases, written for API users. */
open class ApiError(val status: Int, message: String) : IOException(sentence(message))

/**
 * 426: the server no longer serves this version (KV `config:minClient`).
 * Nothing is asked again for a while ([Outdated]); the app offers the update.
 */
class UpdateRequired(message: String) : ApiError(426, message)

/** "not a valid NUSMods share link" -> "Not a valid NUSMods share link." */
internal fun sentence(text: String): String {
    if (text.isEmpty()) return text
    val s = text.replaceFirstChar { it.uppercaseChar() }
    // Chinese ends with a full-width stop.
    val cjk = s.any { it in '\u4e00'..'\u9fff' }
    return if (s.last() in ".!?。！？") s else if (cjk) "$s。" else "$s."
}

/** The answer arrived but isn't what this version understands. Not a network problem. */
class ParseError(message: String) : Exception(message)

/** A conditional request's answer: what the app kept is still current. */
class NotModified : Exception("not modified")

/** `fast` is for the widget: a tap runs inside a broadcast, which can be killed. */
class Api(private val token: String?, private val fast: Boolean = false, private val hour12: Boolean = false) {

    suspend fun pair(code: String, name: String): String {
        val body = JSONObject().put("code", code).put("name", name)
        return parsing { request("POST", "/pair", body).getString("token") }
    }

    /** First launch: an account with no email, so the app works before any sign-in. */
    suspend fun anon(name: String): String =
        parsing { request("POST", "/auth/anon", JSONObject().put("name", name).put("platform", "android")).getString("token") }

    suspend fun me(): Me = Me.parse(request("GET", "/me"))

    /** The whole profile as the server keeps it; edited and sent back whole. */
    suspend fun profile(): JSONObject = request("GET", "/me/profile")

    suspend fun saveProfile(profile: JSONObject): JSONObject = request("PUT", "/me/profile", profile)

    /** Imports a NUSMods share link; the server replaces the imported classes only if it all worked. */
    suspend fun import(share: String): ImportResult = parsing { ImportResult.parse(request("POST", "/me/import", JSONObject().put("share", share))) }

    /** Stops and residences, for the home and place pickers. */
    suspend fun campus(): Campus = Campus.parse(request("GET", "/campus"))

    /**
     * `/campus` as it came, with its ETag, for the map (MapData), which keeps
     * a copy for offline. Null when [etag] says the kept copy is still current.
     */
    suspend fun campusJson(etag: String? = null): Pair<JSONObject, String?>? {
        var tag: String? = null
        val json = try {
            request("GET", "/campus", ifNoneMatch = etag) { tag = it.getHeaderField("etag") }
        } catch (e: NotModified) {
            return null
        }
        return json to tag
    }

    /** One service's live buses, for the map. */
    suspend fun buses(svc: String): BusList = parsing { BusList.parse(request("GET", "/buses?svc=${enc(svc)}")) }

    /**
     * What's coming at one stop, for the Buses tab and the map's stop sheet:
     * every row, the stop's name and its twin, and the services not running
     * now (`stopped=1`), greyed. With [public], the public buses there too
     * (the profile's `publicBuses`).
     */
    suspend fun board(stop: String, public: Boolean = false): Board =
        parsing { Board.parse(request("GET", "/arrivals?stop=${enc(stop)}&stopped=1" + if (public) "&public=1" else "")) }

    /** One service's whole line; with [stop], that stop's board row for it too. */
    suspend fun line(svc: String, stop: String? = null): Line =
        parsing { Line.parse(request("GET", "/line?svc=${enc(svc)}" + (stop?.let { "&stop=${enc(it)}" } ?: ""))) }

    /** Starts a sign-in approved from the email; send it with this device's anonymous token to keep its setup. */
    suspend fun signInStart(email: String, name: String): SignInRequest {
        val o = request("POST", "/auth/app/start", JSONObject().put("email", email).put("name", name))
        return parsing { SignInRequest(o.getString("request"), o.getString("poll"), o.getInt("match")) }
    }

    suspend fun signInPoll(r: SignInRequest): SignInPoll {
        val o = request("POST", "/auth/app/poll", JSONObject().put("request", r.request).put("poll", r.poll))
        return parsing { SignInPoll(o.getString("status"), o.optStringOrNull("token"), o.optStringOrNull("email"), o.optStringOrNull("outcome")) }
    }

    /** The code from the email, typed here. A wrong one throws with the server's message. */
    suspend fun signInCode(r: SignInRequest, code: String): SignInPoll {
        val o = request("POST", "/auth/app/code", JSONObject().put("request", r.request).put("poll", r.poll).put("code", code))
        return parsing { SignInPoll(o.getString("status"), o.optStringOrNull("token"), o.optStringOrNull("email"), o.optStringOrNull("outcome")) }
    }

    /** After a "choose" outcome: which setup to keep. `anon` is the device's old token. */
    suspend fun merge(anon: String, keepDevice: Boolean) {
        request("POST", "/auth/app/merge", JSONObject().put("anon", anon).put("keep", if (keepDevice) "device" else "account"))
    }

    /** A code another device can pair with (accounts with an email only). */
    suspend fun pairCode(): String = parsing { request("POST", "/me/pair-code", JSONObject()).getString("code") }

    suspend fun devices(): List<Device> {
        val o = request("GET", "/me/devices")
        return parsing {
            val list = o.getJSONArray("devices")
            (0 until list.length()).map {
                val d = list.getJSONObject(it)
                Device(
                    d.getString("id"), d.optStringOrNull("name") ?: L.s(R.string.device_unnamed), d.optStringOrNull("platform"),
                    d.optLong("created"), d.optLong("lastSeen"), d.optBoolean("current", false),
                )
            }
        }
    }

    suspend fun removeDevice(id: String) {
        request("DELETE", "/me/devices/${enc(id)}")
    }

    /** Only for an account with no email: one with an email is deleted from the account page. */
    suspend fun deleteAccount() {
        request("DELETE", "/me")
    }

    suspend fun next(target: Target, lat: Double?, lon: Double?, acc: Double? = null): NextAnswer =
        NextAnswer.parse(nextJson(target, lat, lon, acc))

    /** Raw form, for the widget cache. `acc` is how far out the fix may be ([Locator.accOf]). */
    suspend fun nextJson(target: Target, lat: Double?, lon: Double?, acc: Double? = null): JSONObject {
        val q = buildList {
            if (lat != null && lon != null) {
                add("lat=${coord(lat)}")
                add("lon=${coord(lon)}")
                acc?.let { add("acc=${Math.round(it)}") }
            }
            when (target) {
                Target.Plan -> {}
                is Target.SavedPlace -> add("place=${enc(target.key)}")
                is Target.Code -> add("to=${enc(target.code)}")
            }
            // The card's clock times, in this phone's 12- or 24-hour style.
            if (hour12) add("h12=1")
        }
        return request("GET", "/me/next" + query(q))
    }

    suspend fun nearby(lat: Double?, lon: Double?, acc: Double? = null): List<NearbyStop> = parseNearby(nearbyJson(lat, lon, acc))

    /** [stopped]: the services not running now too, greyed on the Buses tab; Nearby and the widgets leave them out. */
    suspend fun nearbyJson(lat: Double?, lon: Double?, acc: Double? = null, stopped: Boolean = false): JSONObject {
        val q = (if (lat != null && lon != null) listOfNotNull("lat=${coord(lat)}", "lon=${coord(lon)}", acc?.let { "acc=${Math.round(it)}" }) else emptyList()) +
            listOfNotNull("stopped=1".takeIf { stopped })
        return request("GET", "/me/nearby" + query(q))
    }

    suspend fun destinations(): List<Destination> {
        val o = request("GET", "/campus")
        return parsing {
            val list = o.getJSONArray("destinations")
            (0 until list.length()).map { parseDestination(list.getJSONObject(it)) }
        }
    }

    /** Something that happened on the trip ("boarded", "missed", ...). Answers with the new /me/next. */
    suspend fun signal(kind: String, trip: String?): JSONObject {
        val body = JSONObject().put("kind", kind)
        trip?.let { body.put("trip", it) }
        return request("POST", "/me/signal" + if (hour12) "?h12=1" else "", body)
    }

    /** A one-off trip later today: planned like a class. Answers with the new /me/next. */
    suspend fun once(target: Target, atMin: Int): JSONObject {
        val body = JSONObject().put("atMin", atMin)
        when (target) {
            is Target.SavedPlace -> body.put("place", target.key)
            is Target.Code -> body.put("to", target.code).put("label", target.label)
            Target.Plan -> {}
        }
        return request("POST", "/me/once" + if (hour12) "?h12=1" else "", body)
    }

    /** This phone's Firebase token, so the server can say when the card changes. */
    suspend fun registerPush(token: String) {
        request("POST", "/me/push", JSONObject().put("token", token))
    }

    /** No more pushes to this session: nothing on the phone would show them. */
    suspend fun unregisterPush() {
        request("DELETE", "/me/push")
    }

    /** A suggestion accepted or turned down (`id`), or a choice undone (`trip` and `pref`). */
    suspend fun choice(choice: String, id: String? = null, trip: String? = null, pref: String? = null): List<TripChoice> {
        val body = JSONObject().put("choice", choice)
        id?.let { body.put("id", it) }
        trip?.let { body.put("trip", it) }
        pref?.let { body.put("pref", it) }
        return parseChoices(request("POST", "/me/choice", body))
    }

    /**
     * The new semester's reminder, in both languages (unless the account chose
     * one), or null when there's none: for a push that says only `kind: term`.
     */
    suspend fun notice(): Map<String, String>? {
        val n = request("GET", "/me/notice").optJSONObject("notice") ?: return null
        // Only the fields sent: a missing one is absent, not "".
        return listOf("title", "body", "zhTitle", "zhBody").mapNotNull { k -> n.optStringOrNull(k)?.let { k to it } }.toMap()
    }

    /** Classes with a bus earlier or no reminders, and how many trips are remembered. */
    suspend fun choices(): Pair<List<TripChoice>, Int> {
        val o = request("GET", "/me/choices")
        return parseChoices(o) to o.optInt("history", 0)
    }

    /** "Clear trip history": forgets how each trip went; choices stay. */
    suspend fun clearHistory() {
        request("DELETE", "/me/history")
    }

    private fun parseChoices(o: JSONObject): List<TripChoice> = parsing {
        val a = o.optJSONArray("choices") ?: return@parsing emptyList()
        (0 until a.length()).map { a.getJSONObject(it).let { c -> TripChoice(c.getString("trip"), c.getString("pref"), c.optStringOrNull("label")) } }
    }

    /** Today's timeline. */
    suspend fun day(lat: Double? = null, lon: Double? = null, acc: Double? = null): DayPlan = DayPlan.parse(dayJson(lat, lon, acc))

    /**
     * /me/day as it came: kept for when the phone is offline ([Store.saveDay]).
     * With a location, the next class is planned from there, as the card is.
     */
    suspend fun dayJson(lat: Double? = null, lon: Double? = null, acc: Double? = null): JSONObject {
        val q = buildList {
            if (lat != null && lon != null) {
                add("lat=${coord(lat)}")
                add("lon=${coord(lon)}")
                acc?.let { add("acc=${Math.round(it)}") }
            }
            if (hour12) add("h12=1")
        }
        return request("GET", "/me/day" + if (q.isEmpty()) "" else "?" + q.joinToString("&"))
    }

    /** Whose account a pairing code belongs to (masked), without spending it. */
    suspend fun pairCheck(code: String): String =
        parsing { request("POST", "/pair/check", JSONObject().put("code", code)).getString("account") }

    /** The released version, from /download/latest.json. */
    suspend fun latestVersion(): String = parsing { request("GET", "/download/latest.json").getString("version") }

    /**
     * "Is this wrong?": the answer as the server sent it, with a reason (one of
     * REPORT_REASONS), a note, or both. Needs an account with an email.
     */
    suspend fun report(reason: String?, note: String, answer: JSONObject?, appVersion: String) {
        val body = JSONObject().put("kind", "wrong").put("note", note).put("platform", "android").put("appVersion", appVersion)
        reason?.let { body.put("reason", it) }
        answer?.let { body.put("context", it) }
        request("POST", "/me/feedback", body)
    }

    /** Send feedback: a note about anything, emailed to the operator like "Is this wrong?". Needs an account with an email. */
    suspend fun feedback(note: String, appVersion: String) {
        val body = JSONObject().put("kind", "other").put("note", note).put("platform", "android").put("appVersion", appVersion)
        request("POST", "/me/feedback", body)
    }

    /** A stop suggestion: the stop the person uses for a building, and why. Needs an account with an email. */
    suspend fun suggestStop(venue: String, stop: String, why: String, appVersion: String) {
        val body = JSONObject().put("kind", "stop").put("venue", venue).put("stop", stop).put("note", why).put("platform", "android").put("appVersion", appVersion)
        request("POST", "/me/feedback", body)
    }

    /** Download my data: everything the account holds, as the account page gives it. */
    suspend fun export(): JSONObject = request("GET", "/me/export")

    /** Ends this device's session on the server. */
    suspend fun logout() {
        request("POST", "/auth/logout", JSONObject())
    }

    private suspend fun request(
        method: String,
        path: String,
        body: JSONObject? = null,
        ifNoneMatch: String? = null,
        seen: ((HttpURLConnection) -> Unit)? = null,
    ): JSONObject =
        withContext(Dispatchers.IO) {
            // Refused as too old: nothing the server would refuse goes out until
            // the hold is up (or the app is updated). Signing in or out and
            // leaving (pushes off, the account deleted) still go, as it serves them.
            if (Outdated.gated(method, path) && Outdated.holding()) throw UpdateRequired(L.s(R.string.update_required))
            // Asked to slow down: nothing goes out until Retry-After is up.
            if (Quiet.blocked(path)) throw ApiError(429, L.s(R.string.busy_try_again))
            val conn = URL(Servers.base + path).openConnection() as HttpURLConnection
            try {
                // Fast (widgets, a push, an alarm's broadcast, the live
                // notification) must finish inside the ~10 s a broadcast or a
                // push handler gets. The timeouts below are per step (and per
                // address tried, with none for the DNS lookup), so the whole
                // exchange has a deadline of its own too, which also ends it
                // when the caller is cancelled.
                withTimeout(if (fast) FAST_DEADLINE_MS else DEADLINE_MS) {
                    blocking(conn) { exchange(conn, method, path, body, ifNoneMatch, seen) }
                }
            } catch (e: TimeoutCancellationException) {
                throw java.net.SocketTimeoutException("no answer within the deadline")
            } finally {
                conn.disconnect()
            }
        }

    private fun exchange(
        conn: HttpURLConnection,
        method: String,
        path: String,
        body: JSONObject?,
        ifNoneMatch: String?,
        seen: ((HttpURLConnection) -> Unit)?,
    ): JSONObject {
        conn.requestMethod = method
        // Fast: 2 s to connect plus 7 s to read stays under the broadcast's
        // budget. The Worker gives each NUS call up to 5 s, and a cold
        // /me/next mints a guest token first, which usually fits in 7 s. A
        // connection is up in well under a second, or not at all within 2.
        // The read timeout counts each wait for bytes, but the answer is one
        // small JSON body sent at once, so it is in effect the wait for the
        // reply. The rare worst case (a re-mint and a retry, ~20 s) is left
        // to the next refresh rather than overrunning the budget.
        conn.connectTimeout = if (fast) 2_000 else 8_000
        conn.readTimeout = if (fast) 7_000 else 10_000
        conn.setRequestProperty("accept", "application/json")
        // So the server can tell apps and versions apart (the User-Agent only says Dalvik).
        conn.setRequestProperty("x-terminus-client", CLIENT)
        // The server writes answers, cards and errors in the app's language.
        conn.setRequestProperty("accept-language", L.header())
        token?.let { conn.setRequestProperty("authorization", "Bearer $it") }
        ifNoneMatch?.let { conn.setRequestProperty("if-none-match", it) }
        if (body != null) {
            conn.doOutput = true
            conn.setRequestProperty("content-type", "application/json")
            conn.outputStream.use { it.write(body.toString().toByteArray()) }
        }
        val status = conn.responseCode
        // How far the phone's clock is out, from a reply fresh from the server.
        val cached = (conn.getHeaderField("age")?.trim()?.toLongOrNull() ?: 0) > 0 || conn.getHeaderField("cf-cache-status").equals("HIT", ignoreCase = true)
        ServerClock.observe(conn.getHeaderField("date"), System.currentTimeMillis(), cached)
        val retryAfter = conn.getHeaderField("retry-after")
        if (status == 429) Quiet.after(path, retryAfter)
        // Down for a moment (the accounts database): the polling loops wait it out.
        if (status == 503) Quiet.later(retryAfter)
        if (status == 304 && ifNoneMatch != null) throw NotModified()
        seen?.invoke(conn)
        val stream = if (status in 200..299) conn.inputStream else conn.errorStream
        val text = stream?.bufferedReader()?.use { it.readText() }.orEmpty()
        val json = runCatching { JSONObject(text) }.getOrNull()
        if (status == 426) {
            Outdated.refused()
            throw UpdateRequired(L.s(R.string.update_required))
        }
        // Without the API's own words (an HTML error page from in front
        // of the Worker), a plain sentence rather than "HTTP 502".
        if (status !in 200..299) throw ApiError(status, json?.optStringOrNull("error") ?: L.s(R.string.server_not_answering))
        // Only an account's routes are refused as too old, so only they say it's over.
        if (token != null && Outdated.gated(method, path)) Outdated.served()
        // A 200 that isn't JSON is not "offline": the server said something this version can't read.
        return json ?: throw ParseError("not JSON")
    }

    private fun query(parts: List<String>) = if (parts.isEmpty()) "" else "?" + parts.joinToString("&")
    private fun enc(s: String) = URLEncoder.encode(s, "UTF-8")
}

/** The whole exchange, connecting included, for a fast request (a broadcast's ~10 s) and any other. */
private const val FAST_DEADLINE_MS = 9_000L
private const val DEADLINE_MS = 20_000L

/**
 * Runs [block] on an IO thread and waits for it, cancellably: cancelled (or
 * past [withTimeout]'s deadline), [conn] is disconnected, which ends a
 * connect or a read under way, and the caller goes on at once rather than
 * waiting out a blocking call, such as a DNS lookup, that has no timeout.
 */
private suspend fun <T> blocking(conn: HttpURLConnection, block: () -> T): T = suspendCancellableCoroutine { cont ->
    val io = Dispatchers.IO.asExecutor()
    // Off the cancelling thread, which may be the main one.
    cont.invokeOnCancellation { io.execute { conn.disconnect() } }
    // A result after cancellation is dropped by the continuation.
    io.execute { cont.resumeWith(runCatching(block)) }
}

/**
 * After a 429, every request on this phone (the app, its widgets, the live
 * notification) waits out the server's Retry-After, at most 5 minutes: a
 * loop that kept asking would only keep the limit tripped, and each refused
 * request still costs the server one. Sign-in, pairing and code routes have
 * limits of their own, so a 429 from one holds back only those, not the
 * widget's answers. The wait goes by the time since boot (the phone's clock
 * can be changed), and is kept in the settings by the wall clock, so a
 * process started for a widget or a push honours it too.
 */
object Quiet {
    private const val MAX_S = 300L
    private const val DEFAULT_S = 60L
    private const val KEY = "quiet-until"

    /** For tests: the time since boot, and the wall clock. */
    internal var elapsed: () -> Long = { android.os.SystemClock.elapsedRealtime() }
    internal var wall: () -> Long = { System.currentTimeMillis() }

    @Volatile private var prefs: android.content.SharedPreferences? = null
    @Volatile private var untilElapsed = 0L
    @Volatile private var authUntilElapsed = 0L
    /** A 503's Retry-After: not a gate, only how long the polling loops wait. */
    @Volatile private var laterElapsed = 0L

    /** At process start ([TerminusApp]): a wait a process before this one was told. */
    fun init(ctx: android.content.Context) {
        val p = ctx.applicationContext.getSharedPreferences("terminus-net", android.content.Context.MODE_PRIVATE)
        prefs = p
        val left = p.getLong(KEY, 0) - wall()
        if (left > 0) untilElapsed = maxOf(untilElapsed, elapsed() + left.coerceAtMost(MAX_S * 1000))
    }

    fun blocked(path: String): Boolean {
        val now = elapsed()
        return now < untilElapsed || (auth(path) && now < authUntilElapsed)
    }

    fun after(path: String, retryAfter: String?) {
        val s = (retryAfter?.trim()?.toLongOrNull()?.takeIf { it > 0 } ?: DEFAULT_S).coerceAtMost(MAX_S)
        val until = elapsed() + s * 1000
        if (auth(path)) {
            authUntilElapsed = until
            return
        }
        untilElapsed = until
        prefs?.edit { putLong(KEY, wall() + s * 1000) }
    }

    fun later(retryAfter: String?) {
        val s = retryAfter?.trim()?.toLongOrNull()?.takeIf { it > 0 } ?: return
        laterElapsed = elapsed() + s.coerceAtMost(MAX_S) * 1000
    }

    /** How long until requests go out again, ms (0: now): a retry waits at least this. */
    fun remainingMs(): Long = (untilElapsed - elapsed()).coerceAtLeast(0)

    /** How long a polling loop waits before asking again, at least: a 429's wait or a 503's. */
    fun waitMs(): Long = maxOf(remainingMs(), laterElapsed - elapsed(), 0)

    internal fun auth(path: String) = path.startsWith("/auth/") || path.startsWith("/pair") || path.startsWith("/me/pair-code")

    /** For tests. */
    internal fun reset() {
        untilElapsed = 0
        authUntilElapsed = 0
        laterElapsed = 0
    }
}

/**
 * The server refused this version (426, below KV `config:minClient`).
 * Nothing is asked for [HOLD_MS] after that, from the app, the widgets or
 * the notifications: then one request finds out whether the minimum has
 * come down. Kept in the settings, for every process, until an answer
 * comes or this version is replaced.
 */
object Outdated {
    /** Half an hour, as the Mac app holds. */
    private const val HOLD_MS = 30 * 60_000L
    private const val KEY_AT = "outdated-at"
    private const val KEY_VERSION = "outdated-version"

    internal var wall: () -> Long = { System.currentTimeMillis() }
    @Volatile private var prefs: android.content.SharedPreferences? = null
    @Volatile private var at = 0L

    fun init(ctx: android.content.Context) {
        val p = ctx.applicationContext.getSharedPreferences("terminus-net", android.content.Context.MODE_PRIVATE)
        prefs = p
        // Refused as another version: this one may be new enough.
        at = if (p.getString(KEY_VERSION, null) == BuildConfig.VERSION_NAME) p.getLong(KEY_AT, 0) else 0
    }

    /** Refused lately: what the app shows is the update, not an error. */
    val required: Boolean get() = at != 0L

    fun holding(): Boolean = at != 0L && wall() - at in 0 until HOLD_MS

    /**
     * Whether the server refuses this request to an outdated app, as
     * apps/api checks it: an account's routes (`/me…`) and the answers it
     * asks with its token (KEYED in index.ts). Not signing in or out
     * (`/auth/…`, `/pair…`), the released version (`/download/…`), nor
     * taking the device off pushes or deleting the account
     * (`DELETE /me/push`, `DELETE /me`).
     */
    fun gated(method: String, path: String): Boolean {
        val p = path.substringBefore('?')
        if (method == "DELETE" && (p == "/me" || p == "/me/push")) return false
        return p == "/me" || p.startsWith("/me/") || p in ANSWERS
    }

    /** The bus answers the server refuses an outdated app (KEYED in apps/api/src/index.ts). */
    private val ANSWERS = setOf("/next", "/trip", "/arrivals", "/buses", "/line", "/campus", "/stops/pairs")

    fun refused() {
        at = wall()
        prefs?.edit { putLong(KEY_AT, at).putString(KEY_VERSION, BuildConfig.VERSION_NAME) }
    }

    fun served() {
        if (at == 0L) return
        at = 0
        prefs?.edit { remove(KEY_AT).remove(KEY_VERSION) }
    }

    /** For tests. */
    internal fun reset() {
        at = 0
    }
}

/** `x-terminus-client`: platform and version. */
val CLIENT = "android/${BuildConfig.VERSION_NAME}"

/** `/me`: who this device is signed in as. */
data class Me(val email: String?, val anonymous: Boolean, val needsSetup: Boolean, val needsReimport: Boolean = false, val term: String? = null) {
    companion object {
        fun parse(o: JSONObject) = Me(
            email = o.optStringOrNull("email"),
            anonymous = o.optBoolean("anonymous", false),
            needsSetup = o.optStringOrNull("onboarding") != null,
            needsReimport = o.optBoolean("needsReimport", false),
            term = o.optStringOrNull("term"),
        )
    }
}

data class SignInRequest(val request: String, val poll: String, val match: Int)

/** status: pending | approved | denied | expired. outcome as in applogin.ts. */
data class SignInPoll(val status: String, val token: String?, val email: String?, val outcome: String?)

data class Device(val id: String, val name: String, val platform: String?, val createdMs: Long, val lastSeenMs: Long, val current: Boolean)

/** A stop, with the services that call there (for its sign in setup). */
data class Stop(val code: String, val name: String, val lat: Double, val lon: Double, val services: List<String> = emptyList())

/** `common`: where most students live (PGP, UTown Residence), shown first in the pickers. */
data class Residence(val code: String, val name: String, val stops: List<String>, val walkM: Int, val common: Boolean = false, val walkMin: Int? = null) {
    /** Minutes on foot to its stop, as the server works them out; at a steady 1.3 m/s from an older server. */
    val minutes: Int get() = walkMin ?: maxOf(1, Math.round(walkM / 1.3 / 60).toInt())
}

/** `colors`: each service's colour as NUS paints it, from /campus's routes. */
data class Campus(val stops: List<Stop>, val residences: List<Residence>, val destinations: List<Destination>, val colors: Map<String, Long> = emptyMap()) {
    fun stopName(code: String) = stops.firstOrNull { it.code == code }?.name ?: code
    fun stop(code: String) = stops.firstOrNull { it.code == code }

    companion object {
        fun parse(o: JSONObject): Campus = parsing {
            val s = o.getJSONArray("stops")
            val r = o.optJSONArray("residences") ?: JSONArray()
            val d = o.optJSONArray("destinations") ?: JSONArray()
            val routes = o.optJSONObject("routes")
            Campus(
                stops = (0 until s.length()).map {
                    val x = s.getJSONObject(it)
                    Stop(x.getString("code"), x.optString("name", x.getString("code")), x.optDouble("lat"), x.optDouble("lon"), x.optJSONArray("services").stringList())
                }.sortedBy { it.name },
                residences = (0 until r.length()).map {
                    val x = r.getJSONObject(it)
                    val st = x.getJSONArray("stops")
                    Residence(x.getString("code"), x.getString("name"), (0 until st.length()).map { i -> st.getString(i) }, x.optInt("walkM"), x.optBoolean("common"), x.optInt("walkMin", 0).takeIf { it >= 1 })
                }.sortedWith(compareByDescending<Residence> { it.common }.thenBy { it.name }),
                destinations = (0 until d.length()).map { parseDestination(d.getJSONObject(it)) },
                colors = routes?.keys()?.asSequence()?.associateWith { parseColor(routes.getJSONObject(it).optString("color")) }.orEmpty(),
            )
        }
    }
}

/** `/me/import`: what was found, what couldn't be placed, and for which semester. */
/** An imported class whose room couldn't be placed: the person picks its stop, or skips it. */
data class Unplaced(val module: String, val venue: String, val day: Int, val arriveByMin: Int, val endMin: Int?, val offCampus: Boolean)

data class ImportResult(val profile: JSONObject, val classes: Int, val unresolved: List<String>, val missing: List<String>, val term: String, val unplaced: List<Unplaced> = emptyList()) {
    companion object {
        fun parse(o: JSONObject): ImportResult = parsing {
            val profile = o.getJSONObject("profile")
            val un = o.optJSONArray("unresolved") ?: JSONArray()
            val miss = o.optJSONArray("missing") ?: JSONArray()
            ImportResult(
                profile = profile,
                classes = profile.optJSONArray("trips")?.length() ?: 0,
                unresolved = (0 until un.length()).map { un.getJSONObject(it).let { u -> L.s(R.string.module_at_venue, u.optString("module"), u.optString("venue")) } },
                missing = (0 until miss.length()).map { miss.getString(it) },
                term = o.optString("term"),
                unplaced = (0 until un.length()).map {
                    un.getJSONObject(it).let { u ->
                        Unplaced(u.optString("module"), u.optString("venue"), u.optInt("day"), u.optInt("arriveByMin"), if (u.has("endMin")) u.optInt("endMin") else null, u.optBoolean("offCampus"))
                    }
                },
            )
        }
    }
}

/** The phone's name, as Settings and the account page show it: "Google Pixel 8". */
fun deviceName(): String =
    "${android.os.Build.MANUFACTURER.replaceFirstChar { it.uppercase() }} ${android.os.Build.MODEL}".take(40)

/**
 * Four decimals is about 11 m: enough to tell PGP from PGP Foyer, and no
 * more precise than that in URLs that pass through logs.
 */
private fun coord(v: Double) = "%.4f".format(java.util.Locale.ROOT, v)

private fun parseDestination(d: JSONObject) = Destination(
    d.getString("code"), d.getString("label"), d.getString("stopCode"), d.optString("kind"),
    walkM = if (d.has("walkM")) d.optInt("walkM") else null,
    aliases = d.optJSONArray("aliases")?.let { a -> (0 until a.length()).map { a.getString(it) } }.orEmpty(),
    stops = d.optJSONArray("stops")?.let { a -> (0 until a.length()).map { a.getString(it) } }.orEmpty(),
    detail = d.optStringOrNull("detail"),
)

internal fun parseInstant(s: String): Long? = runCatching { java.time.Instant.parse(s).toEpochMilli() }.getOrNull()

/**
 * 12-hour times: the account's choice ([Clock]), else the phone's own
 * setting. The server is asked for its card in the same style.
 */
fun hour12(ctx: android.content.Context): Boolean = when (Clock.pref(ctx)) {
    Clock.H12 -> true
    Clock.H24 -> false
    else -> !android.text.format.DateFormat.is24HourFormat(ctx)
}

/**
 * The account's 12- or 24-hour choice (its profile's `clock`), kept on the
 * phone for the widgets and alarms, which don't load the profile.
 */
object Clock {
    const val AUTO = "auto"
    const val H12 = "12"
    const val H24 = "24"
    private const val KEY = "clock"

    private fun prefs(ctx: android.content.Context) = ctx.applicationContext.getSharedPreferences("terminus", android.content.Context.MODE_PRIVATE)

    fun pref(ctx: android.content.Context): String = prefs(ctx).getString(KEY, AUTO) ?: AUTO

    fun keep(ctx: android.content.Context, pref: String) {
        prefs(ctx).edit().putString(KEY, if (pref == H12 || pref == H24) pref else AUTO).apply()
    }
}

/**
 * "1.0.10" > "1.0.9", and a release is newer than its own pre-release:
 * "2.0.0" > "2.0.0-beta.2" > "2.0.0-beta" > "1.3.10".
 */
fun isNewer(latest: String, current: String): Boolean {
    fun parts(v: String): Pair<List<Int>, List<Int>?> {
        val (num, pre) = v.split('-', limit = 2).let { it[0] to it.getOrNull(1) }
        // "beta.2" -> [2]; "beta" -> [0]. No tag at all ranks above any tag.
        return num.split('.').map { it.toIntOrNull() ?: 0 } to pre?.let { p -> listOf(p.substringAfter('.', "0").toIntOrNull() ?: 0) }
    }
    fun cmp(a: List<Int>, b: List<Int>): Int {
        for (i in 0 until maxOf(a.size, b.size)) {
            val d = a.getOrElse(i) { 0 } - b.getOrElse(i) { 0 }
            if (d != 0) return d
        }
        return 0
    }
    val (an, ap) = parts(latest)
    val (bn, bp) = parts(current)
    val d = cmp(an, bn)
    if (d != 0) return d > 0
    return when {
        ap == null -> bp != null
        bp == null -> false
        else -> cmp(ap, bp) > 0
    }
}

fun JSONObject.optStringOrNull(key: String): String? = if (!has(key) || isNull(key)) null else optString(key)

/** /me/nearby's stops, nearest first. */
fun parseNearby(json: JSONObject): List<NearbyStop> = parsing {
    val stops = json.getJSONArray("stops")
    (0 until stops.length()).map { i ->
        val s = stops.getJSONObject(i)
        val board = s.getJSONArray("board")
        NearbyStop(
            code = s.getJSONObject("stop").getString("code"),
            name = s.getJSONObject("stop").getString("name"),
            walkS = s.optInt("walkS"),
            available = s.optBoolean("available", true),
            opposite = s.optStringOrNull("opposite")?.ifEmpty { null },
            longName = s.getJSONObject("stop").optStringOrNull("longName")?.ifEmpty { null },
            // On the stop object, or beside it as `opposite` is; an older server has neither: across, as before.
            oppositeAcross = (s.getJSONObject("stop").takeIf { it.has("oppositeAcross") } ?: s).optBoolean("oppositeAcross", true),
            oppositeName = (s.getJSONObject("stop").optStringOrNull("oppositeName") ?: s.optStringOrNull("oppositeName"))?.ifEmpty { null },
            distM = if (s.has("distM") && !s.isNull("distM")) s.optInt("distM") else null,
            board = (0 until board.length()).map { j -> parseBoardRow(board.getJSONObject(j)) },
        )
    }
}
