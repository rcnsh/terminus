package sh.rcn.terminus.ui

/**
 * The tabs once set up, in the order of the bottom bar and of the rail: Now, Nearby, Stops ([Buses]), Map, Settings. As the iPhone app's
 * and the web's (ADR 0017).
 */
internal enum class Tab {
    Now,
    Nearby,
    Buses,
    Map,
    Settings;

    companion object {
        /**
         * The tab a terminus:// link to [host] opens: Nearby its own, and the plan, a favourite or a place looked up (the card's) Now, so a
         * shortcut tapped while on another tab shows what it's for. Null for any other link, which leaves the tab as it is.
         */
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
