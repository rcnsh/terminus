package sh.rcn.terminus

import sh.rcn.terminus.widget.UPDATING
import sh.rcn.terminus.widget.isOld

object Spoken {
    fun summary(
        paired: Boolean,
        answer: NextAnswer?,
        error: String?,
        now: Long,
        withHead: Boolean = true,
        clock: (Long) -> String,
    ): String {
        if (!paired) return L.s(DeviceKind.word(R.string.a11y_not_paired))
        if (answer == null) return L.s(R.string.a11y_loading, (error ?: L.s(R.string.a11y_loading_word)).trimEnd('.', '。'))
        val old = isOld(answer, now)
        val ride = answer.card?.ride?.takeIf { answer.card.phase == "riding" }
        if (ride != null) {
            return sentences(
                answer.destLabel?.let { L.s(R.string.a11y_on_the_to, ride.svc, it) } ?: L.s(R.string.on_the, ride.svc),
                L.s(R.string.a11y_off_at, ride.stops.last(), clock(ride.arriveMs)),
                ride.nextText(now, withChange = false),
                ride.change?.text,
                answer.qualityText,
            )
        }
        if (answer.isClassPlan && !old) {
            return sentences(
                answer.phaseText,
                answer.destLabel?.let {
                    L.s(if (answer.destPlace) R.string.a11y_arrive_by else R.string.a11y_starts, it, answer.classAtMs?.let(clock).orEmpty())
                },
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
            answer.timingText?.takeIf { !old && answer.card?.ride == null },
            answer.qualityText?.takeIf { !old },
            error?.takeIf { it != UPDATING },
        )
    }

    fun countdown(answer: NextAnswer, now: Long): String? {
        val leave = answer.leaveAtMs?.takeIf { it > now && answer.card?.phase != "waiting" }
        if (leave != null) return L.s(R.string.a11y_leave_in, minutes((leave - now) / 1000))
        val departs = answer.departsAtMs?.takeIf { it > now } ?: return null
        return L.s(R.string.a11y_leaves_in, minutes((departs - now) / 1000))
    }

    fun announcement(answer: NextAnswer?): String? {
        if (answer == null) return null
        val bus = answer.card?.journey?.bus
        val what =
            when {
                answer.card?.phase == "riding" -> null
                bus != null -> L.s(R.string.a11y_bus_from, bus.svc, bus.stop)
                else -> answer.title.substringBefore(" · ")
            }
        return listOfNotNull(answer.phaseText, answer.card?.heading ?: answer.destLabel, what)
            .distinct()
            .joinToString(L.s(R.string.sentence_sep))
            .ifEmpty { null }
    }

    fun minutes(seconds: Long): String {
        if (seconds < 30) return L.s(R.string.a11y_under_minute)
        val m = ((seconds + 30) / 60).toInt()
        return if (m == 1) L.s(R.string.a11y_minute) else L.s(R.string.a11y_minutes, m)
    }

    fun eta(etaS: Int?, quality: String, withQuality: Boolean = true): String? {
        val s = etaS ?: return null
        if (BusTimes.arriving(s, quality)) return L.s(R.string.map_arriving)
        val m = minutes(maxOf(s, if (quality == "live") 0 else 60).toLong())
        return when {
            quality == "scheduled" -> L.s(if (withQuality) R.string.a11y_eta_timetable else R.string.a11y_eta_about, m)
            quality == "live" -> if (withQuality) L.s(R.string.a11y_eta_live, m) else m
            else -> L.s(R.string.a11y_eta_about, m)
        }
    }

    fun spell(text: String): String = text.replace(Regex("~\\s?"), L.s(R.string.a11y_about))

    fun sentences(vararg parts: String?): String {
        val stop = L.s(R.string.sentence_sep)
        val comma = L.s(R.string.clause_sep)
        return parts.filterNotNull().filter { it.isNotBlank() }.joinToString(stop) { spell(it.replace(" · ", comma).trimEnd('.', '。')) } +
            stop.trimEnd()
    }
}
