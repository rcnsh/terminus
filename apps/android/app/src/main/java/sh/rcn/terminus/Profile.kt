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

    var homeWalkMin: Int
        get() = json.optInt("homeWalkMin", 5)
        set(v) { json.put("homeWalkMin", v.coerceIn(0, 30)) }

    var walkPace: String
        get() = json.optString("walkPace", "normal")
        set(v) { json.put("walkPace", v) }

    var fullBusMargin: Boolean
        get() = json.optBoolean("fullBusMargin", true)
        set(v) { json.put("fullBusMargin", v) }

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

    fun removeManual(index: Int) {
        val list = json.optJSONArray("manual") ?: return
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
        val kept = places.filter { it.key != key }
        json.put("places", JSONArray(kept.map { JSONObject().put("key", it.key).put("label", it.label).put("to", it.to) }))
    }

    private fun trips(field: String): List<Trip> {
        val a = json.optJSONArray(field) ?: return emptyList()
        return (0 until a.length()).map { Trip.parse(a.getJSONObject(it)) }
    }

    /** Somewhere to go or somewhere to start: what the server counts as a setup worth keeping. */
    val hasSetup: Boolean get() = homeStops.isNotEmpty() || trips.isNotEmpty() || manual.isNotEmpty() || places.isNotEmpty()
}

data class SavedPlace(val key: String, val label: String, val to: String)

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

/** Monday first, as a week reads; values are the server's 0 = Sunday. */
val WEEKDAYS = listOf(1 to "Monday", 2 to "Tuesday", 3 to "Wednesday", 4 to "Thursday", 5 to "Friday", 6 to "Saturday", 0 to "Sunday")

fun dayName(day: Int) = WEEKDAYS.firstOrNull { it.first == day }?.second ?: "?"

/** 570 -> "09:30". The profile is always 24-hour; show it in the phone's style with [hhmm12]. */
fun hhmm(min: Int) = "%02d:%02d".format(java.util.Locale.ROOT, min / 60, min % 60)

fun hhmm12(min: Int): String {
    val h = min / 60
    val m = min % 60
    val suffix = if (h < 12) "am" else "pm"
    val h12 = if (h % 12 == 0) 12 else h % 12
    return if (m == 0) "$h12 $suffix" else "$h12:%02d $suffix".format(java.util.Locale.ROOT, m)
}

private fun JSONArray.strings(): List<String> = (0 until length()).map { getString(it) }

/**
 * A NUSMods share link in text shared from another app ("…timetable/sem-1/share?CS2030=…").
 * NUSMods shares a sentence with the link in it, so this finds the link.
 */
fun nusmodsLink(text: String?): String? =
    text?.let { Regex("""https?://(?:www\.)?nusmods\.com/timetable/\S+""").find(it)?.value?.trimEnd('.', ',', ')') }
