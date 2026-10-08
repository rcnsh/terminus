package sh.rcn.terminus.widget

import sh.rcn.terminus.Journey
import sh.rcn.terminus.JourneyText
import sh.rcn.terminus.L
import sh.rcn.terminus.NextAnswer
import sh.rcn.terminus.OfflineDay
import sh.rcn.terminus.R
import sh.rcn.terminus.ui.Road
import sh.rcn.terminus.ui.RoadBus
import sh.rcn.terminus.ui.roadFor

/** A service's badge and a line beside it, on the ground under the horizon: the leg to take, the ride's next stop. */
internal data class Leg(val svc: String?, val color: Long, val paid: Boolean, val text: String)

/** "Live" in green, or "Scheduled" plain: how sure the time is, as on Now. */
internal data class Pill(val text: String, val good: Boolean)

/** Done for the day: the next class, in a pane of its own ("Tomorrow · Sat", "GEA1000 at 10:00", "At UTown"). */
internal data class Tile(val label: String, val title: String, val where: String?)

/**
 * What a widget says, whatever its size: a line above, the headline (with
 * [accent], the part in the accent colour: the time to leave), a line under
 * it with a [pill], and what's on the ground and on the horizon's road. Each
 * size shows as much of it as fits. Worked out once from the answer, so every
 * size says the same thing.
 */
