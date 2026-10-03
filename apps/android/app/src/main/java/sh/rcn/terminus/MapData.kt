package sh.rcn.terminus

import org.json.JSONArray
import org.json.JSONObject
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.asin
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.max
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

    /** The line measured for gliding buses along it. */
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

    /** Ends where it starts: a bus can glide on past the start. */
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

    /** [m] as a place on the line: round again on a loop, else held to its ends. */
    fun wrap(m: Double): Double = if (closed) ((m % total) + total) % total else m.coerceIn(0.0, total)

    /**
     * Metres to glide along from bus [f] to bus [b]; null when not along it:
     * off the line, a line kept from before the route changed, or a long way.
     */
    fun alongBy(f: LiveBus, b: LiveBus): Double? {
        val fa = f.along ?: return null
        val ba = b.along ?: return null
        if (line.size < 2 || total <= 0) return null
        for ((m, bus) in listOf(fa to f, ba to b)) {
            val (lat, lon) = pointAt(m)
            if (haversine(lat, lon, bus.lat, bus.lon) > 10) return null
        }
        var d = ba - fa
        // Round a loop the short way, past its start.
        if (closed) {
            if (d < -total / 2) d += total else if (d > total / 2) d -= total
        }
        return if (abs(d) > GLIDE_ALONG_MAX_M) null else d
    }

    companion object {
        /** Further than this in one update (back from the background), not along the line. */
        const val GLIDE_ALONG_MAX_M = 1_500.0

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

/** A bus on the map, as `/buses` gives it: an id stable while it runs, and its number plate. */
data class LiveBus(
    val id: String,
    val lat: Double,
    val lon: Double,
    val heading: Double?,
    val moving: Boolean,
    val crowd: String?,
    val nextStop: String?,
    /** Metres along its route line; null off it. */
    val along: Double? = null,
    /** Metres a second it's estimated to be moving along its line, up to [until]; null from an older API. */
    val speed: Double? = null,
    /** Metres along its line it isn't shown past before the next answer. */
    val until: Double? = null,
    /** Its number plate (PD726D); null from an older API. */
    val plate: String? = null,
) {
    /** Metres it may go on along its line before the next answer. */
    val onFor: Double get() = if (speed != null && speed > 0 && until != null && along != null) max(0.0, until - along) else 0.0
}

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
                        speed = b.number("speed"),
                        until = b.number("until"),
                        plate = b.optString("plate").takeIf { !b.isNull("plate") && it.isNotEmpty() },
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
            point(b.lon, b.lat, JSONObject().put("id", b.id).put("svc", svc).put("color", hex(color)).put("heading", b.heading ?: 0.0).put("moving", b.moving && b.heading != null))
        },
    )

    fun me(lat: Double, lon: Double): String = collection(listOf(point(lon, lat, JSONObject())))

    val EMPTY: String = collection(emptyList())

    private fun hex(argb: Long) = "#%06x".format(argb and 0xFFFFFF)

    private fun point(lon: Double, lat: Double, props: JSONObject) =
        feature(JSONObject().put("type", "Point").put("coordinates", JSONArray().put(lon).put(lat)), props)

    private fun feature(geometry: JSONObject, props: JSONObject) = JSONObject().put("type", "Feature").put("geometry", geometry).put("properties", props)

    private fun collection(features: List<JSONObject>) = JSONObject().put("type", "FeatureCollection").put("features", JSONArray(features)).toString()
}

/**
 * Each bus's glide from where it was drawn to where it is. The API says
 * where each bus is estimated to be now and how fast it's going ([LiveBus.speed]
 * up to [LiveBus.until]), so a bus keeps moving between answers, catching up
 * with each new one over [catchMs]; a little ahead of it (it went slower than
 * shown), it waits rather than reversing. One whose position hasn't changed
 * keeps going. Along its route line when both ends are on it, so it follows
 * the road round corners, and never straight between two places on it;
 * straight only onto or off its line, a short way. From an older API without
 * a speed, it glides to each position over [ms]. Times are any one clock.
 */
class Glides(private val ms: Long = GLIDE_MS, private val catchMs: Long = CATCH_MS) {
    private class Glide(val from: LiveBus?, val to: LiveBus, val start: Long, val path: RoutePath?, val d: Double?)

    private var glides: Map<String, Glide> = emptyMap()

    /** When the last answer came, to tell a stale map. */
    private var lastUpdate: Long? = null

