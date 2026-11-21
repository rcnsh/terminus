package sh.rcn.terminus

object FirstFix {
    const val RECENT_MS = 60_000L

    const val FIX_GRACE_MS = 1_500L

    const val FALLBACK_MS = 10 * 60_000L

    const val MAX_ACC_M = 200.0

    const val MOVED_M = 50.0

    fun <T> toSend(fresh: T?, fallback: T?): T? = fresh ?: fallback

    fun reload(
        sentLat: Double?,
        sentLon: Double?,
        freshLat: Double?,
        freshLon: Double?,
        sentAccM: Double? = null,
        freshAccM: Double? = null,
    ): Boolean {
        if (freshLat == null || freshLon == null || (freshAccM ?: 0.0) > MAX_ACC_M) return false
        if (sentLat == null || sentLon == null || (sentAccM ?: 0.0) > MAX_ACC_M) return true
        return RoutePath.haversine(sentLat, sentLon, freshLat, freshLon) > MOVED_M
    }
}
