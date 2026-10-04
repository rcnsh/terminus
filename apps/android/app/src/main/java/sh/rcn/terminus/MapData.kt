package sh.rcn.terminus

import org.json.JSONArray
import org.json.JSONObject
import kotlin.math.PI
import kotlin.math.asin
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * The Map tab's data: stops and routes from `/campus`, live buses from
 * `/buses`, and the GeoJSON the map draws from them. Plain JSON in and out,
 * so it's tested on the JVM (MapDataTest).
 */

/** A stop on the map, with the services that call there. */
data class MapStop(val code: String, val name: String, val lat: Double, val lon: Double, val services: List<String>)

/** A service: its colour (ARGB) and its path along the roads, as [lon, lat] pairs. */
data class MapRoute(val svc: String, val color: Long, val line: List<DoubleArray>) {
    /** [west, south, east, north] of the line. */
    fun bounds(): DoubleArray = doubleArrayOf(line.minOf { it[0] }, line.minOf { it[1] }, line.maxOf { it[0] }, line.maxOf { it[1] })

    /** The line measured for sliding buses along it. */
    val path: RoutePath by lazy { RoutePath(line) }
}

/**
 * A route line measured as the API measures it (haversine, metres from its
 * start at each point), so a bus's `along` is a place on it.
 */
class RoutePath(private val line: List<DoubleArray>) {
    private val cum = DoubleArray(line.size).also { c ->
        for (i in 1 until line.size) c[i] = c[i - 1] + haversine(line[i - 1][1], line[i - 1][0], line[i][1], line[i][0])
    }
    val total: Double = cum.lastOrNull() ?: 0.0

    /** Ends where it starts: a bus can slide on past the start. */
    val closed: Boolean = line.size >= 2 && haversine(line.first()[1], line.first()[0], line.last()[1], line.last()[0]) < 5

    /** The point [m] metres along, as (lat, lon, the road's bearing there). */
    fun pointAt(m: Double): Triple<Double, Double, Double> {
        val at = wrap(m)
        var lo = 0
        var hi = cum.size - 1
        while (hi - lo > 1) {
            val mid = (lo + hi) / 2
            if (cum[mid] <= at) lo = mid else hi = mid
        }
        val (aLon, aLat) = line[lo].let { it[0] to it[1] }
        val (bLon, bLat) = line[hi].let { it[0] to it[1] }
        val seg = cum[hi] - cum[lo]
        val t = if (seg > 0) (at - cum[lo]) / seg else 0.0
        return Triple(aLat + (bLat - aLat) * t, aLon + (bLon - aLon) * t, bearing(aLat, aLon, bLat, bLon))
    }

    /** The part of the line from [a] to [b] metres along it, as [lon, lat]
     *  points; null when that isn't a stretch of this line. */
    fun slice(a: Double, b: Double): List<DoubleArray>? {
        if (line.size < 2 || !(b > a) || a < 0 || b > total + 1) return null
        fun end(m: Double) = pointAt(min(m, total)).let { (lat, lon) -> doubleArrayOf(lon, lat) }
        return listOf(end(a)) + line.filterIndexed { i, _ -> cum[i] > a && cum[i] < b } + listOf(end(b))
    }

    /** [m] as a place on the line: round again on a loop, else held to its ends. */
    fun wrap(m: Double): Double = if (closed) ((m % total) + total) % total else m.coerceIn(0.0, total)

    /**
     * Metres on along the line from bus [f] to bus [b], round a loop past its
     * start; null when it isn't on ahead: the same place, behind, a long way,
     * or a line kept from before the route changed.
     */
    fun aheadBy(f: LiveBus, b: LiveBus): Double? {
        val fa = f.along ?: return null
        val ba = b.along ?: return null
        if (line.size < 2 || total <= 0 || fa > total + 1 || ba > total + 1) return null
        var d = ba - fa
        if (closed && d < -total / 2) d += total
        return if (d > 0 && d <= SLIDE_MAX_M) d else null
    }

