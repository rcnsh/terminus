package sh.rcn.terminus

/**
 * Which fix the card is asked from, and when it's asked again: the same on the iPhone and the web. Waiting the full 6 s for a fresh fix
 * before asking anything leaves "Checking…" on screen every time the phone comes out of a pocket, so the answer goes out after a short
 * grace with what the phone already knows, and comes again once if the fresh fix says you're somewhere else. Plain numbers, no Android
 * types, so it runs on the JVM.
 */
object FirstFix {
    /** A fix younger than this is as good as a new one, and costs no wait: polling every 30 s must not mean a GPS request every 30 s. */
    const val RECENT_MS = 60_000L

    /** How long a fresh fix is waited for before the answer is asked for without it. */
    const val FIX_GRACE_MS = 1_500L

    /** An older fix sent meanwhile is good enough if it's under this: the API widens its `acc` by its age and ignores it past 200 m. */
    const val FALLBACK_MS = 10 * 60_000L

    /** The API ignores a fix whose `acc` is over this (`MAX_FIX_ACC_M` there). */
    const val MAX_ACC_M = 200.0

    /** The fresh fix this far from the one sent: the answer was for somewhere else, so it's asked again. */
    const val MOVED_M = 50.0

    /** With no recent fix, what to send: the fresh one if it came within the grace, else the best older one, or none. */
    fun <T> toSend(fresh: T?, fallback: T?): T? = fresh ?: fallback

    /**
     * Whether the answer sent from [sentLat], [sentLon] (null: sent without a fix) is asked again now that a fresh fix has come at
     * [freshLat], [freshLon]. No fresh fix: nothing new to ask from.
     */
    fun reload(
        sentLat: Double?,
        sentLon: Double?,
        freshLat: Double?,
        freshLon: Double?,
        sentAccM: Double? = null,
        freshAccM: Double? = null,
    ): Boolean {
        // No fresh fix, or one the API would drop too: nothing new to ask from.
        if (freshLat == null || freshLon == null || (freshAccM ?: 0.0) > MAX_ACC_M) return false
        // A sent fix the API drops (its `acc` over MAX_ACC_M) counts as none.
        if (sentLat == null || sentLon == null || (sentAccM ?: 0.0) > MAX_ACC_M) return true
        return RoutePath.haversine(sentLat, sentLon, freshLat, freshLon) > MOVED_M
    }
}
