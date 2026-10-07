package sh.rcn.terminus

import org.json.JSONArray
import org.json.JSONObject

/**
 * The profile as the server keeps it (apps/api/src/profile.ts), edited in
 * place and sent back whole with PUT /me/profile. Kept as JSON so fields this
 * version doesn't know about survive a save.
 */
class ProfileDoc(val json: JSONObject) {
    fun copy() = ProfileDoc(JSONObject(json.toString()))

    val homeStops: List<String>
        get() = json.optJSONObject("home")?.optJSONArray("stops")?.strings().orEmpty()

    fun setHomeStops(stops: List<String>) {
        val unique = stops.distinct().take(3)
        json.put("home", if (unique.isEmpty()) JSONObject.NULL else JSONObject().put("stops", JSONArray(unique)))
    }

    /** The stops pinned on the Buses tab, in their order. */
    var pinnedStops: List<String>
        get() = json.optJSONArray("pinnedStops")?.strings().orEmpty()
        set(v) { json.put("pinnedStops", JSONArray(v.distinct().take(Pins.MAX))) }

    /** The account's language (phase 10): auto, en or zh. */
    var lang: String
        get() = json.optString("lang", "auto")
        set(v) { json.put("lang", v) }

    /** The account's times: auto (each device's own), 12 or 24. */
    var clock: String
        get() = json.optString("clock", "auto")
        set(v) { json.put("clock", v) }

    var homeWalkMin: Int
        get() = json.optInt("homeWalkMin", 5)
        set(v) { json.put("homeWalkMin", v.coerceIn(0, 30)) }

    var walkPace: String
        get() = json.optString("walkPace", "normal")
        set(v) { json.put("walkPace", v) }

    var fullBusMargin: Boolean
        get() = json.optBoolean("fullBusMargin", true)
        set(v) { json.put("fullBusMargin", v) }

    /** Count the public buses (95, 151, ...) at the campus's stops too. Off until asked for: they have a fare. */
    var publicBuses: Boolean
        get() = json.optBoolean("publicBuses", false)
        set(v) { json.put("publicBuses", v) }

    var gapHours: Double
        get() = json.optDouble("gapHours", 2.0)
        set(v) { json.put("gapHours", v.coerceIn(0.5, 12.0)) }

    var dayStartMin: Int
        get() = json.optInt("dayStartMin", 6 * 60)
        set(v) { json.put("dayStartMin", v) }

    var dayEndMin: Int
        get() = json.optInt("dayEndMin", 18 * 60)
        set(v) { json.put("dayEndMin", v) }

    val share: String? get() = json.optStringOrNull("share")

    val seen: List<String> get() = json.optJSONArray("seen")?.strings().orEmpty()

    fun markSeen(name: String) {
        json.put("seen", JSONArray((seen + name).distinct()))
    }

    /** Imported from NUSMods. */
    val trips: List<Trip> get() = trips("trips")
    /** Entered by hand; they survive a re-import. */
    val manual: List<Trip> get() = trips("manual")

    fun addManual(t: Trip) {
        val list = json.optJSONArray("manual") ?: JSONArray()
        list.put(t.toJson())
        json.put("manual", list)
    }

    /** Sends one class to another stop: imported ([trips]) or by hand ([manual]), by its place in that list. */
    fun setClassStop(imported: Boolean, index: Int, to: String) {
        json.optJSONArray(if (imported) "trips" else "manual")?.optJSONObject(index)?.put("to", to)
    }

    /** Takes one class off: imported ([trips]) or added by hand ([manual]), by its place in that list. */
    fun removeClass(imported: Boolean, index: Int) {
        val list = json.optJSONArray(if (imported) "trips" else "manual") ?: return
        list.remove(index)
    }

    val places: List<SavedPlace>
        get() {
            val a = json.optJSONArray("places") ?: return emptyList()
            return (0 until a.length()).map { a.getJSONObject(it).let { p -> SavedPlace(p.getString("key"), p.getString("label"), p.getString("to")) } }
        }

    fun addPlace(label: String, to: String) {
        val list = json.optJSONArray("places") ?: JSONArray()
        list.put(JSONObject().put("key", placeKey(label, places.map { it.key })).put("label", label.trim().take(24)).put("to", to))
        json.put("places", list)
    }

    fun removePlace(key: String) {
        // The JSON objects themselves, so fields this version doesn't know about survive.
        val a = json.optJSONArray("places") ?: return
        json.put("places", JSONArray((0 until a.length()).map { a.getJSONObject(it) }.filter { it.optString("key") != key }))
        val u = json.optJSONArray("usual") ?: return
        json.put("usual", JSONArray((0 until u.length()).map { u.getJSONObject(it) }.filter { it.optString("place") != key }))
    }