internal data class Face(
    val heading: String?,
    val headline: String,
    val accent: String? = null,
    /** The trip misses the class: the headline in the late colour. */
    val late: Boolean = false,
    /** The times may be old: the headline dimmed. */
    val dim: Boolean = false,
    val sub: String? = null,
    val pill: Pill? = null,
    val leg: Leg? = null,
    val road: Road = Road(),
    val tile: Tile? = null,
    /** The trip's steps, for a widget with room to draw them. */
    val journey: Journey? = null,
) {
    /** The accent part, when the headline has one: what a small widget shows big. */
    val big: String? get() = accent?.takeIf { it.isNotEmpty() && headline.contains(it) }

    /** The headline without [big] ("Leave by"), shown small with it; null when there's no [big]. */
    val bigLabel: String? get() = big?.let { headline.replace(it, "").trim(' ', ',', '·').ifEmpty { null } }

    /** [big] comes first in the headline (Chinese: "约 09:36 前出发"): its label goes under it, not over. */
    val bigFirst: Boolean get() = big?.let { headline.trimStart().startsWith(it) } ?: false

    companion object {
        /** The road when nothing of yours is on it: a shuttle going by, as on Now. */
        private val IDLE = Road()

        /**
         * The face for [answer] (null before any), on the widget's [mode], with
         * the last [error] (or [UPDATING]); [offline] is the day plan's next
         * thing when the answer can't be trusted ([BaseWidget.frame]). [now] is
         * on the server's clock; [clock] formats a time.
         */
        fun of(paired: Boolean, mode: Mode, answer: NextAnswer?, error: String?, offline: OfflineDay.Pick?, now: Long, clock: (Long) -> String): Face {
            if (!paired) return Face(null, "terminus", sub = error ?: L.s(R.string.tap_to_pair))
            // A problem, or a refresh under way, says so under the headline, in place of what's there.
            val problem = error?.let { if (it == UPDATING) L.s(R.string.updating) else it }
            if (offline != null) {
                val lines = OfflineDay.lines(offline, clock)
                return Face(L.s(R.string.offline) + " · " + lines.head, lines.big, sub = lines.how)
            }
            val onTimetable = mode == Mode.Timetable
            if (answer == null) {
                return Face(mode.label.takeIf { !onTimetable }, problem ?: L.s(R.string.loading), sub = L.s(R.string.tap_to_refresh))
            }
            val old = isOld(answer, now)
            val card = answer.card
            val ride = card?.ride?.takeIf { card.phase == "riding" }
            val journey = card?.journey
            return when {
                answer.arrived || answer.mode == "rest" || answer.isFree -> {
                    // There, outside the day, or a free day: no bus, and the next class when there is one.
                    val next = card?.upcoming
                    Face(
                        heading = answer.phaseText,
                        headline = answer.label,
                        sub = problem ?: answer.detail.takeIf { next == null && it.isNotEmpty() },
                        road = IDLE,
                        tile = next?.let { Tile(it.whenText, it.title, it.where.ifEmpty { null }) },
                    )
                }
                ride != null -> {
                    // On the bus: where you get off and when, the bus nearing that stop's sign, and the next stop.
                    val arrive = clock(ride.arriveMs)
                    val color = journey?.bus?.takeIf { it.svc == ride.svc }?.color ?: SHUTTLE_COLOR
                    Face(
                        heading = listOfNotNull(answer.phaseText, answer.destLabel).joinToString(" · ").ifEmpty { null },
                        headline = L.s(R.string.off_at_time, ride.stops.last(), arrive),
                        accent = arrive,
                        sub = problem ?: answer.timingText,
                        leg = Leg(ride.svc, color, false, ride.nextText(now)),
                        road = Road(stop = true, bus = RoadBus(color, 1f - ride.progress(now), live = true), shuttle = false),
                    )
                }
                journey != null && !old -> trip(answer, journey, problem, now, clock)
                answer.isClassPlan -> Face(
                    // An older server's class, or one whose times are old: when to leave leads.
                    heading = listOfNotNull(answer.phaseText, answer.destLabel, answer.classAtMs?.let { L.s(R.string.starts_at, clock(it)) }).joinToString(" · "),
                    headline = answer.leaveHeadline(now).orEmpty(),
                    late = answer.leaveLate && !old,
                    dim = old,
                    sub = problem ?: if (old) L.s(R.string.old_times) else answer.catchLine,
                    road = IDLE,
                )
                else -> Face(
                    // A clock time stays true until the bus leaves; once it's gone, or
                    // the data is old, dim it and ask for a tap rather than lie.
                    heading = listOfNotNull(answer.phaseText, card?.heading ?: localHeading(answer)).joinToString(" · ").ifEmpty { null },
                    headline = answer.clockLabel(clock),
                    dim = old,
                    sub = problem ?: if (old) L.s(R.string.old_times) else answer.detail,
                    leg = answer.leaveText(now)?.takeIf { !old }?.let { Leg(null, 0, false, it) },
                    road = IDLE,
                )
            }
        }

        /** A trip by bus or on foot: when to leave leads, the leg along the ground, your bus nearing your stop. */
        private fun trip(answer: NextAnswer, journey: Journey, problem: String?, now: Long, clock: (Long) -> String): Face {
            val bus = journey.bus
            val headline = answer.leaveHeadline(now) ?: L.s(R.string.leave_now)
            val leg = if (bus != null) {
                // "from PGP 9:42 → UTown 9:52": where to board, and where it gets you.
                val there = listOfNotNull(journey.toStop.ifEmpty { null }, journey.arriveStop).joinToString(" ")
                Leg(bus.svc, bus.color, bus.paid, listOfNotNull("${L.s(R.string.journey_from, bus.stop)} ${bus.board}", there.ifEmpty { null }).joinToString(" → "))
            } else {
                // On foot: the bus it beats, or for a class the one to go now on.
                JourneyText.backup(answer, journey)?.let { Leg(journey.backup?.svc, journey.backup?.color ?: 0, journey.backup?.paid ?: false, it) }
            }
            return Face(
                heading = JourneyText.to(answer, journey, clock),
                headline = headline,
                accent = journey.leave?.takeIf { headline.contains(it) },
                late = answer.leaveLate,
                sub = problem ?: JourneyText.arrive(journey),
                pill = bus?.let { if (journey.live) Pill(L.s(R.string.journey_live), true) else Pill(L.s(R.string.buses_scheduled), false) },
                leg = leg,
                road = roadFor(journey, now),
                journey = journey,
            )
        }

        /** The shuttle's colour when a ride's own isn't known: the dark one on Now's road. */
        private const val SHUTTLE_COLOR = 0xFF24211EL
    }
}

/** The line above the headline from an older server, without `card.heading`: where to, and a long gap. */
private fun localHeading(answer: NextAnswer): String? = listOfNotNull(
    answer.destLabel ?: if (answer.mode == "nearby") L.s(R.string.chip_nearby) else null,
    if (answer.why == "gap-home") L.s(R.string.long_gap_short) else null,
).joinToString(" · ").ifEmpty { null }
