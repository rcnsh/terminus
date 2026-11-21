package sh.rcn.terminus

import org.json.JSONArray
import org.json.JSONObject

data class Limits(
    val pinnedStops: Int = 8,
    val label: Int = 60,
    val places: Int = 12,
    val placeLabel: Int = 24,
    val homeWalkMin: IntRange = 0..30,
) {
    companion object {
        val DEFAULT = Limits()

        fun parse(o: JSONObject?): Limits {
            if (o == null) return DEFAULT
            fun n(key: String, fallback: Int) = o.optInt(key, fallback).takeIf { it > 0 } ?: fallback
            val walk = o.optJSONObject("homeWalkMin")
            val min = walk?.optInt("min", DEFAULT.homeWalkMin.first) ?: DEFAULT.homeWalkMin.first
            val max = walk?.optInt("max", DEFAULT.homeWalkMin.last) ?: DEFAULT.homeWalkMin.last
            return Limits(
                pinnedStops = n("pinnedStops", DEFAULT.pinnedStops),
                label = n("label", DEFAULT.label),
                places = n("places", DEFAULT.places),
                placeLabel = n("placeLabel", DEFAULT.placeLabel),
                homeWalkMin = if (max >= min) min..max else DEFAULT.homeWalkMin,
            )
        }
    }
}

class ProfileDoc(val json: JSONObject) {
    fun copy() = ProfileDoc(JSONObject(json.toString()))

    val limits: Limits
        get() = Limits.parse(json.optJSONObject("limits"))

    val homeStops: List<String>
        get() = json.optJSONObject("home")?.optJSONArray("stops")?.strings().orEmpty()

    fun setHomeStops(stops: List<String>) {
        val unique = stops.distinct().take(3)
        json.put("home", if (unique.isEmpty()) JSONObject.NULL else JSONObject().put("stops", JSONArray(unique)))
    }

    var pinnedStops: List<String>
        get() = json.optJSONArray("pinnedStops")?.strings().orEmpty()
        set(v) {
            json.put("pinnedStops", JSONArray(v.distinct().take(limits.pinnedStops)))
        }

    var lang: String
        get() = json.optString("lang", "auto")
        set(v) {
            json.put("lang", v)
        }

    var clock: String
        get() = json.optString("clock", "auto")
        set(v) {
            json.put("clock", v)
        }

    var homeWalkMin: Int
        get() = json.optInt("homeWalkMin", 5)
        set(v) {
            json.put("homeWalkMin", v.coerceIn(limits.homeWalkMin))
        }

    var walkPace: String
        get() = json.optString("walkPace", "normal")
        set(v) {
            json.put("walkPace", v)
        }

    var fullBusMargin: Boolean
        get() = json.optBoolean("fullBusMargin", true)
        set(v) {
            json.put("fullBusMargin", v)
        }

    var publicBuses: Boolean
        get() = json.optBoolean("publicBuses", false)
        set(v) {
            json.put("publicBuses", v)
        }

    var preferBus: Boolean
        get() = json.optBoolean("preferBus", true)
        set(v) {
            json.put("preferBus", v)
        }

    var gapHours: Double
        get() = json.optDouble("gapHours", 2.0)
        set(v) {
            json.put("gapHours", v.coerceIn(0.5, 12.0))
        }

    var dayStartMin: Int
        get() = json.optInt("dayStartMin", 6 * 60)
        set(v) {
            json.put("dayStartMin", v)
        }

    var dayEndMin: Int
        get() = json.optInt("dayEndMin", 18 * 60)
        set(v) {
            json.put("dayEndMin", v)
        }

    val share: String?
        get() = json.optStringOrNull("share")

    val seen: List<String>
        get() = json.optJSONArray("seen")?.strings().orEmpty()

    fun markSeen(name: String) {
        json.put("seen", JSONArray((seen + name).distinct()))
    }

    val trips: List<TimetableClass>
        get() = trips("trips")

    val manual: List<TimetableClass>
        get() = trips("manual")

    fun addManual(t: TimetableClass) {
        val list = json.optJSONArray("manual") ?: JSONArray()
        list.put(t.toJson())
        json.put("manual", list)
    }

    fun classAt(imported: Boolean, index: Int): JSONObject? =
        json.optJSONArray(if (imported) "trips" else "manual")?.optJSONObject(index)?.let { JSONObject(it.toString()) }

    fun setClassStop(imported: Boolean, index: Int, seen: JSONObject, to: String) {
        val list = json.optJSONArray(if (imported) "trips" else "manual") ?: return run { missed = true }
        find(list, index, seen)?.let { list.getJSONObject(it).put("to", to) }
    }