    /** Saved places at a usual time (phase 8.3): each a trip that day, like a class. */
    val usual: List<UsualTime>
        get() {
            val a = json.optJSONArray("usual") ?: return emptyList()
            return (0 until a.length()).map { a.getJSONObject(it).let { u -> UsualTime(u.getString("place"), u.getInt("day"), u.getInt("atMin")) } }
        }


    fun removeUsual(u: UsualTime) {
        json.put("usual", JSONArray(usual.filter { it != u }.map { JSONObject().put("place", it.place).put("day", it.day).put("atMin", it.atMin) }))
    }

    private fun trips(field: String): List<Trip> {
        val a = json.optJSONArray(field) ?: return emptyList()
        return (0 until a.length()).map { Trip.parse(a.getJSONObject(it)) }
    }

    /** Somewhere to go or somewhere to start: what the server counts as a setup worth keeping. */
    val hasSetup: Boolean get() = homeStops.isNotEmpty() || trips.isNotEmpty() || manual.isNotEmpty() || places.isNotEmpty()
}

data class SavedPlace(val key: String, val label: String, val to: String)

/** A saved place at a usual time: day 0 = Sunday, minutes past midnight, Singapore time. */
data class UsualTime(val place: String, val day: Int, val atMin: Int)

/** A class or commitment. day: 0 = Sunday. Minutes past midnight, Singapore time. */
data class Trip(val day: Int, val arriveByMin: Int, val endMin: Int?, val to: String, val label: String, val venue: String) {
    fun toJson(): JSONObject = JSONObject()
        .put("day", day).put("arriveByMin", arriveByMin).put("to", to).put("label", label).put("venue", venue)
        .apply { if (endMin != null) put("endMin", endMin) }

    companion object {
        fun parse(o: JSONObject) = Trip(
            day = o.optInt("day"),
            arriveByMin = o.optInt("arriveByMin"),
            endMin = if (o.has("endMin")) o.optInt("endMin") else null,
            to = o.optString("to"),
            label = o.optString("label"),
            venue = o.optString("venue"),
        )
    }
}

/** "gym", "gym-2": the same rule as the account page. */
fun placeKey(label: String, taken: List<String>): String {
    var key = label.lowercase().replace(Regex("[^a-z0-9]+"), "-").trim('-').take(24).ifEmpty { "place" }
    var n = 2
    val base = key.take(21)
    while (key in taken) key = "$base-${n++}"
    return key
}

private val DAY_NAMES = listOf(1 to R.string.monday, 2 to R.string.tuesday, 3 to R.string.wednesday, 4 to R.string.thursday, 5 to R.string.friday, 6 to R.string.saturday, 0 to R.string.sunday)
private val DAY_SHORT = mapOf(1 to R.string.monday_short, 2 to R.string.tuesday_short, 3 to R.string.wednesday_short, 4 to R.string.thursday_short, 5 to R.string.friday_short, 6 to R.string.saturday_short, 0 to R.string.sunday_short)

/** Monday first, as a week reads; values are the server's 0 = Sunday. */
val WEEKDAYS: List<Pair<Int, String>> get() = DAY_NAMES.map { (d, id) -> d to L.s(id) }

fun dayName(day: Int) = DAY_NAMES.firstOrNull { it.first == day }?.second?.let { L.s(it) } ?: "?"

/** "Mon", "周一". */
fun dayShort(day: Int) = DAY_SHORT[day]?.let { L.s(it) } ?: "?"

/**
 * Where a picker for "later today" starts: half an hour from now on campus
 * (Singapore time), on a five-minute mark, and never past 23:55.
 */
fun soonOnCampus(nowMs: Long = System.currentTimeMillis()): Int {
    val now = java.time.Instant.ofEpochMilli(nowMs).atZone(java.time.ZoneId.of("Asia/Singapore"))
    val m = now.hour * 60 + now.minute + 30
    return minOf(23 * 60 + 55, (m + 4) / 5 * 5)
}

/** 570 -> "09:30". The profile is always 24-hour; show it in the phone's style with [hhmm12]. */
fun hhmm(min: Int) = "%02d:%02d".format(java.util.Locale.ROOT, min / 60, min % 60)

fun hhmm12(min: Int): String {
    val h = min / 60
    val m = min % 60
    val h12 = if (h % 12 == 0) 12 else h % 12
    val time = if (m == 0) "$h12" else "$h12:%02d".format(java.util.Locale.ROOT, m)
    return L.s(if (h < 12) R.string.time_am else R.string.time_pm, time)
}

private fun JSONArray.strings(): List<String> = (0 until length()).map { getString(it) }

/**
 * A NUSMods share link in text shared from another app ("…timetable/sem-1/share?CS2030=…").
 * NUSMods shares a sentence with the link in it, so this finds the link.
 */
fun nusmodsLink(text: String?): String? =
    text?.let { Regex("""https?://(?:www\.)?nusmods\.com/timetable/\S+""").find(it)?.value?.trimEnd('.', ',', ')') }
