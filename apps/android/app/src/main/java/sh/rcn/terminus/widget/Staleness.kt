package sh.rcn.terminus.widget

import sh.rcn.terminus.NextAnswer

/**
 * Past this, an answer is refreshed, and dimmed if the refresh hasn't landed.
 * A clock time stays true until the bus leaves, so this is only the backstop
 * for relative text ("or A1 9 min") and missed refreshes.
 */
const val MAX_AGE_MS = 15 * 60_000L
/** A bus shown as leaving at 09:42 might still be at the stop at 09:42:20. */
const val DEPARTED_GRACE_MS = 30_000L

/**
 * The bus in the answer has left, the plan has moved on (a class started, the
 * day ended), or the answer is past MAX_AGE_MS. A rest answer only goes old
 * when the day starts. Worked out on the server (card.ts staleAt).
 */
fun isOld(answer: NextAnswer, fetchedAt: Long?, now: Long): Boolean {
    // The server says when (card.staleAt); the rule below is only for an
    // answer cached by an older version, until the next refresh replaces it.
    answer.card?.staleAtMs?.let { return now >= it }
    if (answer.refreshAtMs?.let { now >= it } == true) return true
    if (answer.mode == "rest") return false
    val departed = answer.departsAtMs?.let { now > it + DEPARTED_GRACE_MS } ?: false
    val aged = fetchedAt != null && now - fetchedAt > MAX_AGE_MS
    return departed || aged
}