    fun removeClass(imported: Boolean, index: Int, seen: JSONObject) {
        val list = json.optJSONArray(if (imported) "trips" else "manual") ?: return run { missed = true }
        find(list, index, seen)?.let { list.remove(it) }
    }

    var missed = false
        private set

    private fun find(list: JSONArray, index: Int, seen: JSONObject): Int? {
        fun same(i: Int) = list.optJSONObject(i)?.let { sameJson(it, seen, except = "to") } == true
        if (same(index)) return index
        return (0 until list.length()).firstOrNull(::same)
            ?: run {
                missed = true
                null
            }
    }

    val places: List<SavedPlace>
        get() {
            val a = json.optJSONArray("places") ?: return emptyList()
            return (0 until a.length()).map {
                a.getJSONObject(it).let { p -> SavedPlace(p.getString("key"), p.getString("label"), p.getString("to")) }
            }
        }

    fun addPlace(label: String, to: String) {
        if (places.any { it.to == to }) return
        val list = json.optJSONArray("places") ?: JSONArray()
        list.put(
            JSONObject().put("key", placeKey(label, places.map { it.key })).put("label", label.trim().take(limits.placeLabel)).put("to", to)
        )
        json.put("places", list)
    }

    fun removePlace(key: String): RemovedPlace? {
        val a = json.optJSONArray("places") ?: return null
        val all = (0 until a.length()).map { a.getJSONObject(it) }
        val index = all.indexOfFirst { it.optString("key") == key }
        if (index < 0) return null
        json.put("places", JSONArray(all.filterIndexed { i, _ -> i != index }))
        val u = json.optJSONArray("usual")
        val usual = if (u == null) emptyList() else (0 until u.length()).map { u.getJSONObject(it) }
        if (u != null) json.put("usual", JSONArray(usual.filter { it.optString("place") != key }))
        return RemovedPlace(
            index,
            JSONObject(all[index].toString()),
            usual.filter { it.optString("place") == key }.map { JSONObject(it.toString()) },
        )
    }

    fun removePlaceAt(to: String): RemovedPlace? = places.firstOrNull { it.to == to }?.let { removePlace(it.key) }

    fun restorePlace(r: RemovedPlace) {
        val now = places
        if (now.size >= limits.places || now.any { it.to == r.place.optString("to") }) return
        val was = r.place.optString("key")
        val key = if (now.any { it.key == was }) placeKey(r.label, now.map { it.key }) else was
        val a = json.optJSONArray("places") ?: JSONArray()
        val all = (0 until a.length()).map { a.getJSONObject(it) }.toMutableList()
        all.add(r.index.coerceAtMost(all.size), JSONObject(r.place.toString()).put("key", key))
        json.put("places", JSONArray(all))
        if (r.usual.isEmpty()) return
        val u = json.optJSONArray("usual") ?: JSONArray()
        r.usual.forEach { u.put(JSONObject(it.toString()).put("place", key)) }
        json.put("usual", u)
    }

    val usual: List<UsualTime>
        get() {
            val a = json.optJSONArray("usual") ?: return emptyList()
            return (0 until a.length()).map {
                a.getJSONObject(it).let { u -> UsualTime(u.getString("place"), u.getInt("day"), u.getInt("atMin")) }
            }
        }

    fun removeUsual(u: UsualTime) {
        val a = json.optJSONArray("usual") ?: return
        val kept =
            (0 until a.length())
                .map { a.getJSONObject(it) }
                .filter { UsualTime(it.getString("place"), it.getInt("day"), it.getInt("atMin")) != u }
        json.put("usual", JSONArray(kept))
    }

    private fun trips(field: String): List<TimetableClass> {
        val a = json.optJSONArray(field) ?: return emptyList()
        return (0 until a.length()).map { TimetableClass.parse(a.getJSONObject(it)) }
    }

    val hasSetup: Boolean
        get() = homeStops.isNotEmpty() || trips.isNotEmpty() || manual.isNotEmpty() || places.isNotEmpty()
}

internal fun sameJson(a: Any?, b: Any?, except: String? = null): Boolean =
    when {
        a is JSONObject && b is JSONObject -> {
            val keys = a.keys().asSequence().filter { it != except }.toSet()
            keys == b.keys().asSequence().filter { it != except }.toSet() && keys.all { sameJson(a.opt(it), b.opt(it)) }
        }
        a is JSONArray && b is JSONArray -> a.length() == b.length() && (0 until a.length()).all { sameJson(a.opt(it), b.opt(it)) }
        a is Number && b is Number -> a.toDouble() == b.toDouble()
        else -> a == b
    }

class Tagged(val json: JSONObject, val version: String?)

