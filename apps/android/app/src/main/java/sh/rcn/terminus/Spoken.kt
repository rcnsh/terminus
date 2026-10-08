package sh.rcn.terminus

import sh.rcn.terminus.widget.UPDATING
import sh.rcn.terminus.widget.isOld

/**
 * What a screen reader says for the answer, on Now and on the widgets, and
 * for a bus's time. The sentences are the server's own words, joined; the
 * app words only what it works out itself (a countdown, rounded to the
 * minute) and spells out what the screen abbreviates ("~" is "about").
 */
object Spoken {
    /**
     * The answer as sentences: where to, the trip's phase, the bus and its
     * time, what to do, and how sure the times are. [now] is on the server's
     * clock; [clock] writes an instant as the account's clock does. Without
     * [withHead], a plain card leaves out its phase and where to: Now shows
     * and reads those on their own, just above.
     */
    fun summary(paired: Boolean, answer: NextAnswer?, error: String?, now: Long, withHead: Boolean = true, clock: (Long) -> String): String {
        if (!paired) return L.s(R.string.a11y_not_paired)
        if (answer == null) return L.s(R.string.a11y_loading, error ?: L.s(R.string.a11y_loading_word))
        val old = isOld(answer, now)
        val ride = answer.card?.ride?.takeIf { answer.card.phase == "riding" }
        if (ride != null) {
            return sentences(
                answer.destLabel?.let { L.s(R.string.a11y_on_the_to, ride.svc, it) } ?: L.s(R.string.on_the, ride.svc),
                L.s(R.string.a11y_off_at, ride.stops.last(), clock(ride.arriveMs)),
                ride.nextText(now),
                answer.qualityText,
            )
        }
        if (answer.isClassPlan && !old) {
            return sentences(
                answer.phaseText,
                answer.destLabel?.let { L.s(R.string.a11y_starts, it, answer.classAtMs?.let(clock).orEmpty()) },
                answer.leaveHeadline(now),
                answer.catchLine,
                answer.goNowLine,
                answer.qualityText,
            )
        }
        return sentences(
            answer.phaseText?.takeIf { withHead },
            answer.destLabel?.takeIf { withHead }?.let { L.s(R.string.a11y_to, it) },
            if (answer.mode == "rest") answer.label else answer.clockLabel(clock).replace(" · ", L.s(R.string.a11y_leaves)),
            if (old) L.s(R.string.a11y_old) else answer.detail,
            answer.leaveText(now)?.takeIf { !old },
            answer.timingText?.takeIf { !old },
            answer.qualityText?.takeIf { !old },
            error?.takeIf { it != UPDATING },
        )
    }

    /**
     * How long until it's time to go, in words and to the minute ("Leave in
     * 6 minutes"), for the card that counts down "6 min 32 s"; null once
     * it's time, or with nothing to count down to.
     */
    fun countdown(answer: NextAnswer, now: Long): String? {
        val leave = answer.leaveAtMs?.takeIf { it > now && answer.card?.phase != "waiting" }
        if (leave != null) return L.s(R.string.a11y_leave_in, minutes((leave - now) / 1000))
        val departs = answer.departsAtMs?.takeIf { it > now } ?: return null
        return L.s(R.string.a11y_leaves_in, minutes((departs - now) / 1000))
    }

    /**
     * What's said when the card changes, and only then: the trip's phase,
     * where to and the bus to catch. Nothing in it ticks, so a screen reader
     * that announces it on change isn't talking every second.
     */
    fun announcement(answer: NextAnswer?): String? {
        if (answer == null) return null
        val bus = answer.card?.journey?.bus
        val what = when {
            answer.card?.phase == "riding" -> null
            bus != null -> L.s(R.string.a11y_bus_from, bus.svc, bus.stop)
            // "D2 · 09:42": the service, without the time, which moves.
            else -> answer.title.substringBefore(" · ")
        }
        return listOfNotNull(answer.phaseText, answer.card?.heading ?: answer.destLabel, what).distinct().joinToString(L.s(R.string.sentence_sep)).ifEmpty { null }
    }

    /** "1 minute", "6 minutes", or "under a minute", for [seconds], rounded. */
    fun minutes(seconds: Long): String {
        if (seconds < 30) return L.s(R.string.a11y_under_minute)
        val m = ((seconds + 30) / 60).toInt()
        return if (m == 1) L.s(R.string.a11y_minute) else L.s(R.string.a11y_minutes, m)
    }

    /**
     * A bus's time as it's said: "about 6 minutes, timetable" for a timetable
     * guess (the screen's "~6 min"), "6 minutes, live" for a bus seen. Without
     * [withQuality] (where a tag beside it says so already), only the
     * "about". Null without a time.
     */
    fun eta(etaS: Int?, quality: String, withQuality: Boolean = true): String? {
        val s = etaS ?: return null
        if (s < BusTimes.ARRIVING_S) return L.s(R.string.map_arriving)
        val m = minutes(s.toLong())
        return when {
            quality == "scheduled" -> L.s(if (withQuality) R.string.a11y_eta_timetable else R.string.a11y_eta_about, m)
            quality == "live" -> if (withQuality) L.s(R.string.a11y_eta_live, m) else m
            // Any other quality is no live time either: never said as one.
            else -> L.s(R.string.a11y_eta_about, m)
        }
    }

    /** "~09:42" as it's said: "about 09:42". */
    fun spell(text: String): String = text.replace(Regex("~\\s?"), L.s(R.string.a11y_about))

    /** The parts, each a sentence: "To KR MRT. A1, leaves 09:09. …" (in Chinese, with "，" and "。"). */
    fun sentences(vararg parts: String?): String {
        val stop = L.s(R.string.sentence_sep)
        val comma = L.s(R.string.clause_sep)
        // A part that's already a sentence ("Couldn't reach terminus.") doesn't get a second stop.
        return parts.filterNotNull().filter { it.isNotBlank() }.joinToString(stop) { spell(it.replace(" · ", comma).trimEnd('.', '。')) } + stop.trimEnd()
    }
}