    companion object {
        /** Further than this in one answer (back from the background), a bus jumps. */
        const val SLIDE_MAX_M = 1_500.0

        /** As apps/api/src/geo.ts. */
        fun haversine(aLat: Double, aLon: Double, bLat: Double, bLon: Double): Double {
            val r = PI / 180
            val s = sin((bLat - aLat) * r / 2).pow(2) + cos(aLat * r) * cos(bLat * r) * sin((bLon - aLon) * r / 2).pow(2)
            return 2 * 6_371_000 * asin(min(1.0, sqrt(s)))
        }

        fun bearing(aLat: Double, aLon: Double, bLat: Double, bLon: Double): Double {
            val r = PI / 180
            val y = sin((bLon - aLon) * r) * cos(bLat * r)
            val x = cos(aLat * r) * sin(bLat * r) - sin(aLat * r) * cos(bLat * r) * cos((bLon - aLon) * r)
            return ((atan2(y, x) / r) % 360 + 360) % 360
        }
    }
}

data class CampusMap(val stops: List<MapStop>, val routes: Map<String, MapRoute>) {
    /** The services in pill order: A1, A2, D1, … */
    val services: List<String> get() = routes.keys.sorted()

    fun stop(code: String) = stops.firstOrNull { it.code == code }

    /** Of the stops [codes], the one nearest ([lat], [lon]): a tap's slop can take in two stops a road apart. */
    fun nearest(codes: List<String>, lat: Double?, lon: Double?): String? {
        val known = codes.distinct().mapNotNull(::stop)
        if (lat == null || lon == null) return known.firstOrNull()?.code ?: codes.firstOrNull()
        val k = cos(lat * PI / 180)
        return known.minByOrNull { (it.lat - lat).pow(2) + ((it.lon - lon) * k).pow(2) }?.code ?: codes.firstOrNull()
    }

    /** [west, south, east, north] of the main campus (not P's trip to the Botanic Gardens). */
    fun coreBounds(core: Set<String>): DoubleArray {
        val pts = stops.filter { it.code in core }.ifEmpty { stops }
        return doubleArrayOf(pts.minOf { it.lon }, pts.minOf { it.lat }, pts.maxOf { it.lon }, pts.maxOf { it.lat })
    }

    companion object {
        /** The stops and routes from `/campus`; the core stops' codes come back alongside. */
        fun parse(o: JSONObject): Pair<CampusMap, Set<String>> {
            val s = o.getJSONArray("stops")
            val core = mutableSetOf<String>()
            val stops = (0 until s.length()).map { i ->
                val x = s.getJSONObject(i)
                if (x.optBoolean("core", true)) core += x.getString("code")
                MapStop(x.getString("code"), x.optString("name", x.getString("code")), x.getDouble("lat"), x.getDouble("lon"), x.optJSONArray("services").stringList())
            }
            val r = o.getJSONObject("routes")
            val routes = r.keys().asSequence().associateWith { svc ->
                val x = r.getJSONObject(svc)
                val line = x.optJSONArray("line") ?: JSONArray()
                MapRoute(svc, parseColor(x.optString("color")), (0 until line.length()).map { i -> line.getJSONArray(i).let { p -> doubleArrayOf(p.getDouble(0), p.getDouble(1)) } })
            }.filterValues { it.line.size >= 2 }
            return CampusMap(stops, routes) to core
        }
    }
}

/** "#e53935" -> 0xFFE53935; grey for anything else. */
fun parseColor(hex: String?): Long {
    val h = hex?.removePrefix("#")
    return if (h != null && h.length == 6 && h.all { it.isDigit() || it.lowercaseChar() in 'a'..'f' }) 0xFF000000L or h.toLong(16) else 0xFF8A939CL
}

/**
 * A bus on the map, as `/buses` gives it: an id stable while it runs, and its
 * number plate. It's at a stop ([at], drawn at the stop's dot) or between two
 * (drawn on its line); [ox] and [oy] are how far from that point it's drawn,
 * in dp at full size, turned with the road: beside the dot at a stop.
 */
data class LiveBus(
    val id: String,
    val lat: Double,
    val lon: Double,
    val heading: Double?,
    val moving: Boolean,
    val crowd: String?,
    val nextStop: String?,
    /** Metres along its route line of where it's drawn; null from an older API, off its line. */
    val along: Double? = null,
    /** Its number plate (PD726D); null from an older API. */
    val plate: String? = null,
    /** The stop it's at, or null between stops. */
    val at: String? = null,
    /** At a stop, its place among the buses there: 0 in front, then 1, 2 behind. */
    val slot: Int = 0,
    /** Between stops, the stretch of its line it's somewhere on; null at a stop or from an older API. */
    val stretch: Stretch? = null,
    val ox: Double = 0.0,
    val oy: Double = 0.0,
) {
    /** Drawn where it goes: at a stop, beside the dot to its left (the kerb:
     *  buses drive on the left), the ones behind it further back. */
    fun placed(): LiveBus = if (at != null) copy(ox = -AT_STOP_SIDE_DP, oy = AT_STOP_STEP_DP * slot) else copy(ox = 0.0, oy = 0.0)

    companion object {
        /** As the web map (apps/web/public/app/map.js). */
        const val AT_STOP_SIDE_DP = 22.0
        const val AT_STOP_STEP_DP = 26.0
    }
}

