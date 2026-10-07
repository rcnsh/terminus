package sh.rcn.terminus.widget

import sh.rcn.terminus.NextAnswer

/**
 * Past the card's `staleAt` (card.ts): the bus in the answer has left, the
 * plan has moved on (a class started, the day ended), or the answer is 15
 * minutes old. Refreshed then, and dimmed if the refresh hasn't landed. A
 * card without one (setup, rest, free) never dims by itself; only an answer
 * with no card at all (kept from an older version) counts as old, until the
 * next refresh replaces it. [now] is on the server's clock (ServerClock).
 */
fun isOld(answer: NextAnswer, now: Long): Boolean {
    val card = answer.card ?: return true
    return card.staleAtMs?.let { now >= it } ?: false
}