    /** New positions [buses], with [path] their route's line, at [now]. */
    fun update(buses: List<LiveBus>, path: RoutePath?, now: Long) {
        // No answer for a while (the screen was off, the app in the
        // background): every bus jumps to where it is now, not races there.
        val stale = lastUpdate.let { it == null || now - it > STALE_MS }
        lastUpdate = now
        glides = buses.associate { b ->
            val g = glides[b.id]
            b.id to when {
                g != null && g.to.lat == b.lat && g.to.lon == b.lon -> Glide(g.from, b, g.start, g.path, g.d)
                stale -> Glide(null, b, now, if (b.along != null) path else null, null)
                else -> glideFrom(g?.let { at(it, now) }, b, path, now)
            }
        }
    }

    /** Each bus where it's drawn at [now]. */
    fun at(now: Long): List<LiveBus> = glides.values.map { at(it, now) }

    /** Whether any bus is still on its way at [now]. */
    fun moving(now: Long): Boolean = glides.values.any { g ->
        (g.from != null && now - g.start < span(g.to)) || (g.path != null && (g.to.speed ?: 0.0) * (now - g.start) / 1000.0 < g.to.onFor)
    }

    private fun span(b: LiveBus) = if (b.speed == null) ms else catchMs

    private fun glideFrom(from: LiveBus?, b: LiveBus, path: RoutePath?, now: Long): Glide {
        val jump = Glide(null, b, now, if (b.along != null) path else null, null)
        if (from == null) return jump
        val d = path?.alongBy(from, b)
        // Put back a little (GPS error), it waits where it's drawn; a long way
        // back, or further ahead than JUMP_AHEAD_M, it jumps rather than race there.
        if (d != null) return if (d < -HOLD_BACK_M || (d > JUMP_AHEAD_M && b.speed != null)) jump else Glide(from, b, now, path, d)
        // On its line at both ends but not along it (the other side of the road, a long way): it jumps, never cuts across.
        if (from.along != null && b.along != null) return jump
        if (RoutePath.haversine(from.lat, from.lon, b.lat, b.lon) > GLIDE_STRAIGHT_MAX_M) return jump
        return Glide(from, b, now, null, null)
    }

    private fun at(g: Glide, now: Long): LiveBus {
        val b = g.to
        // Metres the answer's bus has gone on since.
        val on = min(b.onFor, (b.speed ?: 0.0) * max(0L, now - g.start) / 1000.0)
        val f = g.from
        val path = g.path
        if (f == null) {
            val a = b.along
            return if (path != null && a != null && on > 0) along(path, b, a + on, true) else b
        }
        val k = ((now - g.start).toDouble() / span(b)).coerceIn(0.0, 1.0)
        val d = g.d
        val fa = f.along
        // Mid-glide straight, it's off the line: the next glide is straight too.
        if (path == null || d == null || fa == null) {
            return if (k >= 1.0) b else b.copy(lat = f.lat + (b.lat - f.lat) * k, lon = f.lon + (b.lon - f.lon) * k, along = null)
        }
        val target = d + on
        val m = if (d >= 0) target * k else max(0.0, target)
        return along(path, b, fa + m, m > 0)
    }

    /** [b] drawn [m] metres along [path]; pointing along the road when it's going [forward]. */
    private fun along(path: RoutePath, b: LiveBus, m: Double, forward: Boolean): LiveBus {
        val (lat, lon, road) = path.pointAt(m)
        return b.copy(lat = lat, lon = lon, along = path.wrap(m), heading = if (forward) road else b.heading)
    }

    companion object {
        /** From an older API without a speed: about as long as the feed holds a position. */
        const val GLIDE_MS = 15_000L

        /** Catching up with a new answer: about one answer. */
        const val CATCH_MS = 5_000L

        /** Off its line, further than this from where it's drawn, a bus jumps (not across buildings). */
        const val GLIDE_STRAIGHT_MAX_M = 250.0

        /** Put back along its line by less than this, a bus waits where it's drawn instead of reversing. */
        const val HOLD_BACK_M = 60.0

        /** Further ahead than this, a bus jumps to its new place: the map was a long way behind it. */
        const val JUMP_AHEAD_M = 100.0

        /** No answer for longer than this: every bus jumps to where it is now. */
        const val STALE_MS = 15_000L
    }
}

private fun JSONObject.number(key: String): Double? = if (!has(key) || isNull(key)) null else optDouble(key)

private fun JSONArray?.stringList(): List<String> = if (this == null) emptyList() else (0 until length()).map { getString(it) }