/** A stretch of a route line, [from] and [to] metres along it, starting at the stop named [last]. */
data class Stretch(val from: Double, val to: Double, val last: String)

/** One service's buses. [available] false: the feed couldn't be reached, which isn't "no buses". */
data class BusList(val svc: String, val available: Boolean, val buses: List<LiveBus>) {
    companion object {
        fun parse(o: JSONObject): BusList {
            val a = o.optJSONArray("buses") ?: JSONArray()
            return BusList(
                o.getString("svc"),
                o.optBoolean("available"),
                (0 until a.length()).map { i ->
                    val b = a.getJSONObject(i)
                    LiveBus(
                        id = b.getString("id"),
                        lat = b.getDouble("lat"),
                        lon = b.getDouble("lon"),
                        heading = if (b.isNull("heading")) null else b.optDouble("heading"),
                        moving = b.optBoolean("moving"),
                        crowd = b.optString("crowd").takeIf { !b.isNull("crowd") && it.isNotEmpty() },
                        nextStop = b.optJSONObject("nextStop")?.optString("name")?.ifEmpty { null },
                        along = b.number("along"),
                        plate = b.optString("plate").takeIf { !b.isNull("plate") && it.isNotEmpty() },
                        at = b.optJSONObject("at")?.optString("name")?.ifEmpty { null },
                        slot = b.optInt("slot", 0),
                        stretch = b.optJSONObject("stretch")?.let { st ->
                            val from = st.number("from")
                            val to = st.number("to")
                            val last = st.optJSONObject("last")?.optString("name")?.ifEmpty { null }
                            if (from != null && to != null && last != null) Stretch(from, to, last) else null
                        },
                    )
                },
            )
        }
    }
}

/** A stop's board from `/arrivals`. [available] false: no times from the feed. */
data class StopBoard(val available: Boolean, val rows: List<BoardRow>) {
    companion object {
        fun parse(o: JSONObject): StopBoard {
            val b = o.optJSONArray("board") ?: JSONArray()
            val rows = (0 until b.length()).map { i ->
                val r = b.getJSONObject(i)
                BoardRow(r.getString("svc"), if (r.isNull("etaS")) null else r.getInt("etaS"), r.optString("quality"))
            }
            return StopBoard(o.optBoolean("available"), rows.filter { it.etaS != null })
        }
    }
}

/** GeoJSON for the map's sources. */
object MapGeoJson {
    fun routes(campus: CampusMap): String = collection(
        campus.routes.values.map { r ->
            feature(
                JSONObject().put("type", "LineString").put("coordinates", JSONArray(r.line.map { JSONArray().put(it[0]).put(it[1]) })),
                JSONObject().put("svc", r.svc).put("color", hex(r.color)),
            )
        },
    )

    /** `services` as " A1 D2 ": spaces round each, so K never matches inside another code. */
    fun stops(campus: CampusMap): String = collection(
        campus.stops.map { s -> point(s.lon, s.lat, JSONObject().put("code", s.code).put("name", s.name).put("services", " ${s.services.joinToString(" ")} ")) },
    )

    fun buses(svc: String, color: Long, buses: List<LiveBus>): String = collection(
        buses.map { b ->
            point(b.lon, b.lat, JSONObject().put("id", b.id).put("svc", svc).put("color", hex(color)).put("heading", b.heading ?: 0.0).put("offset", JSONArray().put(b.ox).put(b.oy)))
        },
    )

    /** A tapped bus's [stretch] of [path], in the service's [color]; empty when there's none. */
    fun stretch(color: Long, path: RoutePath?, stretch: Stretch?): String {
        val line = stretch?.let { path?.slice(it.from, it.to) } ?: return EMPTY
        return collection(
            listOf(feature(JSONObject().put("type", "LineString").put("coordinates", JSONArray(line.map { JSONArray().put(it[0]).put(it[1]) })), JSONObject().put("color", hex(color)))),
        )
    }