typealias ProfileChange = (ProfileDoc) -> Unit

class SavedProfile(val doc: ProfileDoc, val version: String?, val missed: Boolean)

suspend fun saveChanges(
    base: ProfileDoc,
    version: String?,
    changes: List<ProfileChange>,
    load: suspend () -> Tagged,
    save: suspend (JSONObject, String?) -> Tagged,
    tries: Int = 3,
): SavedProfile {
    var missed = false
    fun on(json: JSONObject) = ProfileDoc(json).also { d -> changes.forEach { it(d) } }
    var doc: ProfileDoc
    var from: String?
    if (version != null) {
        doc = base.copy().also { d -> changes.forEach { it(d) } }
        missed = doc.missed
        from = version
    } else {
        val fresh = load()
        doc = on(fresh.json)
        missed = doc.missed
        from = fresh.version
    }
    var attempt = 1
    while (true) {
        try {
            val saved = save(doc.json, from)
            return SavedProfile(ProfileDoc(saved.json), saved.version, missed)
        } catch (e: ApiError) {
            if (e.status != 412 || attempt >= tries) throw e
        }
        attempt++
        val fresh = load()
        doc = on(fresh.json)
        missed = missed || doc.missed
        from = fresh.version
    }
}

data class SavedPlace(val key: String, val label: String, val to: String)

class RemovedPlace(val index: Int, val place: JSONObject, val usual: List<JSONObject>) {
    val label: String
        get() = place.optString("label")
}

data class UsualTime(val place: String, val day: Int, val atMin: Int)

data class TimetableClass(val day: Int, val arriveByMin: Int, val endMin: Int?, val to: String, val label: String, val venue: String) {
    fun toJson(): JSONObject =
        JSONObject().put("day", day).put("arriveByMin", arriveByMin).put("to", to).put("label", label).put("venue", venue).apply {
            if (endMin != null) put("endMin", endMin)
        }

    companion object {
        fun parse(o: JSONObject) =
            TimetableClass(
                day = o.optInt("day"),
                arriveByMin = o.optInt("arriveByMin"),
                endMin = if (o.has("endMin")) o.optInt("endMin") else null,
                to = o.optString("to"),
                label = o.optString("label"),
                venue = o.optString("venue"),
            )
    }
}

fun placeKey(label: String, taken: List<String>): String {
    var key = label.lowercase().replace(Regex("[^a-z0-9]+"), "-").trim('-').take(24).ifEmpty { "place" }
    var n = 2
    val base = key.take(21)
    while (key in taken) key = "$base-${n++}"
    return key
}

private val DAY_NAMES =
    listOf(
        1 to R.string.monday,
        2 to R.string.tuesday,
        3 to R.string.wednesday,
        4 to R.string.thursday,
        5 to R.string.friday,
        6 to R.string.saturday,
        0 to R.string.sunday,
    )
private val DAY_SHORT =
    mapOf(
        1 to R.string.monday_short,
        2 to R.string.tuesday_short,
        3 to R.string.wednesday_short,
        4 to R.string.thursday_short,
        5 to R.string.friday_short,
        6 to R.string.saturday_short,
        0 to R.string.sunday_short,
    )

val WEEKDAYS: List<Pair<Int, String>>
    get() = DAY_NAMES.map { (d, id) -> d to L.s(id) }

fun dayName(day: Int) = DAY_NAMES.firstOrNull { it.first == day }?.second?.let { L.s(it) } ?: "?"

fun dayShort(day: Int) = DAY_SHORT[day]?.let { L.s(it) } ?: "?"

fun soonOnCampus(nowMs: Long = System.currentTimeMillis()): Int {
    val now = java.time.Instant.ofEpochMilli(nowMs).atZone(java.time.ZoneId.of("Asia/Singapore"))
    val m = now.hour * 60 + now.minute + 30
    return minOf(23 * 60 + 55, (m + 4) / 5 * 5)
}

fun hhmm(min: Int) = "%02d:%02d".format(java.util.Locale.ROOT, min / 60, min % 60)

fun hhmm12(min: Int): String {
    val h = min / 60
    val m = min % 60
    val h12 = if (h % 12 == 0) 12 else h % 12
    val time = if (m == 0) "$h12" else "$h12:%02d".format(java.util.Locale.ROOT, m)
    return L.s(if (h < 12) R.string.time_am else R.string.time_pm, time)
}

private fun JSONArray.strings(): List<String> = (0 until length()).map { getString(it) }

fun nusmodsLink(text: String?): String? = text?.let {
    Regex("""https?://(?:www\.)?nusmods\.com/timetable/\S+""").find(it)?.value?.trimEnd('.', ',', ')')
}
