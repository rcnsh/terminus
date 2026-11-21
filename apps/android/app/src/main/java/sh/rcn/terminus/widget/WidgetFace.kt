package sh.rcn.terminus.widget

import sh.rcn.terminus.DeviceKind
import sh.rcn.terminus.Journey
import sh.rcn.terminus.JourneyText
import sh.rcn.terminus.L
import sh.rcn.terminus.NextAnswer
import sh.rcn.terminus.OfflineDay
import sh.rcn.terminus.R
import sh.rcn.terminus.ui.Road
import sh.rcn.terminus.ui.RoadBus
import sh.rcn.terminus.ui.roadFor

internal data class Leg(val svc: String?, val color: Long, val paid: Boolean, val text: String)

internal data class Pill(val text: String, val good: Boolean)

internal data class Tile(val label: String, val title: String, val where: String?)

internal data class Face(
    val heading: String?,
    val headline: String,
    val accent: String? = null,
    val late: Boolean = false,
    val dim: Boolean = false,
    val sub: String? = null,
    val pill: Pill? = null,
    val leg: Leg? = null,
    val road: Road = Road(),
    val tile: Tile? = null,
    val journey: Journey? = null,
    val placeholder: Boolean = false,
) {
    val big: String?
        get() = accent?.takeIf { it.isNotEmpty() && headline.contains(it) }

    val bigLabel: String?
        get() = big?.let { headline.replace(it, "").trim(' ', ',', '·').ifEmpty { null } }

    val bigFirst: Boolean
        get() = big?.let { headline.trimStart().startsWith(it) } ?: false

    companion object {
        private val IDLE = Road()

        fun of(
            paired: Boolean,
            mode: Mode,
            answer: NextAnswer?,
            error: String?,
            offline: OfflineDay.Pick?,
            now: Long,
            clock: (Long) -> String,
        ): Face {
            if (!paired) return Face(null, "terminus", sub = error ?: L.s(DeviceKind.word(R.string.tap_to_pair)))
            val problem = error?.let { if (it == UPDATING) L.s(R.string.updating) else it }
            if (offline != null) {
                val lines = OfflineDay.lines(offline, clock)
                return Face(L.s(R.string.offline) + " · " + lines.head, lines.big, sub = lines.how)
            }
            val onTimetable = mode == Mode.Timetable
            if (answer == null) {
                val waiting = error == null || error == UPDATING
                return Face(
                    mode.label.takeIf { !onTimetable },
                    if (waiting) L.s(R.string.loading) else problem.orEmpty(),
                    sub = L.s(R.string.tap_to_refresh),
                    placeholder = waiting,
                )
            }
            val old = isOld(answer, now)
            val card = answer.card
            val ride = card?.ride?.takeIf { card.phase == "riding" }
            val journey = card?.journey
            return when {
                answer.arrived || answer.mode == "rest" || answer.isFree -> {
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
                answer.isClassPlan ->
                    Face(
                        heading =
                            listOfNotNull(answer.phaseText, answer.destLabel, answer.classAtMs?.let { L.s(answer.startsRes, clock(it)) })
                                .joinToString(" · "),
                        headline = answer.leaveHeadline(now).orEmpty(),
                        late = answer.leaveLate && !old,
                        dim = old,
                        sub = problem ?: if (old) L.s(R.string.old_times) else answer.catchLine,
                        road = IDLE,
                    )
                else ->
                    Face(
                        heading =
                            listOfNotNull(answer.phaseText, card?.heading ?: localHeading(answer)).joinToString(" · ").ifEmpty { null },
                        headline = answer.clockLabel(clock),
                        dim = old,
                        sub = problem ?: if (old) L.s(R.string.old_times) else answer.detail,
                        leg = answer.leaveText(now)?.takeIf { !old }?.let { Leg(null, 0, false, it) },
                        road = IDLE,
                    )
            }
        }

        private fun trip(answer: NextAnswer, journey: Journey, problem: String?, now: Long, clock: (Long) -> String): Face {
            val bus = journey.bus
            val headline = answer.leaveHeadline(now) ?: L.s(R.string.leave_now)
            val leg =
                if (bus != null) {
                    val there = listOfNotNull(journey.toStop.ifEmpty { null }, journey.arriveStop).joinToString(" ")
                    Leg(
                        bus.svc,
                        bus.color,
                        bus.paid,
                        listOfNotNull("${L.s(R.string.journey_from, bus.stop)} ${bus.board}", there.ifEmpty { null }).joinToString(" → "),
                    )
                } else {
                    JourneyText.backup(answer, journey)?.let {
                        Leg(journey.backup?.svc, journey.backup?.color ?: 0, journey.backup?.paid ?: false, it)
                    }
                }
            return Face(
                heading = JourneyText.to(answer, journey, clock),
                headline = headline,
                accent = journey.leave?.takeIf { headline.contains(it) },
                late = answer.leaveLate,
                sub = problem ?: JourneyText.arrive(journey),
                pill =
                    bus?.let { if (journey.live) Pill(L.s(R.string.journey_live), true) else Pill(L.s(R.string.buses_scheduled), false) },
                leg = leg,
                road = roadFor(journey, now),
                journey = journey,
            )
        }

        private const val SHUTTLE_COLOR = 0xFF24211EL
    }
}

private fun localHeading(answer: NextAnswer): String? =
    listOfNotNull(
            answer.destLabel ?: if (answer.mode == "nearby") L.s(R.string.chip_nearby) else null,
            if (answer.why == "gap-home") L.s(R.string.long_gap_short) else null,
        )
        .joinToString(" · ")
        .ifEmpty { null }