    fun me(lat: Double, lon: Double): String = collection(listOf(point(lon, lat, JSONObject())))

    val EMPTY: String = collection(emptyList())

    private fun hex(argb: Long) = "#%06x".format(argb and 0xFFFFFF)

    private fun point(lon: Double, lat: Double, props: JSONObject) =
        feature(JSONObject().put("type", "Point").put("coordinates", JSONArray().put(lon).put(lat)), props)

    private fun feature(geometry: JSONObject, props: JSONObject) = JSONObject().put("type", "Feature").put("geometry", geometry).put("properties", props)

    private fun collection(features: List<JSONObject>) = JSONObject().put("type", "FeatureCollection").put("features", JSONArray(features)).toString()
}

/**
 * Each bus's slide from where it was drawn to its new place, along its route
 * line, so it follows the road round corners, easing in and out. It takes
 * [msFor] its distance: further, longer.
 * Its old and new places may be beside the line (a stop's dot, and beside
 * it), so it moves from one to the other as it goes. One that can't get there
 * along the line (behind it, a long way on, no line) jumps, and so does every
 * bus with [still] (animations off) or after a while without an answer.
 * Times are any one clock.
 */
class Slides(private val msFor: (Double) -> Long = { slideMs(it) }) {
    private class Slide(val from: LiveBus?, val to: LiveBus, val start: Long, val path: RoutePath?, val d: Double, val ms: Long = 0)

    private var slides: Map<String, Slide> = emptyMap()

    /** When the last answer came, to tell a stale map. */
    private var lastUpdate: Long? = null

    /** New places [buses], with [path] their route's line, at [now]. */
    fun update(buses: List<LiveBus>, path: RoutePath?, now: Long, still: Boolean = false) {
        // No answer for a while (the screen was off, the app in the
        // background): every bus jumps to where it is now.
        val stale = lastUpdate.let { it == null || now - it > STALE_MS }
        lastUpdate = now
        slides = buses.associate { raw ->
            val b = raw.placed()
            val from = slides[b.id]?.let { at(it, now) }
            val d = if (stale || still || from == null || path == null) null else path.aheadBy(from, b)
            b.id to if (d != null) Slide(from, b, now, path, d, msFor(d)) else Slide(null, b, now, null, 0.0)
        }
    }

    /** Each bus where it's drawn at [now]. */
    fun at(now: Long): List<LiveBus> = slides.values.map { at(it, now) }

    /** Whether any bus is still on its way at [now]. */
    fun moving(now: Long): Boolean = slides.values.any { it.from != null && now - it.start < it.ms }

    private fun at(s: Slide, now: Long): LiveBus {
        val f = s.from
        val path = s.path
        val b = s.to
        val fa = f?.along
        val ba = b.along
        if (f == null || path == null || fa == null || ba == null) return b
        val k = ((now - s.start).toDouble() / s.ms).coerceIn(0.0, 1.0)
        if (k >= 1.0) return b
        val e = if (k < 0.5) 2 * k * k else 1 - (-2 * k + 2).pow(2) / 2
        val (lat, lon, road) = path.pointAt(fa + s.d * e)
        val (aLat, aLon) = path.pointAt(fa)
        val (bLat, bLon) = path.pointAt(ba)
        return b.copy(
            lat = lat + (f.lat - aLat) * (1 - e) + (b.lat - bLat) * e,
            lon = lon + (f.lon - aLon) * (1 - e) + (b.lon - bLon) * e,
            along = path.wrap(fa + s.d * e),
            heading = road,
            ox = f.ox + (b.ox - f.ox) * e,
            oy = f.oy + (b.oy - f.oy) * e,
        )
    }

    companion object {
        /** How long a slide of [m] metres takes, as the web map: a steady
         *  150 m a second, so a longer stretch takes longer, from 0.8 s for a
         *  short hop to 4 s, done before the next answer (every 5 s). */
        fun slideMs(m: Double): Long = (m / 150 * 1_000).toLong().coerceIn(800L, 4_000L)

        /** No answer for longer than this: every bus jumps to where it is now. */
        const val STALE_MS = 15_000L
    }
}

private fun JSONObject.number(key: String): Double? = if (!has(key) || isNull(key)) null else optDouble(key)

private fun JSONArray?.stringList(): List<String> = if (this == null) emptyList() else (0 until length()).map { getString(it) }
