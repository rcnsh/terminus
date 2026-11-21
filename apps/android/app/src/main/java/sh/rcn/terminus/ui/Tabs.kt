package sh.rcn.terminus.ui

internal enum class Tab {
    Now,
    Nearby,
    Buses,
    Map,
    Settings;

    companion object {
        fun ofLink(host: String?): Tab? =
            when (host) {
                "nearby" -> Nearby
                "plan",
                "place",
                "to" -> Now
                else -> null
            }
    }
}
