package sh.rcn.terminus

import androidx.annotation.StringRes

/**
 * The few words the card styles put round the server's journey (Journey),
 * shared by the app's card and the widgets. The server words them
 * (`journey.title`, `byText`, `arriveText`, `backupText`, ...); only the
 * countdown is worked out here, because it ticks, and the rest only for an
 * older server that doesn't send them.
 */
object JourneyText {
    /**
     * "Leave in 4 min", "Leave in 1 min 5 s", "Leave in 45 s", then "Leave
     * now". At the stop it's the bus to wait for ("D2 at 4:05 PM"), as the
     * server says it. Minutes are rounded until the last two, then exact.
     */
    fun leaveIn(answer: NextAnswer, journey: Journey, now: Long): String {
        if (answer.card?.phase == "waiting") return answer.leaveHeadline(now) ?: L.s(R.string.leave_now)
        val left = secondsToLeave(answer, journey, now) ?: return L.s(R.string.leave_now)
        return countdown(left, R.string.leave_in_min, R.string.leave_in_min_s, R.string.leave_in_s)
    }

    /**
     * The time inside [leaveIn]'s headline ("6 min" of "Leave in 6 min", "6 分钟"
     * of "6 分钟后出发"), for the card to colour; null when there's none ("Leave now").
     */
    fun leaveTime(answer: NextAnswer, journey: Journey, now: Long): String? {
        val left = secondsToLeave(answer, journey, now) ?: return null
        return countdown(left, R.string.n_min, R.string.dur_min_s, R.string.dur_s)
    }

    /** Whole seconds until it's time to leave; null at the stop, with no leave time, or once it's passed. */
    private fun secondsToLeave(answer: NextAnswer, journey: Journey, now: Long): Long? {
        if (answer.card?.phase == "waiting") return null
        val at = answer.leaveAtMs
        if (at == null || journey.leave == null || now >= at) return null
        return (at - now) / 1000
    }

    /** [left] seconds in [min] ("4 min", rounded) from two minutes, else [minS] ("1 min 5 s"), else [s]. */
    private fun countdown(left: Long, @StringRes min: Int, @StringRes minS: Int, @StringRes s: Int): String = when {
        left >= 120 -> L.s(min, ((left + 30) / 60).toInt())
        left >= 60 -> L.s(minS, (left / 60).toInt(), (left % 60).toInt())
        else -> L.s(s, left.coerceAtLeast(1).toInt())
    }

    /** "To GEA1000 @ UTown · starts 10:00", the class's start being what the arrival and slack are about. */
    fun to(answer: NextAnswer, journey: Journey, clock: (Long) -> String): String = journey.text.title ?:
        listOfNotNull(L.s(R.string.journey_to, journey.to), answer.classAtMs?.takeIf { answer.isClassPlan }?.let { L.s(R.string.starts_at, clock(it)) }).joinToString(" · ")

    /** "by 4:01 PM" under the countdown, until it's time to go. */
    fun by(answer: NextAnswer, journey: Journey, now: Long): String? {
        if (answer.card?.phase == "waiting") return null
        val at = answer.leaveAtMs ?: return null
        if (now >= at) return null
        return journey.text.by ?: journey.leave?.let { L.s(R.string.leave_by_short, it) }
    }

    /** "Arrive 4:08 PM", with a class's "9 min early". */
    fun arrive(journey: Journey): String? = journey.text.arrive ?:
        journey.arrive?.let { listOfNotNull(L.s(R.string.journey_arrive_time, it), journey.slack).joinToString(" · ") }

    /**
     * "Or A1 at 4:05 PM from PGP"; for a class, the sooner bus to go now on. A
     * public bus is "95 ($)": the fare shows here too. On foot, the bus the
     * walk beats: "D1 would be 16 min".
     */
    fun backup(answer: NextAnswer, journey: Journey): String? = journey.text.backup ?: if (journey.bus == null) journey.why else journey.backup?.let {
        L.s(if (answer.isClassPlan) R.string.journey_backup_now else R.string.journey_backup, if (it.paid) "${it.svc} ($)" else it.svc, it.board, it.stop)
    }

    /** "5 min walk", as the server words it. */
    fun walk(journey: Journey): String? = journey.text.walk ?: journey.walk?.let { L.s(R.string.journey_walk, it) }

    /** "10 min ride · off at Opp NUSS". */
    fun ride(journey: Journey): String? = journey.text.ride ?: listOfNotNull(journey.ride?.let { L.s(R.string.journey_ride, it) }, journey.off?.let { L.s(R.string.off_at, it) }).joinToString(" · ").ifEmpty { null }

    /** Under the arrival time: "9 min early", else "2 min walk from UTown" or "at UTown". */
    fun arriveWhere(journey: Journey): String = journey.slack ?: journey.text.arriveWhere
        ?: journey.walkEnd?.let { L.s(R.string.journey_walk_from, it, journey.toStop) } ?: L.s(R.string.journey_at, journey.toStop)

    /** "in 4 min" to the bus leaving, or null once it has (or on foot, with no bus). */
    fun busIn(journey: Journey, now: Long): String? {
        val left = ((journey.boardAtMs ?: return null) - now) / 1000
        if (left <= 0) return null
        return if (left >= 120) L.s(R.string.in_min, ((left + 30) / 60).toInt()) else L.s(R.string.in_min_s, (left / 60).toInt(), (left % 60).toInt())
    }
}
