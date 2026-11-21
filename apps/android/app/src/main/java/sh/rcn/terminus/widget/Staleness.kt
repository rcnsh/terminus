package sh.rcn.terminus.widget

import sh.rcn.terminus.NextAnswer

fun isOld(answer: NextAnswer, now: Long): Boolean {
    val card = answer.card ?: return true
    return card.staleAtMs?.let { now >= it } ?: false
}
